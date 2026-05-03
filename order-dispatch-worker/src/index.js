const express = require("express");
const Redis = require("ioredis");

const QUEUE_KEY = "queue:order_dispatch";
const RETRY_QUEUE_KEY = "queue:order_dispatch:retry";
const DLQ_KEY = "queue:order_dispatch:dlq";
const DISPATCHED_CHANNEL = "order_dispatched";

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const DRIVER_SERVICE_URL =
  process.env.DRIVER_SERVICE_URL || "http://driver-service:8000";
const RESTAURANT_SERVICE_URL =
  process.env.RESTAURANT_SERVICE_URL || "http://restaurant-service:8000";
const MAX_RETRY_ATTEMPTS = parseInt(
  process.env.ORDER_DISPATCH_MAX_RETRY_ATTEMPTS || "4",
  10
);
const RETRY_BASE_DELAY_MS = parseInt(
  process.env.ORDER_DISPATCH_RETRY_BASE_DELAY_MS || "5000",
  10
);
const RETRY_MAX_DELAY_MS = parseInt(
  process.env.ORDER_DISPATCH_RETRY_MAX_DELAY_MS || "60000",
  10
);

const PORT = process.env.PORT || 8110;
const SERVICE_NAME = process.env.SERVICE_NAME || "order-dispatch-worker";
const startTime = Date.now();

// Redis connections
const worker = new Redis(REDIS_URL);
const queue = new Redis(REDIS_URL);

let lastJobAt = null;

// DLQ helper (standardized)
async function moveToDlq(record) {
  await queue.rpush(DLQ_KEY, JSON.stringify(record));
  console.error(
    `[order-dispatch-worker] moved job to DLQ order_id=${record.order_id ?? "n/a"} reason=${record.reason || record.error || "unknown"}`
  );
}

function computeRetryDelayMs(retryCount) {
  const delay = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount - 1);
  return Math.min(delay, RETRY_MAX_DELAY_MS);
}

function freshEnvelope(raw) {
  return {
    raw,
    retry_count: 0,
    first_seen_at: new Date().toISOString(),
  };
}

async function claimDueRetry() {
  const now = Date.now();
  const items = await queue.zrangebyscore(
    RETRY_QUEUE_KEY,
    0,
    now,
    "LIMIT",
    0,
    1
  );

  if (!items.length) return null;

  const raw = items[0];
  const removed = await queue.zrem(RETRY_QUEUE_KEY, raw);
  return removed ? raw : null;
}

async function parseRetryEnvelope(raw) {
  try {
    const envelope = JSON.parse(raw);
    if (
      !envelope ||
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      envelope.payload == null
    ) {
      throw new Error("retry envelope missing payload");
    }
    return envelope;
  } catch (err) {
    await moveToDlq({
      payload: raw,
      reason: "invalid_retry_envelope",
      error: err.message,
      retryable: false,
      at: new Date().toISOString(),
    });
    return null;
  }
}

async function scheduleRetryOrDlq({ envelope, payload, reason, error }) {
  const retryCount = envelope.retry_count || 0;
  const nextRetryCount = retryCount + 1;

  if (nextRetryCount > MAX_RETRY_ATTEMPTS) {
    await moveToDlq({
      payload,
      order_id: payload?.order_id,
      restaurant_id: payload?.restaurant_id,
      reason,
      error,
      retryable: true,
      retries_exhausted: true,
      retry_count: retryCount,
      max_retry_attempts: MAX_RETRY_ATTEMPTS,
      first_seen_at: envelope.first_seen_at,
      at: new Date().toISOString(),
    });
    return;
  }

  const delayMs = computeRetryDelayMs(nextRetryCount);
  const runAt = Date.now() + delayMs;
  const retryEnvelope = {
    payload,
    retry_count: nextRetryCount,
    first_seen_at: envelope.first_seen_at,
    last_error: error,
    reason,
    scheduled_at: new Date(runAt).toISOString(),
    last_attempt_at: new Date().toISOString(),
  };

  await queue.zadd(RETRY_QUEUE_KEY, runAt, JSON.stringify(retryEnvelope));
  console.warn(
    `[order-dispatch-worker] scheduled retry order_id=${payload?.order_id ?? "n/a"} reason=${reason} retry=${nextRetryCount}/${MAX_RETRY_ATTEMPTS} delay_ms=${delayMs}`
  );
}

// Restaurant validation
async function restaurantExists(restaurantId) {
  const url = `${RESTAURANT_SERVICE_URL}/restaurants/${encodeURIComponent(
    restaurantId
  )}`;
  const res = await fetch(url, { method: "GET" });

  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Restaurant service error: ${res.status}`);

  return true;
}

// Core processing logic (poison pill handling here)
async function processOne(envelope) {
  let parsed = envelope.payload;

  if (parsed == null) {
    try {
      parsed = JSON.parse(envelope.raw);
    } catch (e) {
      await moveToDlq({
        payload: envelope.raw,
        reason: "invalid_json",
        error: e.message,
        retryable: false,
        at: new Date().toISOString(),
      });
      return;
    }
  }

  const orderId = parsed.order_id;
  const restaurantId = parsed.restaurant_id;

  // missing fields
  if (orderId == null || restaurantId == null) {
    await moveToDlq({
      payload: parsed,
      reason: "missing_fields",
      retryable: false,
      at: new Date().toISOString(),
    });
    return;
  }

  console.log(`[order-dispatch-worker] processing job order_id=${orderId} restaurant_id=${restaurantId}`);

  let exists;
  try {
    exists = await restaurantExists(restaurantId);
  } catch (e) {
    await scheduleRetryOrDlq({
      envelope,
      payload: parsed,
      reason: "restaurant_service_error",
      error: e.message,
    });
    return;
  }

  // poison pill: restaurant doesn't exist
  if (!exists) {
    await moveToDlq({
      payload: parsed,
      order_id: orderId,
      restaurant_id: restaurantId,
      reason: "restaurant_not_found",
      retryable: false,
      at: new Date().toISOString(),
    });

    console.log(
      `[DISPATCH] poison pill: restaurant '${restaurantId}' not found for order ${orderId}`
    );
    return;
  }

  // driver assignment
  const res = await fetch(`${DRIVER_SERVICE_URL}/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: orderId }),
  });

  if (!res.ok) {
    const detail = await res.text();

    await scheduleRetryOrDlq({
      envelope,
      payload: parsed,
      reason: "driver_assign_failed",
      error: detail.slice(0, 500),
    });
    return;
  }

  // success path
  const driver = await res.json();

  console.log(
    `[DISPATCH] Assigned driver ${driver.id} to order ${orderId}`
  );

  await worker.publish(
    DISPATCHED_CHANNEL,
    JSON.stringify({
      order_id: orderId,
      driver_id: driver.id,
      restaurant_id: restaurantId,
    })
  );

  lastJobAt = new Date().toISOString();
}

// Worker loop
async function run() {
  console.log(
    `Order Dispatch Worker listening on ${QUEUE_KEY} (retry: ${RETRY_QUEUE_KEY}, DLQ: ${DLQ_KEY})`
  );

  while (true) {
    try {
      const retryRaw = await claimDueRetry();
      if (retryRaw) {
        const retryEnvelope = await parseRetryEnvelope(retryRaw);
        if (!retryEnvelope) continue;

        console.log(
          `[DISPATCH] Retrying order_id=${retryEnvelope.payload?.order_id ?? "n/a"} retry=${retryEnvelope.retry_count}/${MAX_RETRY_ATTEMPTS}`
        );

        try {
          await processOne(retryEnvelope);
        } catch (err) {
          console.error("[DISPATCH] unexpected retry error:", err.message);
          await scheduleRetryOrDlq({
            envelope: retryEnvelope,
            payload: retryEnvelope.payload,
            reason: "unexpected_processing_error",
            error: err.message,
          });
        }
        continue;
      }

      const result = await worker.blpop(QUEUE_KEY, 2);
      if (!result) continue;

      const [, raw] = result;
      const preview =
        raw.length > 120 ? `${raw.slice(0, 120)}...` : raw;

      console.log(`[DISPATCH] Consumed job: ${preview}`);

      try {
        await processOne(freshEnvelope(raw));
      } catch (err) {
        console.error("[DISPATCH] unexpected error:", err.message);

        let parsedRaw = raw;
        try {
          parsedRaw = JSON.parse(raw);
        } catch {}

        await scheduleRetryOrDlq({
          envelope: freshEnvelope(raw),
          payload: parsedRaw,
          reason: "unexpected_processing_error",
          error: err.message,
        });
      }
    } catch (err) {
      console.error("[order-dispatch-worker] loop error:", err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// Express health server
const app = express();

app.get("/health", async (_req, res) => {
  const checks = {};
  let healthy = true;

  try {
    await queue.ping();
    checks.redis = { status: "healthy" };
  } catch (err) {
    checks.redis = { status: "unhealthy", error: err.message };
    healthy = false;
  }

  const queueDepth = await queue.llen(QUEUE_KEY).catch(() => null);
  const retryQueueDepth = await queue.zcard(RETRY_QUEUE_KEY).catch(() => null);
  const dlqDepth = await queue.llen(DLQ_KEY).catch(() => null);

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "healthy" : "unhealthy",
    service: SERVICE_NAME,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    queue_depth: queueDepth,
    retry_queue_depth: retryQueueDepth,
    dlq_depth: dlqDepth,
    dead_letter_queue_depth: dlqDepth, //fixing naming
    last_job_at: lastJobAt,
    checks,
  });
});

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} /health listening on ${PORT}`);
});

//start worker
run();
