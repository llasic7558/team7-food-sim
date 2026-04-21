const express = require("express");
const Redis = require("ioredis");

const QUEUE_KEY = "queue:order_dispatch";
const DLQ_KEY = "queue:order_dispatch:dlq";
const DISPATCHED_CHANNEL = "order_dispatched";
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const DRIVER_SERVICE_URL = process.env.DRIVER_SERVICE_URL || "http://driver-service:8000";
const RESTAURANT_SERVICE_URL =
  process.env.RESTAURANT_SERVICE_URL || "http://restaurant-service:8000";
const PORT = process.env.PORT || 8110;
const SERVICE_NAME = process.env.SERVICE_NAME || "order-dispatch-worker";
const startTime = Date.now();

// Separate connections: worker blocks on BLPOP; queue client serves /health and DLQ writes.
const worker = new Redis(REDIS_URL);
const queue = new Redis(REDIS_URL);

let lastJobAt = null;

async function moveToDlq(record) {
  await queue.rpush(DLQ_KEY, JSON.stringify(record));
  console.log(
    `[DISPATCH] moved job to DLQ (${record.reason || record.error || "unknown"}): order_id=${record.order_id ?? "n/a"}`
  );
}

async function restaurantExists(restaurantId) {
  const url = `${RESTAURANT_SERVICE_URL}/restaurants/${encodeURIComponent(restaurantId)}`;
  const res = await fetch(url, { method: "GET" });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Restaurant service error: ${res.status}`);
  return true;
}

async function processOne(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    await moveToDlq({
      raw,
      error: e.message,
      reason: "invalid_json",
      at: new Date().toISOString(),
    });
    return;
  }

  const orderId = parsed.order_id;
  const restaurantId = parsed.restaurant_id;
  if (orderId == null || restaurantId == null) {
    await moveToDlq({
      payload: parsed,
      reason: "missing_order_id_or_restaurant_id",
      at: new Date().toISOString(),
    });
    return;
  }

  let exists;
  try {
    exists = await restaurantExists(restaurantId);
  } catch (e) {
    await moveToDlq({
      order_id: orderId,
      restaurant_id: restaurantId,
      reason: "restaurant_service_error",
      error: e.message,
      at: new Date().toISOString(),
    });
    return;
  }

  if (!exists) {
    await moveToDlq({
      order_id: orderId,
      restaurant_id: restaurantId,
      reason: "restaurant_not_found",
      at: new Date().toISOString(),
    });
    console.log(`[DISPATCH] poison pill: restaurant '${restaurantId}' not found for order ${orderId}`);
    return;
  }

  const res = await fetch(`${DRIVER_SERVICE_URL}/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: orderId }),
  });

  if (!res.ok) {
    const detail = await res.text();
    await moveToDlq({
      order_id: orderId,
      restaurant_id: restaurantId,
      reason: "driver_assign_failed",
      status: res.status,
      detail: detail.slice(0, 500),
      at: new Date().toISOString(),
    });
    return;
  }

  const driver = await res.json();
  console.log(`[DISPATCH] Assigned driver ${driver.id} to order ${orderId}`);
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

async function run() {
  console.log(`Order Dispatch Worker listening on ${QUEUE_KEY} (DLQ: ${DLQ_KEY})`);

  while (true) {
    try {
      const result = await worker.blpop(QUEUE_KEY, 5);
      if (!result) continue;

      const [, raw] = result;
      const preview = raw.length > 120 ? `${raw.slice(0, 120)}...` : raw;
      console.log(`[DISPATCH] Consumed job from queue: ${preview}`);

      try {
        await processOne(raw);
      } catch (err) {
        console.error("[DISPATCH] unexpected error:", err.message);
        await moveToDlq({
          raw,
          reason: "unexpected_processing_error",
          error: err.message,
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error("[DISPATCH] loop error:", err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

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
    dlq_depth: dlqDepth,
    last_job_at: lastJobAt,
    checks,
  });
});

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} /health listening on ${PORT}`);
});

run();
