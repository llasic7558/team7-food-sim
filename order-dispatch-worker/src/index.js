const express = require("express");
const Redis = require("ioredis");

const QUEUE_KEY = "queue:order_dispatch";
const DLQ_KEY = "queue:order_dispatch:dlq";
const DISPATCHED_CHANNEL = "order_dispatched";

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const DRIVER_SERVICE_URL =
  process.env.DRIVER_SERVICE_URL || "http://driver-service:8000";
const RESTAURANT_SERVICE_URL =
  process.env.RESTAURANT_SERVICE_URL || "http://restaurant-service:8000";

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
async function processOne(raw) {
  let parsed;

  // invalid JSON
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    await moveToDlq({
      payload: raw,
      reason: "invalid_json",
      error: e.message,
      retryable: false,
      at: new Date().toISOString(),
    });
    return;
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
    await moveToDlq({
      payload: parsed,
      reason: "restaurant_service_error",
      error: e.message,
      retryable: true,
      at: new Date().toISOString(),
    });
    return;
  }

  // poison pill: restaurant doesn't exist
  if (!exists) {
    await moveToDlq({
      payload: parsed,
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

    await moveToDlq({
      payload: parsed,
      reason: "driver_assign_failed",
      error: detail.slice(0, 500),
      retryable: true,
      at: new Date().toISOString(),
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
    `Order Dispatch Worker listening on ${QUEUE_KEY} (DLQ: ${DLQ_KEY})`
  );

  while (true) {
    try {
      const result = await worker.blpop(QUEUE_KEY, 5);
      if (!result) continue;

      const [, raw] = result;
      const preview =
        raw.length > 120 ? `${raw.slice(0, 120)}...` : raw;

      console.log(`[DISPATCH] Consumed job: ${preview}`);

      try {
        await processOne(raw);
      } catch (err) {
        console.error("[DISPATCH] unexpected error:", err.message);

        await moveToDlq({
          payload: raw,
          reason: "unexpected_processing_error",
          error: err.message,
          retryable: true,
          at: new Date().toISOString(),
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
  const dlqDepth = await queue.llen(DLQ_KEY).catch(() => null);

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "healthy" : "unhealthy",
    service: SERVICE_NAME,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    queue_depth: queueDepth,
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