const express = require('express');
const { createClient } = require('redis');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8000;
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';
const startTime = Date.now();

console.log(`restaurant-service starting (CACHE_ENABLED=${CACHE_ENABLED})`);

app.use(express.json());

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('[restaurant-service] Redis error:', err));
redis.connect()
  .then(() => console.log('[restaurant-service] Redis connected'))
  .catch((err) => console.error('[restaurant-service] Redis connect failed:', err.message));

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
    service: process.env.SERVICE_NAME || 'restaurant-service',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    checks,
  });
});

app.get('/restaurants', async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM restaurants ORDER BY name');
    console.log(`[restaurant-service] listed restaurants count=${result.rows.length}`);
    res.json({ restaurants: result.rows });
  } catch (error) {
    console.error('[restaurant-service] failed to list restaurants:', error.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/restaurants/search', async (req, res) => {
  const { name } = req.query;
  if (!name) {
    return res.status(400).json({ error: 'name query parameter is required' });
  }
  try {
    const result = await db.query('SELECT * FROM restaurants WHERE name ILIKE $1', [`%${name}%`]);
    console.log(`[restaurant-service] search name="${name}" count=${result.rows.length}`);
    res.json({ restaurants: result.rows });
  } catch (err) {
    console.error(`[restaurant-service] search failed name="${name}":`, err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/restaurants/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM restaurants WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'restaurant not found', id: req.params.id });
    }
    console.log(`[restaurant-service] fetched restaurant restaurant_id=${req.params.id}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[restaurant-service] restaurant fetch failed restaurant_id=${req.params.id}:`, err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/restaurants/:id/menu', async (req, res) => {
  try {
    const restaurantId = req.params.id;

    if (CACHE_ENABLED) {
      try {
        const cached = await redis.get(`menu:${restaurantId}`);
        if (cached) {
          console.log(`[restaurant-service] menu cache hit restaurant_id=${restaurantId}`);
          return res.json(JSON.parse(cached));
        }
        console.log(`[restaurant-service] menu cache miss restaurant_id=${restaurantId}`);
      } catch (err) {
        console.error(`[restaurant-service] menu cache read error restaurant_id=${restaurantId}:`, err.message);
      }
    }

    const restaurant = await db.query('SELECT * FROM restaurants WHERE id = $1', [restaurantId]);
    if (restaurant.rows.length === 0) {
      return res.status(404).json({ error: 'restaurant not found', id: restaurantId });
    }

    const items = await db.query('SELECT * FROM menu_items WHERE restaurant_id = $1', [restaurantId]);

    let surgeMultiplier = 1.0;
    try {
      const surgeVal = await redis.get(`surge:restaurant:${restaurantId}`);
      if (surgeVal) surgeMultiplier = parseFloat(surgeVal);
    } catch (err) {
      console.error('Redis surge read error:', err.message);
    }

    const body = { restaurant_id: restaurantId, items: items.rows, surge_multiplier: surgeMultiplier };

    if (CACHE_ENABLED) {
      redis.set(`menu:${restaurantId}`, JSON.stringify(body), { EX: 300 }).then(() => {
        console.log(`[restaurant-service] menu cache write restaurant_id=${restaurantId}`);
      }).catch((err) => {
        console.error(`[restaurant-service] menu cache write error restaurant_id=${restaurantId}:`, err.message);
      });
    }

    console.log(`[restaurant-service] menu fetched restaurant_id=${restaurantId} item_count=${items.rows.length}`);
    res.json(body);
  } catch (err) {
    console.error(`[restaurant-service] menu lookup failed restaurant_id=${req.params.id}:`, err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`restaurant-service listening on port ${PORT}`);
});
