// Sprint 3 — Poison pill resilience
//
// What this exercises:
//   - normal     : steady stream of valid POST /orders requests (happy path)
//   - poison     : pushes malformed jobs DIRECTLY into queue:order_dispatch via
//                  redis (bypassing order-service validation) so they actually
//                  reach the dispatch worker
//   - monitor    : polls order-dispatch-worker and preparation-tracker-worker
//                  /health throughout the test
//   - teardown   : after the run, checks that dispatch is still healthy and
//                  that dlq_depth grew by at least the number of poison pills
//                  injected during this run. Extra DLQ entries are acceptable
//                  if they are real orders that exhausted driver retries.
//
// Three poison-pill flavors (each maps to a known DLQ reason in the worker):
//   1. invalid_json         : raw bytes that aren't valid JSON
//   2. missing_fields       : valid JSON but no order_id / restaurant_id
//   3. restaurant_not_found : valid envelope, restaurant_id that doesn't exist
//
// Run from inside the holmes container:
//   k6 run /workspace/k6/sprint-3-poison.js
//
// After the run:
//   curl -s http://order-dispatch-worker:8110/health | jq

import http from "k6/http";
import { check, sleep } from "k6";
import redis from "k6/experimental/redis";
import { Counter, Rate, Trend } from "k6/metrics";

const ORDER_URL = "http://order-service:8000";
const DISPATCH_HEALTH = "http://order-dispatch-worker:8110/health";
const PREP_HEALTH = "http://preparation-tracker-worker:8100/health";
const ORDER_DISPATCH_QUEUE = "queue:order_dispatch";

const queue = new redis.Client("redis://redis:6379");

const goodOrders = new Counter("good_orders_accepted");
const poisonInjected = new Counter("poison_pills_injected");
const goodLatency = new Trend("good_order_latency_ms", true);
const dlqDepthObserved = new Trend("dlq_depth_observed", false);
const dispatchQueueDepth = new Trend("dispatch_queue_depth_observed", false);
const dispatchRetryQueueDepth = new Trend("dispatch_retry_queue_depth_observed", false);
const dispatchHealthy = new Rate("dispatch_worker_healthy");
const prepHealthy = new Rate("prep_worker_healthy");

const POISON_TOTAL = 30;

export const options = {
  scenarios: {
    normal: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: "40s",
      preAllocatedVUs: 6,
      maxVUs: 12,
      startTime: "0s",
      exec: "normalOrder",
    },
    poison: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: POISON_TOTAL,
      startTime: "5s",
      maxDuration: "20s",
      exec: "injectPoison",
    },
    monitor: {
      executor: "constant-vus",
      vus: 1,
      duration: "55s",
      startTime: "0s",
      exec: "monitorWorkers",
    },
  },
  thresholds: {
    "http_req_failed{scenario:normal}": ["rate<0.05"],
    "good_order_latency_ms": ["p(95)<3000"],
    "dispatch_worker_healthy": ["rate==1"],
    "prep_worker_healthy": ["rate==1"],
  },
};

function readDispatchHealth() {
  const res = http.get(DISPATCH_HEALTH, { tags: { name: "dispatch /health" } });
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
  const health = readDispatchHealth();
  const baselineDlqDepth = currentDlqDepth(health.body);

  console.log(
    `[setup] dispatch worker status=${health.body?.status ?? "unknown"} ` +
      `baseline_dlq_depth=${baselineDlqDepth}`
  );

  return { baselineDlqDepth };
}

export function normalOrder() {
  const key = `sprint3-good-${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(
    `${ORDER_URL}/orders`,
    JSON.stringify({
      customer_id: `k6-good-${__VU}`,
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
    payload = JSON.stringify({
      order_id: `poison-rnf-${__ITER}-${Date.now()}`,
      restaurant_id: "999999",
    });
    label = "restaurant_not_found";
  } else if (variant === 1) {
    payload = JSON.stringify({
      injected_at: new Date().toISOString(),
      note: "deliberately malformed: missing order_id and restaurant_id",
    });
    label = "missing_fields";
  } else {
    payload = `<<not-json-${__ITER}-${Date.now()}>>`;
    label = "invalid_json";
  }

  try {
    await queue.rpush(ORDER_DISPATCH_QUEUE, payload);
    poisonInjected.add(1);
    console.log(
      `[poison] injected variant=${label} preview=${payload.slice(0, 80)}`
    );
  } catch (err) {
    console.error(`[poison] failed to inject (${label}): ${err.message}`);
  }
}

export function monitorWorkers() {
  const dispatch = readDispatchHealth();
  dispatchHealthy.add(
    dispatch.status === 200 && dispatch.body?.status === "healthy"
  );

  if (dispatch.body) {
    const dlqDepth = currentDlqDepth(dispatch.body);
    const queueDepth = dispatch.body.queue_depth ?? 0;
    const retryQueueDepth = dispatch.body.retry_queue_depth ?? 0;
    dlqDepthObserved.add(dlqDepth);
    dispatchQueueDepth.add(queueDepth);
    dispatchRetryQueueDepth.add(retryQueueDepth);

    console.log(
      `[monitor] dispatch status=${dispatch.body.status} q=${queueDepth} ` +
        `retry_q=${retryQueueDepth} dlq=${dlqDepth} last_job_at=${dispatch.body.last_job_at}`
    );
  }

  const prep = http.get(PREP_HEALTH, { tags: { name: "prep /health" } });
  prepHealthy.add(prep.status === 200);
  if (prep.status === 200) {
    try {
      const body = JSON.parse(prep.body);
      console.log(
        `[monitor] prep     status=${body.status} q=${body.queue_depth} ` +
          `dlq=${body.dlq_depth ?? body.dead_letter_queue_depth} last_job_at=${body.last_job_at}`
      );
    } catch (_) {}
  }

  sleep(2);
}

export function teardown(data) {
  console.log("[teardown] waiting for dispatch worker to drain remaining good jobs...");

  let finalDlqDepth = data.baselineDlqDepth;
  let workerStatus = "unknown";
  let queueDepth = -1;
  let retryQueueDepth = -1;

  for (let i = 0; i < 20; i++) {
    const health = readDispatchHealth();
    if (health.body) {
      finalDlqDepth = currentDlqDepth(health.body);
      workerStatus = health.body.status;
      queueDepth = health.body.queue_depth ?? queueDepth;
      retryQueueDepth = health.body.retry_queue_depth ?? retryQueueDepth;
      if (queueDepth === 0) break;
    }
    sleep(1);
  }

  const dlqDelta = finalDlqDepth - data.baselineDlqDepth;
  console.log(
    `[teardown] dispatch worker status=${workerStatus} queue_depth=${queueDepth} ` +
      `retry_queue_depth=${retryQueueDepth} ` +
      `dlq_baseline=${data.baselineDlqDepth} dlq_final=${finalDlqDepth} ` +
      `dlq_delta=${dlqDelta} poison_injected=${POISON_TOTAL}`
  );

  if (workerStatus !== "healthy") {
    console.error(`[teardown] FAIL: dispatch worker is not healthy (status=${workerStatus})`);
  }
  if (dlqDelta < POISON_TOTAL) {
    console.error(
      `[teardown] FAIL: expected at least ${POISON_TOTAL} new DLQ entries, got ${dlqDelta}`
    );
  } else {
    console.log(
      `[teardown] PASS: ${dlqDelta} new DLQ entries observed. That includes all poison pills ` +
        `and may also include real orders that exhausted driver retries.`
    );
  }
}
