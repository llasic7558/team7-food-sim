const express = require("express");
const Redis = require("ioredis");

const QUEUE_KEY = "queue:order_dispatch";
const DISPATCHED_CHANNEL = "order_dispatched";
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const DRIVER_SERVICE_URL = process.env.DRIVER_SERVICE_URL || "http://driver-service:8000";
const PORT = process.env.PORT || 8110;
const SERVICE_NAME = process.env.SERVICE_NAME || "order-dispatch-worker";
const startTime = Date.now();

// separate connections so worker parks in BLPOP, queue serves /health, a bug
// that lead to the worker being stuck
const worker = new Redis(REDIS_URL);
const queue = new Redis(REDIS_URL);

let lastJobAt = null;

async function run() {
  console.log(`Order Dispatch Worker listening on ${QUEUE_KEY}`);

  while (true) {
    try {
      const result = await worker.blpop(QUEUE_KEY, 5);
      if (!result) continue;

      const [, raw] = result;
      const order = JSON.parse(raw);
      console.log(`[DISPATCH] Consumed order ${order.order_id}`);
      //call driver
      const res = await fetch(`${DRIVER_SERVICE_URL}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: order.order_id }),
      });

      if (!res.ok) {
        throw new Error(`Driver service error: ${res.status}`);
      }

      const driver = await res.json();
      console.log(`[DISPATCH] Assigned driver ${driver.id} to order ${order.order_id}`);
      //publish event
      await worker.publish(
        DISPATCHED_CHANNEL,
        JSON.stringify({ order_id: order.order_id, driver_id: driver.id })
      );
      //time to send when doing health check
      lastJobAt = new Date().toISOString();
    } catch (err) {
      console.error("[ERROR]", err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

const app = express();
//health check to see if redis is up and examiing its queueDepth
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

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "healthy" : "unhealthy",
    service: SERVICE_NAME,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    queue_depth: queueDepth,
    last_job_at: lastJobAt,
    checks,
  });
});

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} /health listening on ${PORT}`);
});

run();
