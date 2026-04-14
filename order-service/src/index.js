const express = require('express');
const { createClient } = require('redis');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8000;
const startTime = Date.now();

app.use(express.json());

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('Redis error:', err));
redis.connect();

const RESTAURANT_SERVICE_URL = process.env.RESTAURANT_SERVICE_URL || 'http://restaurant-service:8000';
const ORDER_DISPATCH_QUEUE = 'queue:order_dispatch';
const NOTIFICATION_QUEUE = 'queue:notifications';

// --- helpers ---

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
    resp = await fetch(`${RESTAURANT_SERVICE_URL}/restaurants/${restaurantId}/menu`);
  } catch (err) {
    console.error('Restaurant Service unreachable:', err.message);
    return { ok: false, error: 'Restaurant service unavailable', total: 0 };
  }

  if (resp.status === 404) {
    return { ok: false, error: `Restaurant '${restaurantId}' not found`, total: 0 };
  }
  if (!resp.ok) {
    return { ok: false, error: 'Failed to retrieve menu', total: 0 };
  }

  const body = await resp.json();
  const menu = {};
  for (const item of body.items || []) {
    const key = menuRowKey(item);
    if (key) menu[key] = item;
  }

  let total = 0;
  for (const line of items) {
    const key = lineItemKey(line);
    if (key == null) {
      return { ok: false, error: 'Each line item must include item_id (or menu_item_id / id)', total: 0 };
    }
    const qty = line.quantity || 1;
    if (!(key in menu)) {
      return { ok: false, error: `Item '${key}' not on menu`, total: 0 };
    }
    const price = parseFloat(menu[key].price);
    if (isNaN(price)) {
      return { ok: false, error: 'Invalid menu item price from restaurant service', total: 0 };
    }
    total += price * qty;
  }

  const surgeMultiplier = body.surge_multiplier ?? 1.0;
  total *= surgeMultiplier;

  return { ok: true, error: '', total: Math.round(total * 100) / 100 };
}

function pushNotification(event, order) {
  const payload = JSON.stringify({ event, order_id: order.id, status: order.status });
  redis.lPush(NOTIFICATION_QUEUE, payload).catch((err) =>
    console.error('Failed to push notification:', err.message)
  );
}

function formatOrder(row) {
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    customer_id: row.customer_id,
    restaurant_id: row.restaurant_id,
    items: row.items,
    total_price: parseFloat(row.total_price),
    status: row.status,
    driver_id: row.driver_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// --- routes ---

// Health check
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

// List orders
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
    res.json(result.rows.map(formatOrder));
  } catch (err) {
    console.error('Error listing orders:', err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

// Create order
app.post('/orders', async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'X-Idempotency-Key header is required' });
  }

  // Check for existing order with this idempotency key
  try {
    const existing = await db.query('SELECT * FROM orders WHERE idempotency_key = $1', [idempotencyKey]);
    if (existing.rows.length > 0) {
      console.log(`Duplicate order request for key ${idempotencyKey} — returning original`);
      return res.json(formatOrder(existing.rows[0]));
    }
  } catch (err) {
    console.error('Error checking idempotency:', err.message);
    return res.status(500).json({ error: 'internal server error' });
  }

  const { customer_id, restaurant_id, items } = req.body || {};

  const missing = [];
  if (!customer_id) missing.push('customer_id');
  if (!restaurant_id) missing.push('restaurant_id');
  if (!items) missing.push('items');
  if (missing.length) {
    return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "'items' must be a non-empty list" });
  }

  const validation = await validateItemsWithRestaurant(restaurant_id, items);
  if (!validation.ok) {
    return res.status(422).json({ error: validation.error });
  }

  let order;
  try {
    const result = await db.query(
      `INSERT INTO orders (idempotency_key, customer_id, restaurant_id, items, total_price, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [idempotencyKey, customer_id, restaurant_id, JSON.stringify(items), validation.total]
    );
    order = result.rows[0];
  } catch (err) {
    // Race condition: another request with the same idempotency key inserted first
    if (err.code === '23505') {
      const existing = await db.query('SELECT * FROM orders WHERE idempotency_key = $1', [idempotencyKey]);
      return res.json(formatOrder(existing.rows[0]));
    }
    console.error('Error creating order:', err.message);
    return res.status(500).json({ error: 'internal server error' });
  }

  console.log(`Order ${order.id} created (customer=${customer_id}, restaurant=${restaurant_id}, total=$${validation.total})`);

  await redis.rPush(ORDER_DISPATCH_QUEUE, JSON.stringify({ order_id: order.id, restaurant_id }));
  pushNotification('order_confirmed', order);

  res.status(201).json(formatOrder(order));
});

// Get single order
app.get('/orders/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'order not found', id: req.params.id });
    }
    res.json(formatOrder(result.rows[0]));
  } catch (err) {
    console.error('Error getting order:', err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

// Update order status (worker endpoint)
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
    console.log(`Order ${req.params.id} → ${status}`);
    pushNotification(`order_${status}`, order);
    res.json(formatOrder(order));
  } catch (err) {
    console.error('Error updating order status:', err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

// Verify order completed (for rating service)
app.get('/orders/:id/verify-completed', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'order not found', id: req.params.id });
    }
    const order = result.rows[0];
    res.json({ order_id: order.id, completed: order.status === 'delivered' });
  } catch (err) {
    console.error('Error verifying order:', err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`order-service listening on port ${PORT}`);
});
