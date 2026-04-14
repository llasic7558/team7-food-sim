/**
 * Order service: persists orders in Postgres, validates each order against
 * restaurant-service over HTTP (Sprint 1 sync path). Shared Redis is checked on /health.
 */

const express = require('express');
const { createClient } = require('redis');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8000;
// Base URL for sync calls (Compose sets RESTAURANT_SERVICE_URL)
const RESTAURANT_BASE =
  process.env.RESTAURANT_SERVICE_URL || 'http://restaurant-service:8000';

app.use(express.json());

// Shared Redis (health only in Sprint 1; orders live in Postgres)
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('Redis error:', err));
redis.connect();

// --- Response shaping (README uses string ids and 2-decimal money) ---

/** Normalize numeric columns from Postgres/strings to "12.00" style strings. */
function money(v) {
  const n = typeof v === 'string' ? parseFloat(v, 10) : Number(v);
  return Number.isNaN(n) ? '0.00' : n.toFixed(2);
}

/** One API order object: header row plus line items from order_items rows. */
function toJsonOrder(row, itemRows) {
  return {
    id: String(row.id),
    restaurant_id: String(row.restaurant_id),
    customer_name: row.customer_name,
    status: row.status,
    total: money(row.total),
    created_at: new Date(row.created_at).toISOString(),
    items: itemRows.map((r) => ({
      menu_item_id: String(r.menu_item_id),
      name: r.name,
      price: money(r.price),
      quantity: r.quantity,
    })),
  };
}

/** Load order by primary key; joins line items in a second query. */
async function orderWithItems(orderId) {
  const o = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (o.rows.length === 0) return null;
  const items = await db.query(
    'SELECT menu_item_id, name, price, quantity FROM order_items WHERE order_id = $1 ORDER BY id',
    [orderId],
  );
  return toJsonOrder(o.rows[0], items.rows);
}

/** Lookup for Idempotency-Key replays (same key must return the same order). */
async function orderByIdempotencyKey(key) {
  const o = await db.query('SELECT id FROM orders WHERE idempotency_key = $1', [key]);
  if (o.rows.length === 0) return null;
  return orderWithItems(o.rows[0].id);
}

/**
 * Sprint 1 synchronous validation: fetch menu from restaurant-service.
 * 404 on menu ⇒ unknown restaurant; each line item must exist and be available.
 * Returns computed total and line snapshots for insert.
 */
async function resolveLines(restaurantId, lineItems) {
  let menuRes;
  try {
    menuRes = await fetch(`${RESTAURANT_BASE}/restaurants/${restaurantId}/menu`);
  } catch {
    const e = new Error('unavailable');
    e.kind = 'UNAVAILABLE';
    throw e;
  }
  if (menuRes.status === 404) {
    const e = new Error('not found');
    e.kind = 'NOT_FOUND';
    throw e;
  }
  if (!menuRes.ok) {
    const e = new Error('unavailable');
    e.kind = 'UNAVAILABLE';
    throw e;
  }

  const { items = [] } = await menuRes.json();
  const byId = new Map(items.map((it) => [String(it.id), it]));

  let total = 0;
  const resolved = [];
  // Resolve each requested line against the menu; snap name/price onto the order
  for (const line of lineItems) {
    const menuItem = byId.get(String(line.menu_item_id));
    if (!menuItem || menuItem.available === false) {
      const e = new Error('bad item');
      e.kind = 'BAD_ITEM';
      e.menu_item_id = line.menu_item_id;
      throw e;
    }
    const qty = line.quantity != null ? Number(line.quantity) : 1;
    const price =
      typeof menuItem.price === 'string'
        ? parseFloat(menuItem.price, 10)
        : Number(menuItem.price);
    total += price * qty;
    resolved.push({
      menu_item_id: menuItem.id,
      name: menuItem.name,
      price: menuItem.price,
      quantity: qty,
    });
  }
  return { total, resolved };
}

// --- Routes ---

// 200 if Postgres + Redis reachable; 503 otherwise (Compose healthcheck uses this)
app.get('/health', async (_req, res) => {
  const checks = {};
  let ok = true;
  try {
    await db.query('SELECT 1');
    checks.database = { status: 'healthy' };
  } catch (err) {
    checks.database = { status: 'unhealthy', error: err.message };
    ok = false;
  }
  try {
    await redis.ping();
    checks.redis = { status: 'healthy' };
  } catch (err) {
    checks.redis = { status: 'unhealthy', error: err.message };
    ok = false;
  }
  res.status(ok ? 200 : 503).json({
    status: ok ? 'healthy' : 'unhealthy',
    service: process.env.SERVICE_NAME || 'order-service',
    checks,
  });
});

/**
 * POST /orders — validate body, optional idempotent replay (200), else call
 * restaurant-service, then insert order + line items in one transaction (201).
 */
app.post('/orders', async (req, res) => {
  const idem = req.get('Idempotency-Key') || req.get('idempotency-key');
  if (idem) {
    const existing = await orderByIdempotencyKey(idem);
    if (existing) return res.status(200).json(existing);
  }

  // Request body validation (fail fast before any HTTP or DB work)
  const { restaurant_id, customer_name, items } = req.body || {};
  if (restaurant_id == null || restaurant_id === '') {
    return res.status(400).json({ error: 'restaurant_id is required' });
  }
  const rid = Number(restaurant_id);
  if (!Number.isFinite(rid)) {
    return res.status(400).json({ error: 'restaurant_id must be a valid number' });
  }
  if (typeof customer_name !== 'string' || !customer_name.trim()) {
    return res.status(400).json({ error: 'customer_name is required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }
  for (const line of items) {
    if (line.menu_item_id == null) {
      return res.status(400).json({ error: 'each item requires menu_item_id' });
    }
    const q = line.quantity != null ? Number(line.quantity) : 1;
    if (!Number.isInteger(q) || q < 1) {
      return res.status(400).json({ error: 'quantity must be a positive integer' });
    }
  }

  let validated;
  try {
    validated = await resolveLines(rid, items); // sync call to restaurant-service
  } catch (err) {
    if (err.kind === 'NOT_FOUND') {
      return res.status(404).json({ error: 'restaurant not found', restaurant_id: rid });
    }
    if (err.kind === 'UNAVAILABLE') {
      return res.status(503).json({ error: 'restaurant service unavailable' });
    }
    if (err.kind === 'BAD_ITEM') {
      return res
        .status(400)
        .json({ error: 'invalid menu item', menu_item_id: err.menu_item_id });
    }
    console.error(err);
    return res.status(500).json({ error: 'internal server error' });
  }

  // Persist order + items atomically (same connection for BEGIN/COMMIT)
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO orders (restaurant_id, customer_name, status, total, idempotency_key)
       VALUES ($1, $2, 'pending', $3, $4) RETURNING *`,
      [rid, customer_name.trim(), validated.total, idem || null],
    );
    const orderRow = ins.rows[0];
    const itemRows = [];
    for (const line of validated.resolved) {
      // Line snapshots denormalize menu name/price at order time
      const ir = await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, name, price, quantity)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING menu_item_id, name, price, quantity`,
        [orderRow.id, line.menu_item_id, line.name, line.price, line.quantity],
      );
      itemRows.push(ir.rows[0]);
    }
    await client.query('COMMIT');
    return res.status(201).json(toJsonOrder(orderRow, itemRows));
  } catch (err) {
    try {
      await client.query('ROLLBACK'); // no effectt if already rolled back
    } catch (_) {}
    console.error(err);
    return res.status(500).json({ error: 'internal server error' });
  } finally {
    client.release();
  }
});

/** GET /orders — list wrapper; N+1 queries acceptable for Sprint 1 volume. */
app.get('/orders', async (_req, res) => {
  try {
    const orders = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
    const out = [];
    for (const row of orders.rows) {
      out.push(await orderWithItems(row.id));
    }
    res.json({ orders: out });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

/** GET /orders/:id — single order by id (string or numeric path param). */
app.get('/orders/:id', async (req, res) => {
  try {
    const order = await orderWithItems(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'order not found', id: req.params.id });
    }
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// Bind PORT from env (Compose uses 8000); aligns with Dockerfile EXPOSE and healthcheck URL.
app.listen(PORT, () => {
  console.log(`order-service listening on port ${PORT}`);
});
