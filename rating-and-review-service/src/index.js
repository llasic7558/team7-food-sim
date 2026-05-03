const express = require('express');
const { createClient } = require('redis');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8000;
const startTime = Date.now();
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:8000';
const CACHE_TTL = 60;
const RATING_SUBMITTED_CHANNEL = 'rating_submitted';

app.use(express.json());

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('[rating-service] Redis error:', err));
redis.connect()
  .then(() => console.log('[rating-service] Redis connected'))
  .catch((err) => console.error('[rating-service] Redis connect failed:', err.message));

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
    service: process.env.SERVICE_NAME || 'rating-and-review-service',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    checks,
  });
});

app.post('/ratings', async (req, res) => {
  const { order_id, restaurant_id, customer_id, score, review_text } = req.body || {};

  const missing = [];
  if (order_id == null) missing.push('order_id');
  if (restaurant_id == null) missing.push('restaurant_id');
  if (!customer_id) missing.push('customer_id');
  if (score == null) missing.push('score');
  if (missing.length) {
    return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
  }

  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return res.status(400).json({ error: 'score must be an integer between 1 and 5' });
  }

  try {
    console.log(`[rating-service] verifying delivered order order_id=${order_id}`);
    const resp = await fetch(`${ORDER_SERVICE_URL}/orders/${order_id}/verify-completed`);
    if (resp.status === 404) {
      return res.status(404).json({ error: 'order not found', order_id });
    }
    if (!resp.ok) {
      console.error(`[rating-service] order verify failed order_id=${order_id} status=${resp.status}`);
      return res.status(503).json({ error: 'order service unavailable' });
    }
    const body = await resp.json();
    if (!body.completed) {
      console.log(`[rating-service] order not delivered order_id=${order_id}`);
      return res.status(400).json({ error: 'order has not been delivered yet', order_id });
    }
  } catch (err) {
    console.error(`[rating-service] order service unreachable order_id=${order_id}:`, err.message);
    return res.status(503).json({ error: 'order service unavailable' });
  }

  try {
    const result = await db.query(
      `INSERT INTO ratings (order_id, restaurant_id, customer_id, score, review_text)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [order_id, restaurant_id, customer_id, score, review_text || null]
    );

    const rating = result.rows[0];
    console.log(`[rating-service] rating created order_id=${order_id} restaurant_id=${restaurant_id} score=${score}`);

    await redis.del(`ratings:restaurant:${restaurant_id}`).catch(() => {});
    await redis.del('rankings').catch(() => {});
    console.log(`[rating-service] caches cleared restaurant_id=${restaurant_id}`);

    try {
      await redis.publish(
        RATING_SUBMITTED_CHANNEL,
        JSON.stringify({
          rating_id: rating.id,
          order_id,
          restaurant_id,
          score,
          submitted_at: rating.created_at,
        })
      );
      console.log(`[rating-service] published rating_submitted restaurant_id=${restaurant_id} rating_id=${rating.id}`);
    } catch (err) {
      console.error(`[rating-service] failed to publish rating_submitted restaurant_id=${restaurant_id}:`, err.message);
    }

    res.status(201).json(rating);
  } catch (err) {
    if (err.code === '23505') {
      const existing = await db.query('SELECT * FROM ratings WHERE order_id = $1', [order_id]);
      console.log(`[rating-service] duplicate rating order_id=${order_id}`);
      return res.status(409).json({
        error: 'rating already exists for this order',
        rating: existing.rows[0],
      });
    }
    console.error('[rating-service] error creating rating:', err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/ratings/restaurant/:id', async (req, res) => {
  const restaurantId = req.params.id;
  const cacheKey = `ratings:restaurant:${restaurantId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(`[rating-service] cache hit cache=${cacheKey}`);
      return res.json(JSON.parse(cached));
    }
    console.log(`[rating-service] cache miss cache=${cacheKey}`);
  } catch (err) {
    console.error(`[rating-service] cache read error cache=${cacheKey}:`, err.message);
  }

  try {
    const ratingsResult = await db.query(
      'SELECT * FROM ratings WHERE restaurant_id = $1 ORDER BY created_at DESC',
      [restaurantId]
    );

    const avgResult = await db.query(
      'SELECT COUNT(*)::int AS count, COALESCE(AVG(score), 0) AS average FROM ratings WHERE restaurant_id = $1',
      [restaurantId]
    );

    const body = {
      restaurant_id: parseInt(restaurantId),
      average_score: parseFloat(parseFloat(avgResult.rows[0].average).toFixed(2)),
      total_ratings: avgResult.rows[0].count,
      ratings: ratingsResult.rows,
    };

    try {
      await redis.setEx(cacheKey, CACHE_TTL, JSON.stringify(body));
      console.log(`[rating-service] cache write cache=${cacheKey}`);
    } catch (err) {
      console.error(`[rating-service] cache write error cache=${cacheKey}:`, err.message);
    }

    console.log(`[rating-service] fetched restaurant ratings restaurant_id=${restaurantId}`);
    res.json(body);
  } catch (err) {
    console.error(`[rating-service] error fetching ratings restaurant_id=${restaurantId}:`, err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/rankings', async (_req, res) => {
  const cacheKey = 'rankings';

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log('[rating-service] rankings cache hit');
      return res.json(JSON.parse(cached));
    }
    console.log('[rating-service] rankings cache miss');
  } catch (err) {
    console.error('[rating-service] rankings cache read error:', err.message);
  }

  try {
    const result = await db.query(
      `SELECT restaurant_id,
              COUNT(*)::int AS total_ratings,
              ROUND(AVG(score), 2) AS average_score
       FROM ratings
       GROUP BY restaurant_id
       ORDER BY average_score DESC, total_ratings DESC`
    );

    const body = { rankings: result.rows };

    try {
      await redis.setEx(cacheKey, CACHE_TTL, JSON.stringify(body));
      console.log('[rating-service] rankings cache write');
    } catch (err) {
      console.error('[rating-service] rankings cache write error:', err.message);
    }

    console.log(`[rating-service] fetched rankings count=${result.rows.length}`);
    res.json(body);
  } catch (err) {
    console.error('[rating-service] error fetching rankings:', err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`rating-and-review-service listening on port ${PORT}`);
});
