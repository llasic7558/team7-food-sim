const express = require('express');
const { createClient } = require('redis');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8000;
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'America/New_York';
const RATING_SERVICE_URL = process.env.RATING_SERVICE_URL || 'http://rating-and-review-service:8000';
const RATING_SERVICE_TIMEOUT_MS = parseInt(process.env.RATING_SERVICE_TIMEOUT_MS || '1500', 10);
const startTime = Date.now();

console.log(`restaurant-service starting (CACHE_ENABLED=${CACHE_ENABLED})`);

app.use(express.json());

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('[restaurant-service] Redis error:', err));
const ratingSubscriber = redis.duplicate();
ratingSubscriber.on('error', (err) => console.error('[restaurant-service] rating subscriber error:', err));
redis.connect()
  .then(() => console.log('[restaurant-service] Redis connected'))
  .then(async () => {
    await ratingSubscriber.connect();
    await ratingSubscriber.subscribe('rating_submitted', async (message) => {
      let event;
      try {
        event = JSON.parse(message);
      } catch (err) {
        console.error('[restaurant-service] invalid rating_submitted event:', err.message);
        return;
      }

      const restaurantId = event.restaurant_id;
      if (restaurantId == null) {
        console.error('[restaurant-service] rating_submitted missing restaurant_id');
        return;
      }

      try {
        await redis.del(`menu:${restaurantId}`);
        console.log(`[restaurant-service] menu cache invalidated from rating_submitted restaurant_id=${restaurantId}`);
      } catch (err) {
        console.error(`[restaurant-service] menu cache invalidation failed restaurant_id=${restaurantId}:`, err.message);
      }
    });
    console.log('[restaurant-service] subscribed to rating_submitted');
  })
  .catch((err) => console.error('[restaurant-service] Redis connect failed:', err.message));

function getBusinessClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));

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
  return windows.some((window) =>
    window.day_of_week === clock.dayOfWeek &&
    clock.time >= window.opens_at &&
    clock.time < window.closes_at
  );
}

async function fetchAvailabilityWindowsForRestaurants(restaurantIds) {
  if (!restaurantIds.length) return new Map();

  const result = await db.query(
    `SELECT restaurant_id, day_of_week, opens_at::text, closes_at::text
     FROM availability_windows
     WHERE restaurant_id = ANY($1::int[])
     ORDER BY restaurant_id, day_of_week, opens_at`,
    [restaurantIds]
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

function unavailableRatingSummary(restaurantId, error) {
  return {
    restaurant_id: Number(restaurantId),
    average_score: null,
    total_ratings: null,
    source: 'rating-and-review-service',
    available: false,
    error,
  };
}

async function fetchRestaurantRatingSummary(restaurantId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RATING_SERVICE_TIMEOUT_MS);

  try {
    const res = await fetch(
      `${RATING_SERVICE_URL}/ratings/restaurant/${encodeURIComponent(restaurantId)}`,
      { signal: controller.signal }
    );

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const body = await res.json();
    return {
      restaurant_id: Number(body.restaurant_id ?? restaurantId),
      average_score: Number(body.average_score ?? 0),
      total_ratings: Number(body.total_ratings ?? 0),
      source: 'rating-and-review-service',
      available: true,
    };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    console.error(`[restaurant-service] rating lookup failed restaurant_id=${restaurantId}:`, reason);
    return unavailableRatingSummary(restaurantId, reason);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRatingSummariesForRestaurants(restaurantIds) {
  const entries = await Promise.all(
    restaurantIds.map(async (id) => [id, await fetchRestaurantRatingSummary(id)])
  );
  return new Map(entries);
}

function decorateRestaurant(row, windows = [], ratingSummary = unavailableRatingSummary(row.id, 'not_loaded')) {
  const { rating: _restaurantDbRating, ...restaurant } = row;
  const averageRating = ratingSummary.available ? ratingSummary.average_score : null;

  return {
    ...restaurant,
    rating: averageRating,
    average_rating: averageRating,
    total_ratings: ratingSummary.total_ratings,
    rating_source: ratingSummary.source,
    rating_available: ratingSummary.available,
    availability_windows: windows,
    is_open_now: isRestaurantOpenNow(windows),
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
    service: process.env.SERVICE_NAME || 'restaurant-service',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    checks,
  });
});

app.get('/restaurants', async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM restaurants ORDER BY name');
    const restaurantIds = result.rows.map((row) => row.id);
    const windowsByRestaurant = await fetchAvailabilityWindowsForRestaurants(
      restaurantIds
    );
    const ratingsByRestaurant = await fetchRatingSummariesForRestaurants(restaurantIds);
    console.log(`[restaurant-service] listed restaurants count=${result.rows.length}`);
    res.json({
      restaurants: result.rows.map((row) =>
        decorateRestaurant(
          row,
          windowsByRestaurant.get(row.id) || [],
          ratingsByRestaurant.get(row.id)
        )
      ),
    });
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
    const restaurantIds = result.rows.map((row) => row.id);
    const windowsByRestaurant = await fetchAvailabilityWindowsForRestaurants(
      restaurantIds
    );
    const ratingsByRestaurant = await fetchRatingSummariesForRestaurants(restaurantIds);
    console.log(`[restaurant-service] search name="${name}" count=${result.rows.length}`);
    res.json({
      restaurants: result.rows.map((row) =>
        decorateRestaurant(
          row,
          windowsByRestaurant.get(row.id) || [],
          ratingsByRestaurant.get(row.id)
        )
      ),
    });
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
    const windowsByRestaurant = await fetchAvailabilityWindowsForRestaurants([Number(req.params.id)]);
    const ratingSummary = await fetchRestaurantRatingSummary(req.params.id);
    console.log(`[restaurant-service] fetched restaurant restaurant_id=${req.params.id}`);
    res.json(
      decorateRestaurant(
        result.rows[0],
        windowsByRestaurant.get(Number(req.params.id)) || [],
        ratingSummary
      )
    );
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

    const windowsByRestaurant = await fetchAvailabilityWindowsForRestaurants([Number(restaurantId)]);
    const availabilityWindows = windowsByRestaurant.get(Number(restaurantId)) || [];
    const restaurantOpen = isRestaurantOpenNow(availabilityWindows);
    const items = await db.query('SELECT * FROM menu_items WHERE restaurant_id = $1', [restaurantId]);
    const ratingSummary = await fetchRestaurantRatingSummary(restaurantId);

    let surgeMultiplier = 1.0;
    try {
      const surgeVal = await redis.get(`surge:restaurant:${restaurantId}`);
      if (surgeVal) surgeMultiplier = parseFloat(surgeVal);
    } catch (err) {
      console.error('Redis surge read error:', err.message);
    }

    const body = {
      restaurant_id: restaurantId,
      restaurant_open: restaurantOpen,
      availability_windows: availabilityWindows,
      rating: ratingSummary.available ? ratingSummary.average_score : null,
      average_rating: ratingSummary.available ? ratingSummary.average_score : null,
      total_ratings: ratingSummary.total_ratings,
      rating_source: ratingSummary.source,
      rating_available: ratingSummary.available,
      items: items.rows.map((item) => ({
        ...item,
        available_now: item.available && restaurantOpen,
      })),
      surge_multiplier: surgeMultiplier,
    };

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
