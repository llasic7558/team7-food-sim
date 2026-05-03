const express = require('express');
const { createClient } = require('redis');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8000;
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'America/New_York';
const startTime = Date.now();
const INSTANCE_ID = process.env.HOSTNAME || `instance-${Math.random()}`;

console.log(`[restaurant-service][${INSTANCE_ID}] starting (CACHE_ENABLED=${CACHE_ENABLED})`);

app.use(express.json());

const redis = createClient({
  url: process.env.REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 50, 500),
  },
});

redis.on('error', (err) =>
  console.error(`[restaurant-service][${INSTANCE_ID}] Redis error:`, err)
);

async function connectRedis() {
  try {
    await redis.connect();
    console.log(`[restaurant-service][${INSTANCE_ID}] Redis connected`);
  } catch (err) {
    console.error(`[restaurant-service][${INSTANCE_ID}] Redis connect failed:`, err.message);
  }
}

async function shutdown() {
  console.log(`[restaurant-service][${INSTANCE_ID}] shutting down...`);
  try {
    await redis.quit();
  } catch (err) {
    console.error('Error closing Redis:', err.message);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function getBusinessClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));

  return {
    dayOfWeek: weekdayMap[lookup.weekday],
    time: `${lookup.hour}:${lookup.minute}`,
  };
}

function normalizeWindow(row) {
  return {
    day_of_week: row.day_of_week,
    opens_at: row.opens_at?.slice(0, 5) ?? row.opens_at,
    closes_at: row.closes_at?.slice(0, 5) ?? row.closes_at,
  };
}

function isRestaurantOpenNow(windows) {
  if (!windows || windows.length === 0) return true;

  const clock = getBusinessClock();
  return windows.some(
    (w) =>
      w.day_of_week === clock.dayOfWeek &&
      clock.time >= w.opens_at &&
      clock.time < w.closes_at
  );
}

async function fetchAvailabilityWindowsForRestaurants(ids) {
  if (!ids.length) return new Map();

  const result = await db.query(
    `SELECT restaurant_id, day_of_week, opens_at::text, closes_at::text
     FROM availability_windows
     WHERE restaurant_id = ANY($1::int[])
     ORDER BY restaurant_id, day_of_week, opens_at`,
    [ids]
  );

  const grouped = new Map();
  for (const row of result.rows) {
    const normalized = normalizeWindow(row);
    const list = grouped.get(row.restaurant_id) || [];
    list.push(normalized);
    grouped.set(row.restaurant_id, list);
  }

  return grouped;
}

function decorateRestaurant(row, windows = []) {
  return {
    ...row,
    availability_windows: windows,
    is_open_now: isRestaurantOpenNow(windows),
  };
}


app.get('/health', async (_req, res) => {
  const checks = {};
  let healthy = true;

  try {
    await db.query('SELECT 1');
    checks.database = { status: 'healthy' };
  } catch (err) {
    checks.database = { status: 'unhealthy', error: err.message };
    healthy = false;
  }

  try {
    await redis.ping();
    checks.redis = { status: 'healthy' };
  } catch (err) {
    checks.redis = { status: 'unhealthy', error: err.message };
    healthy = false;
  }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    instance: INSTANCE_ID,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    checks,
  });
});

app.get('/restaurants', async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM restaurants ORDER BY name');

    const windowsByRestaurant = await fetchAvailabilityWindowsForRestaurants(
      result.rows.map((r) => r.id)
    );

    res.json({
      restaurants: result.rows.map((r) =>
        decorateRestaurant(r, windowsByRestaurant.get(r.id) || [])
      ),
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/restaurants/:id/menu', async (req, res) => {
  const restaurantId = req.params.id;

  try {

    if (CACHE_ENABLED) {
      const cached = await redis.get(`menu:${restaurantId}`);
      if (cached) {
        console.log(`[${INSTANCE_ID}] cache HIT restaurant=${restaurantId}`);
        return res.json(JSON.parse(cached));
      }

      console.log(`[${INSTANCE_ID}] cache MISS restaurant=${restaurantId}`);


      const lockKey = `lock:menu:${restaurantId}`;
      const lock = await redis.set(lockKey, '1', { NX: true, EX: 5 });

      if (!lock) {
        await new Promise((r) => setTimeout(r, 100));
        const retry = await redis.get(`menu:${restaurantId}`);
        if (retry) return res.json(JSON.parse(retry));
      }
    }

    const restaurant = await db.query(
      'SELECT * FROM restaurants WHERE id = $1',
      [restaurantId]
    );

    if (restaurant.rows.length === 0) {
      return res.status(404).json({ error: 'restaurant not found' });
    }

    const windowsMap = await fetchAvailabilityWindowsForRestaurants([
      Number(restaurantId),
    ]);

    const windows = windowsMap.get(Number(restaurantId)) || [];
    const open = isRestaurantOpenNow(windows);

    const items = await db.query(
      'SELECT * FROM menu_items WHERE restaurant_id = $1',
      [restaurantId]
    );

    let surgeMultiplier = 1.0;
    const surgeVal = await redis.get(`surge:restaurant:${restaurantId}`);
    if (surgeVal) surgeMultiplier = parseFloat(surgeVal);

    const body = {
      restaurant_id: restaurantId,
      restaurant_open: open,
      availability_windows: windows,
      items: items.rows.map((i) => ({
        ...i,
        available_now: i.available && open,
      })),
      surge_multiplier: surgeMultiplier,
    };

    if (CACHE_ENABLED) {
      await redis.set(`menu:${restaurantId}`, JSON.stringify(body), {
        EX: 300,
      });
    }

    res.json(body);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

async function start() {
  await connectRedis();

  let ready = false;
  while (!ready) {
    try {
      await db.query('SELECT 1');
      await redis.ping();
      ready = true;
    } catch {
      console.log(`[${INSTANCE_ID}] waiting for dependencies...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  app.listen(PORT, () => {
    console.log(`[restaurant-service][${INSTANCE_ID}] listening on ${PORT}`);
  });
}

start();