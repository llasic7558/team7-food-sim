const express = require('express');
const { createClient } = require('redis');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8000;
const startTime = Date.now();

app.use(express.json());

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('[order-service] Redis error:', err));
redis.connect()
  .then(() => console.log('[order-service] Redis connected'))
  .catch((err) => console.error('[order-service] Redis connect failed:', err.message));

const RESTAURANT_SERVICE_URL = process.env.RESTAURANT_SERVICE_URL || 'http://restaurant-service:8000';
const ORDER_DISPATCH_QUEUE = 'queue:order_dispatch';
const SURGE_PRICING_QUEUE = 'queue:surge_pricing';
const NOTIFICATION_QUEUE = 'queue:notifications';

const IDEMPOTENCY_TTL_SEC = 86400;
const IDEMPOTENCY_PENDING = '<pending>';
const IDEMPOTENCY_POLL_INTERVAL_MS = 50;
const IDEMPOTENCY_POLL_TIMEOUT_MS = 3000;

function idempotencyRedisKey(key) {
  return `idem:${key}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitIdempotencyResolution(redisKey) {
  const deadline = Date.now() + IDEMPOTENCY_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await redis.get(redisKey);
    if (value === null) return null;
    if (value !== IDEMPOTENCY_PENDING) return JSON.parse(value);
    await sleep(IDEMPOTENCY_POLL_INTERVAL_MS);
  }
  return null;
}

function menuRowKey(row) {
  const raw = row.item_id ?? row.id;
  return raw != null ? String(raw) : null;
}

function lineItemKey(line) {
  const raw = line.item_id ?? line.menu_item_id ?? line.id;
  return raw != null ? String(raw) : null;
}

async function validateItemsWithRestaurant(restaurantId, items) {
  let resp;
  try {
    console.log(`[order-service] validating menu restaurant_id=${restaurantId} item_count=${items.length}`);
    resp = await fetch(`${RESTAURANT_SERVICE_URL}/restaurants/${restaurantId}/menu`);
  } catch (err) {
    console.error(`[order-service] restaurant service unreachable restaurant_id=${restaurantId}:`, err.message);
    return { ok: false, error: 'Restaurant service unavailable', total: 0 };
  }

  if (resp.status === 404) {
    console.log(`[order-service] restaurant not found restaurant_id=${restaurantId}`);
    return { ok: false, error: `Restaurant '${restaurantId}' not found`, total: 0 };
  }
  if (!resp.ok) {
    console.error(`[order-service] restaurant menu fetch failed restaurant_id=${restaurantId} status=${resp.status}`);
    return { ok: false, error: 'Failed to retrieve menu', total: 0 };
  }

  const body = await resp.json();
  const menu = {};
  for (const item of body.items || []) {
    const key = menuRowKey(item);
    if (key) menu[key] = item;
  }

  if (body.restaurant_open === false) {
    return { ok: false, error: `Restaurant '${restaurantId}' is currently closed`, total: 0, baseTotal: 0, surgeMultiplier: 1 };
  }

  let baseTotal = 0;
  for (const line of items) {
    const key = lineItemKey(line);
    if (key == null) {
      return { ok: false, error: 'Each line item must include item_id (or menu_item_id / id)', total: 0 };
    }
    const qty = line.quantity || 1;
    if (!(key in menu)) {
      console.log(`[order-service] menu item missing restaurant_id=${restaurantId} item_id=${key}`);
      return { ok: false, error: `Item '${key}' not on menu`, total: 0 };
    }
    if (menu[key].available === false || menu[key].available_now === false) {
      return { ok: false, error: `Item '${key}' is not currently available`, total: 0, baseTotal: 0, surgeMultiplier: 1 };
    }
    const price = parseFloat(menu[key].price);
    if (isNaN(price)) {
      return { ok: false, error: 'Invalid menu item price from restaurant service', total: 0, baseTotal: 0, surgeMultiplier: 1 };
    }
    baseTotal += price * qty;
  }

  const surgeMultiplier = body.surge_multiplier ?? 1.0;
  let total = baseTotal * surgeMultiplier;
  total = Math.round(total * 100) / 100;
  baseTotal = Math.round(baseTotal * 100) / 100;

  console.log(`[order-service] menu validation complete restaurant_id=${restaurantId} total=${total}`);
  return { ok: true, error: '', total, baseTotal, surgeMultiplier };
}

function pushNotification(event, order, extra = {}) {
  const payload = JSON.stringify({
    event,
    order_id: order.id,
    status: order.status,
    ...extra,
  });

  redis.lPush(NOTIFICATION_QUEUE, payload)
    .then(() => {
      console.log(
        `[order-service] notification queued queue=${NOTIFICATION_QUEUE} order_id=${order.id} event=${event}`
      );
    })
    .catch((err) => {
      console.error(`[order-service] failed to push notification order_id=${order.id}:`, err.message);
    });
}

function formatOrder(row) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    restaurant_id: row.restaurant_id,
    items: row.items,
    base_total_price: parseFloat(row.base_total_price ?? row.total_price),
    total_price: parseFloat(row.total_price),
    payment_status: row.payment_status,
    payment_reference: row.payment_reference,
    status: row.status,
    driver_id: row.driver_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

app.get('/health', async (_req, res) => {
  const checks = {};
  let healthy = true;

  const dbStart = Date.now();
  try {
    await db.query('SELECT 1');
    checks.database = { status: 'healthy', latency_ms: Date.now() - dbStart };
  } catch (err) {
    checks.database = { status: 'unhealthy', error: err.message };
    healthy = false;
  }

  const redisStart = Date.now();
  try {
    await redis.ping();
    checks.redis = { status: 'healthy', latency_ms: Date.now() - redisStart };
  } catch (err) {
    checks.redis = { status: 'unhealthy', error: err.message };
    healthy = false;
  }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    service: process.env.SERVICE_NAME || 'order-service',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    checks,
  });
});

app.get('/orders', async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (req.query.customer_id) {
      conditions.push(`customer_id = $${idx++}`);
      params.push(req.query.customer_id);
    }
    if (req.query.status) {
      conditions.push(`status = $${idx++}`);
      params.push(req.query.status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await db.query(`SELECT * FROM orders ${where} ORDER BY created_at DESC`, params);
    console.log(
      `[order-service] listed orders count=${result.rows.length} customer_id=${req.query.customer_id ?? 'all'} status=${req.query.status ?? 'all'}`
    );
    res.json(result.rows.map(formatOrder));
  } catch (err) {
    console.error('[order-service] error listing orders:', err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/orders', async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'X-Idempotency-Key header is required' });
  }

  const redisKey = idempotencyRedisKey(idempotencyKey);
  let reserved;
  try {
    reserved = await redis.set(redisKey, IDEMPOTENCY_PENDING, {
      NX: true,
      EX: IDEMPOTENCY_TTL_SEC,
    });
  } catch (err) {
    console.error('[order-service] Redis SETNX failed:', err.message);
    return res.status(500).json({ error: 'internal server error' });
  }

  if (!reserved) {
    const resolved = await awaitIdempotencyResolution(redisKey);
    if (!resolved) {
      console.log(`[order-service] idempotent request still pending key=${idempotencyKey}`);
      return res.status(503).json({ error: 'idempotent request in flight, please retry' });
    }
    console.log(`[order-service] duplicate order request key=${idempotencyKey} order_id=${resolved.id}`);
    return res.status(201).json(resolved);
  }

  try {
    const { customer_id, restaurant_id, items } = req.body || {};

    const missing = [];
    if (!customer_id) missing.push('customer_id');
    if (!restaurant_id) missing.push('restaurant_id');
    if (!items) missing.push('items');
    if (missing.length) {
      await redis.del(redisKey);
      console.log(`[order-service] missing fields fields=${missing.join(',')}`);
      return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
    }

    if (!Array.isArray(items) || items.length === 0) {
      await redis.del(redisKey);
      console.log('[order-service] invalid items payload');
      return res.status(400).json({ error: "'items' must be a non-empty list" });
    }

    const validation = await validateItemsWithRestaurant(restaurant_id, items);
    if (!validation.ok) {
      await redis.del(redisKey);
      console.log(`[order-service] validation failed reason="${validation.error}"`);
      return res.status(422).json({ error: validation.error });
    }

    const result = await db.query(
      `INSERT INTO orders (customer_id, restaurant_id, items, base_total_price, total_price, payment_status, payment_reference, status)
       VALUES ($1, $2, $3, $4, $5, 'authorized', $6, 'pending')
       RETURNING *`,
      [
        customer_id,
        restaurant_id,
        JSON.stringify(items),
        validation.baseTotal,
        validation.total,
        `auth-${idempotencyKey}`,
      ]
    );
    const order = result.rows[0];
    const response = formatOrder(order);

    console.log(`Order ${order.id} created (customer=${customer_id}, restaurant=${restaurant_id}, total=$${validation.total})`);
    pushNotification('order_confirmed', order, { status: 'confirmed' });
    await redis.rPush(ORDER_DISPATCH_QUEUE, JSON.stringify({ order_id: order.id, restaurant_id }));
    await redis.rPush(SURGE_PRICING_QUEUE, JSON.stringify({ order_id: order.id, restaurant_id: Number(restaurant_id) }));

    await redis.set(redisKey, JSON.stringify(response), { EX: IDEMPOTENCY_TTL_SEC });
    console.log(`[order-service] idempotency result cached key=${idempotencyKey}`);

    return res.status(201).json(response);
  } catch (err) {
    await redis.del(redisKey).catch(() => {});
    console.error('[order-service] error creating order:', err.message);
    return res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/orders/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'order not found', id: req.params.id });
    }

    console.log(`[order-service] fetched order order_id=${req.params.id}`);
    res.json(formatOrder(result.rows[0]));
  } catch (err) {
    console.error(`[order-service] error getting order order_id=${req.params.id}:`, err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.put('/orders/:id/status', async (req, res) => {
  const { status, driver_id } = req.body || {};

  const validStatuses = new Set(['confirmed', 'dispatched', 'ready', 'in_transit', 'delivered', 'failed']);
  if (!validStatuses.has(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${[...validStatuses].join(', ')}` });
  }

  try {
    let result;
    if (driver_id !== undefined) {
      result = await db.query(
        `UPDATE orders SET status = $1, driver_id = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
        [status, driver_id, req.params.id]
      );
    } else {
      result = await db.query(
        `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [status, req.params.id]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'order not found', id: req.params.id });
    }

    const order = result.rows[0];
    console.log(
      `[order-service] order status updated order_id=${req.params.id} status=${status} driver_id=${driver_id ?? order.driver_id ?? 'none'}`
    );
    pushNotification(`order_${status}`, order);
    res.json(formatOrder(order));
  } catch (err) {
    console.error(`[order-service] error updating order status order_id=${req.params.id}:`, err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/orders/:id/verify-completed', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'order not found', id: req.params.id });
    }
    const order = result.rows[0];
    console.log(`[order-service] verify completed order_id=${req.params.id} completed=${order.status === 'delivered'}`);
    res.json({ order_id: order.id, completed: order.status === 'delivered' });
  } catch (err) {
    console.error(`[order-service] error verifying order order_id=${req.params.id}:`, err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`order-service listening on port ${PORT}`);
});
