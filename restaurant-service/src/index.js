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

// Health check
app.get('/health', async (_req, res) => {
  const checks = {};
  let healthy = true;

  // Check database
  const dbStart = Date.now();
  try {
    await db.query('SELECT 1');
    checks.database = { status: 'healthy', latency_ms: Date.now() - dbStart };
  } catch (err) {
    checks.database = { status: 'unhealthy', error: err.message };
    healthy = false;
  }

  // Check Redis
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
    const result = await db.query("SELECT * FROM restaurants ORDER BY name")
    res.json({restaurants: result.rows})
  } catch (error) {
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/restaurants/search', async (req, res) => {
  const { name } = req.query;
  if (!name) {
    return res.status(400).json({ error: 'name query parameter is required' });
  }
  try {
    // non case senstiive loop up 
    const result = await db.query('SELECT * FROM restaurants WHERE name ILIKE $1', [`%${name}%`]);
    res.json({ restaurants: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/restaurants/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM restaurants WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'restaurant not found', id: req.params.id });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'internal server error' });
  }
});

// Get menu for a restaurant
app.get('/restaurants/:id/menu', async (req, res) => {
  try {
    const restaurant = await db.query('SELECT * FROM restaurants WHERE id = $1', [req.params.id]);
    if (restaurant.rows.length === 0) {
      return res.status(404).json({ error: 'restaurant not found', id: req.params.id });
    }
    const items = await db.query('SELECT * FROM menu_items WHERE restaurant_id = $1', [req.params.id]);
    res.json({ restaurant_id: req.params.id, items: items.rows });
  } catch (err) {
    res.status(500).json({ error: 'internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`restaurant-service listening on port ${PORT}`);
});
