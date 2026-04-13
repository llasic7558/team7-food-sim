import { createClient } from 'redis'

const express = require('express');
const pool = require('./db');

// adding redis
const redis = createClient({ url: process.env.REDIS_URL});
await redis.connect();

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());

app.get('/health', async (_req, res) => {
  //store checking
  const checks = {};
  let healthy = true;

  res.json({ status: 'ok' });

  //check Redis
  const redisStart = Date.now();
  try {
    const pong = await redis.ping();
    if (pong !== 'PONG') throw new Error(`unexpected response: ${pong}`)
    checks.redis = { status: 'healthy', latency_ms: Date.now() - redisStart };
  } catch (err) {
    checks.redis = { status: 'unhealthy', error: err.message };
    healthy = false;
  }

  const body = {
    status: healthy ? 'healthy' : 'unhealthy',
    service: process.env.SERVICE_NAME ?? 'unknown',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    checks,
  }

  res.status(healthy ? 200 : 503).json(body);

});

app.get('/menu', (_req, res) => {
  res.json({
    message: 'Menu endpoint (stub)',
    data: [
      { id: 1, name: 'Pizza', price: 12.99 },
      { id: 2, name: 'Burger', price: 9.99 },
    ],
  });
});

// test synchronous call to other service, wait until other service is added
app.get('/test-service', async (_req, res) => {
  try {
    const response = await fetch('http://localhost:9000/health'); // replace with real service
    const data = await response.json();

    res.json({
      message: 'Successfully reached other service',
      data,
    });
  } catch (err) {
    res.status(500).json({
      message: 'Failed to reach other service',
      error: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`restaurant-service listening on port ${PORT}`);
});
