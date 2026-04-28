// Sprint 3 — Notification worker poison pill handling
//
// This companion test shows the notification worker behavior without a retry
// queue: malformed messages go directly to the DLQ while valid notifications
// continue to be processed.
//
// Run from inside the holmes container:
//   k6 run /workspace/k6/sprint-3-notification-poison.js

import http from "k6/http";
import { check, sleep } from "k6";
import redis from "k6/experimental/redis";
import { Counter, Rate, Trend } from "k6/metrics";

const ORDER_URL = "http://order-service:8000";
const NOTIFICATION_HEALTH = "http://notification-worker:8000/health";
const NOTIFICATION_QUEUE = "queue:notifications";

const queue = new redis.Client("redis://redis:6379");

const goodOrders = new Counter("notification_good_orders_accepted");
const poisonInjected = new Counter("notification_poison_pills_injected");
const goodLatency = new Trend("notification_good_order_latency_ms", true);
const dlqDepthObserved = new Trend("notification_dlq_depth_observed", false);
const queueDepthObserved = new Trend("notification_queue_depth_observed", false);
const workerHealthy = new Rate("notification_worker_healthy");

const POISON_TOTAL = 15;

export const options = {
  scenarios: {
    normal: {
      executor: "constant-arrival-rate",
      rate: 2,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 4,
      maxVUs: 8,
      exec: "normalOrder",
    },
    poison: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: POISON_TOTAL,
      startTime: "5s",
      maxDuration: "15s",
      exec: "injectPoison",
    },
    monitor: {
      executor: "constant-vus",
      vus: 1,
      duration: "40s",
      exec: "monitorWorker",
    },
  },
  thresholds: {
    "http_req_failed{scenario:normal}": ["rate<0.05"],
    "notification_good_order_latency_ms": ["p(95)<3000"],
    "notification_worker_healthy": ["rate==1"],
  },
};

function readHealth() {
  const res = http.get(NOTIFICATION_HEALTH, {
    tags: { name: "notification /health" },
  });
  if (res.status !== 200) {
    return { status: res.status, body: null };
  }

  try {
    return { status: 200, body: JSON.parse(res.body) };
  } catch (_) {
    return { status: 200, body: null };
  }
}

function currentDlqDepth(body) {
  return body?.dlq_depth ?? body?.dead_letter_queue_depth ?? 0;
}

export function setup() {
  const health = readHealth();
  const baselineDlqDepth = currentDlqDepth(health.body);

  console.log(
    `[setup] notification worker status=${health.body?.status ?? "unknown"} ` +
      `baseline_dlq_depth=${baselineDlqDepth}`
  );

  return { baselineDlqDepth };
}

export function normalOrder() {
  const key = `notif-poison-${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(
    `${ORDER_URL}/orders`,
    JSON.stringify({
      customer_id: `k6-notif-${__VU}`,
      restaurant_id: "1",
      items: [{ item_id: 1, quantity: 1 }],
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": key,
      },
      tags: { name: "good POST /orders", scenario: "normal" },
    }
  );

  const ok = check(res, {
    "good order returns 201": (r) => r.status === 201,
  });

  if (ok) {
    goodOrders.add(1);
    goodLatency.add(res.timings.duration);
  }
}

export async function injectPoison() {
  const variant = __ITER % 3;
  let payload;
  let label;

  if (variant === 0) {
    payload = `<<notif-not-json-${__ITER}-${Date.now()}>>`;
    label = "invalid_json";
  } else if (variant === 1) {
    payload = JSON.stringify(["bad", "shape", __ITER]);
    label = "invalid_payload_shape";
  } else {
    payload = JSON.stringify({
      status: "confirmed",
      note: "missing event and order_id on purpose",
    });
    label = "missing_required_fields";
  }

  try {
    await queue.rpush(NOTIFICATION_QUEUE, payload);
    poisonInjected.add(1);
    console.log(
      `[poison] injected variant=${label} preview=${payload.slice(0, 80)}`
    );
  } catch (err) {
    console.error(`[poison] failed to inject (${label}): ${err.message}`);
  }
}

export function monitorWorker() {
  const health = readHealth();
  workerHealthy.add(health.status === 200 && health.body?.status === "healthy");

  if (health.body) {
    const queueDepth = health.body.queue_depth ?? 0;
    const dlqDepth = currentDlqDepth(health.body);
    queueDepthObserved.add(queueDepth);
    dlqDepthObserved.add(dlqDepth);

    console.log(
      `[monitor] notification status=${health.body.status} q=${queueDepth} ` +
        `dlq=${dlqDepth} last_job_at=${health.body.last_job_at}`
    );
  }

  sleep(2);
}

export function teardown(data) {
  let finalDlqDepth = data.baselineDlqDepth;
  let workerStatus = "unknown";
  let queueDepth = -1;

  for (let i = 0; i < 15; i++) {
    const health = readHealth();
    if (health.body) {
      finalDlqDepth = currentDlqDepth(health.body);
      workerStatus = health.body.status;
      queueDepth = health.body.queue_depth ?? queueDepth;
      if (queueDepth === 0) break;
    }
    sleep(1);
  }

  const dlqDelta = finalDlqDepth - data.baselineDlqDepth;
  console.log(
    `[teardown] notification worker status=${workerStatus} queue_depth=${queueDepth} ` +
      `dlq_baseline=${data.baselineDlqDepth} dlq_final=${finalDlqDepth} ` +
      `dlq_delta=${dlqDelta} poison_injected=${POISON_TOTAL}`
  );

  if (workerStatus !== "healthy") {
    console.error(`[teardown] FAIL: notification worker is not healthy (status=${workerStatus})`);
  }
  if (dlqDelta < POISON_TOTAL) {
    console.error(
      `[teardown] FAIL: expected at least ${POISON_TOTAL} new DLQ entries, got ${dlqDelta}`
    );
  } else {
    console.log(
      `[teardown] PASS: notification worker handled poison directly via DLQ with no retry queue`
    );
  }
}
