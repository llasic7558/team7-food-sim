const express = require('express');
const Redis = require('ioredis');
const db = require('./db');

const QUEUE_KEY = 'queue:surge_pricing';
const DLQ_KEY = 'queue:surge_pricing:dlq';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:8000';
const PORT = process.env.PORT || 8200;
const SERVICE_NAME = process.env.SERVICE_NAME || 'surge-pricing-worker';

// Surge configuration
const SURGE_WINDOW_SECONDS = parseInt(process.env.SURGE_WINDOW_SECONDS || '300', 10); // 5 min
const SURGE_THRESHOLD = parseInt(process.env.SURGE_THRESHOLD || '5', 10);
const SURGE_MULTIPLIER = parseFloat(process.env.SURGE_MULTIPLIER || '1.5');
const SURGE_DURATION_SECONDS = parseInt(process.env.SURGE_DURATION_SECONDS || '600', 10); // 10 min
const SURGE_ORDER_DEDUPE_TTL_SECONDS = parseInt(
  process.env.SURGE_ORDER_DEDUPE_TTL_SECONDS || '86400',
  10
);

const startTime = Date.now();

// Separate Redis connections: worker blocks on BLPOP; queue client serves /health and other reads
const worker = new Redis(REDIS_URL);
const queue = new Redis(REDIS_URL);

let lastJobAt = null;

// ---------------------------------------------------------------------------
// Poison pill handling — move bad messages to the dead letter queue
// ---------------------------------------------------------------------------

async function moveToDlq(record) {
  await queue.rpush(DLQ_KEY, JSON.stringify(record));
  console.log(
    `[SURGE] moved job to DLQ (${record.reason || 'unknown'}): restaurant_id=${record.restaurant_id ?? 'n/a'}`
  );
}

function dedupeKeyForOrder(orderId) {
  return `surge:seen_order:${orderId}`;
}

async function reserveOrderEvent(orderId) {
  const reserved = await queue.set(
    dedupeKeyForOrder(orderId),
    '1',
    'EX',
    SURGE_ORDER_DEDUPE_TTL_SECONDS,
    'NX'
  );

  return reserved === 'OK';
}

async function fetchOrderPricing(orderId) {
  const res = await fetch(`${ORDER_SERVICE_URL}/orders/${orderId}`);
  if (!res.ok) {
    throw new Error(`Order service error: ${res.status}`);
  }
  return res.json();
}

async function logSurgedOrderPrice(orderId, multiplier) {
  try {
    const order = await fetchOrderPricing(orderId);
    const baseTotal = Number(order.base_total_price ?? order.total_price);
    const surgedTotal = Math.round(baseTotal * multiplier * 100) / 100;
    console.log(
      `[SURGE] order_id=${orderId} base_total=$${baseTotal.toFixed(2)} surged_total=$${surgedTotal.toFixed(2)} multiplier=${multiplier}`
    );
  } catch (err) {
    console.error(`[SURGE] failed to log surged price order_id=${orderId}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Surge detection — track order rate per restaurant using a Redis sorted set
// ---------------------------------------------------------------------------

async function checkAndActivateSurge(restaurantId) {
  const windowKey = `surge:window:${restaurantId}`;
  const now = Date.now();
  const windowStart = now - SURGE_WINDOW_SECONDS * 1000;

  // Remove expired entries outside the window
  await queue.zremrangebyscore(windowKey, 0, windowStart);

  // Add current order timestamp
  await queue.zadd(windowKey, now, `${now}`);
  await queue.expire(windowKey, SURGE_WINDOW_SECONDS);

  // Count orders in the window
  const count = await queue.zcard(windowKey);
  console.log(`[SURGE] restaurant ${restaurantId}: ${count} orders in last ${SURGE_WINDOW_SECONDS}s (threshold: ${SURGE_THRESHOLD})`);

  if (count >= SURGE_THRESHOLD) {
    const surgeKey = `surge:restaurant:${restaurantId}`;
    const existing = await queue.get(surgeKey);

    if (existing) {
      console.log(`[SURGE] restaurant ${restaurantId}: surge already active (multiplier=${existing})`);
      return parseFloat(existing);
    }

    // Activate surge — write to Redis and pricing DB
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + SURGE_DURATION_SECONDS * 1000);

    await queue.set(surgeKey, SURGE_MULTIPLIER.toString(), 'EX', SURGE_DURATION_SECONDS);
    console.log(`[SURGE] ACTIVATED for restaurant ${restaurantId}: multiplier=${SURGE_MULTIPLIER}, expires in ${SURGE_DURATION_SECONDS}s`);

    // Write surge period to pricing database
    try {
      await db.query(
        `INSERT INTO surge_periods (restaurant_id, multiplier, started_at, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (restaurant_id, started_at) DO NOTHING`,
        [restaurantId, SURGE_MULTIPLIER, startedAt.toISOString(), expiresAt.toISOString()]
      );
    } catch (err) {
      console.error(`[SURGE] DB write error for restaurant ${restaurantId}:`, err.message);
    }

    // Publish surge event for other services
    await queue.publish('surge_active', JSON.stringify({
      restaurant_id: restaurantId,
      multiplier: SURGE_MULTIPLIER,
      started_at: startedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    }));

    return SURGE_MULTIPLIER;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Process a single queue message
// ---------------------------------------------------------------------------

async function processOne(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    await moveToDlq({
      raw,
      error: e.message,
      reason: 'invalid_json',
      at: new Date().toISOString(),
    });
    return;
  }

  const restaurantId = parsed.restaurant_id;
  const orderId = parsed.order_id;

  if (restaurantId == null || orderId == null) {
    await moveToDlq({
      payload: parsed,
      reason: 'missing_restaurant_id_or_order_id',
      at: new Date().toISOString(),
    });
    return;
  }

  if (typeof restaurantId !== 'number' || isNaN(restaurantId)) {
    await moveToDlq({
      payload: parsed,
      restaurant_id: restaurantId,
      reason: 'invalid_restaurant_id',
      at: new Date().toISOString(),
    });
    return;
  }

  const isNewOrderEvent = await reserveOrderEvent(orderId);
  if (!isNewOrderEvent) {
    console.log(`[SURGE] duplicate order event ignored order_id=${orderId} restaurant_id=${restaurantId}`);
    lastJobAt = new Date().toISOString();
    return;
  }

  const activeMultiplier = await checkAndActivateSurge(restaurantId);
  if (activeMultiplier) {
    await logSurgedOrderPrice(orderId, activeMultiplier);
  }
  lastJobAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Worker loop — consume from queue via BLPOP
// ---------------------------------------------------------------------------

async function run() {
  console.log(`${SERVICE_NAME} listening on ${QUEUE_KEY} (DLQ: ${DLQ_KEY})`);
  console.log(`  window=${SURGE_WINDOW_SECONDS}s  threshold=${SURGE_THRESHOLD}  multiplier=${SURGE_MULTIPLIER}  duration=${SURGE_DURATION_SECONDS}s`);

  while (true) {
    try {
      const result = await worker.blpop(QUEUE_KEY, 5);
      if (!result) continue;

      const [, raw] = result;
      const preview = raw.length > 120 ? `${raw.slice(0, 120)}...` : raw;
      console.log(`[SURGE] Consumed job: ${preview}`);

      try {
        await processOne(raw);
      } catch (err) {
        console.error('[SURGE] unexpected error:', err.message);
        await moveToDlq({
          raw,
          reason: 'unexpected_processing_error',
          error: err.message,
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error('[SURGE] loop error:', err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

const app = express();

app.get('/health', async (_req, res) => {
  const checks = {};
  let healthy = true;

  try {
    await queue.ping();
    checks.redis = { status: 'healthy' };
  } catch (err) {
    checks.redis = { status: 'unhealthy', error: err.message };
    healthy = false;
  }

  const dbStart = Date.now();
  try {
    await db.query('SELECT 1');
    checks.database = { status: 'healthy', latency_ms: Date.now() - dbStart };
  } catch (err) {
    checks.database = { status: 'unhealthy', error: err.message };
    healthy = false;
  }

  const queueDepth = await queue.llen(QUEUE_KEY).catch(() => null);
  const dlqDepth = await queue.llen(DLQ_KEY).catch(() => null);

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    queue_depth: queueDepth,
    dlq_depth: dlqDepth,
    last_job_at: lastJobAt,
    checks,
  });
});

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} /health listening on ${PORT}`);
});

run();
