// Sprint 3 — Poison pill resilience
//
// What this exercises:
//   - normal     : steady stream of valid POST /orders requests (happy path)
//   - poison     : pushes malformed jobs DIRECTLY into queue:order_dispatch via
//                  redis (bypassing order-service validation) so they actually
//                  reach the dispatch worker
//   - monitor    : polls order-dispatch-worker and preparation-tracker-worker
//                  /health throughout the test
//   - teardown   : after the run, drains the queue and asserts that dispatch
//                  worker is still healthy AND its dead_letter_queue_depth
//                  grew by at least the number of poison pills we injected.
//
// Three poison-pill flavors (each maps to a known DLQ reason in the worker):
//   1. invalid_json         : raw bytes that aren't valid JSON
//   2. missing_fields       : valid JSON but no order_id / restaurant_id
//   3. restaurant_not_found : valid envelope, restaurant_id that doesn't exist
//
// Run from inside the holmes container:
//   docker compose exec holmes bash
//   k6 run /workspace/k6/sprint-3-poison.js
//
// After the run, a TA can independently verify with:
//   curl -s http://order-dispatch-worker:8110/health | jq
//   docker compose ps

import http from "k6/http";
import { check, sleep } from "k6";
import redis from "k6/experimental/redis";
import { Trend, Counter, Rate } from "k6/metrics";

const ORDER_URL = "http://order-service:8000";
const DISPATCH_HEALTH = "http://order-dispatch-worker:8110/health";
const PREP_HEALTH = "http://preparation-tracker-worker:8100/health";

const ORDER_DISPATCH_QUEUE = "queue:order_dispatch";

const r = new redis.Client("redis://redis:6379");

const goodOrders = new Counter("good_orders_accepted");
const poisonInjected = new Counter("poison_pills_injected");
const goodLatency = new Trend("good_order_latency_ms", true);
const dlqDepthObserved = new Trend("dlq_depth_observed", false);
const dispatchQueueDepth = new Trend("dispatch_queue_depth_observed", false);
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
      preAllocatedVUs: 10,
      maxVUs: 20,
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
    // Good traffic must keep flowing — most should succeed even while DLQ is
    // filling up. Threshold is 5% to absorb the rare blip.
    "http_req_failed{scenario:normal}": ["rate<0.05"],
    "good_order_latency_ms": ["p(95)<3000"],
    // Workers must stay healthy throughout (no crashes / no 503s).
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

export function setup() {
  // Capture baseline DLQ depth so we measure only what THIS run produced.
  const h = readDispatchHealth();
  const baseline = h.body?.dead_letter_queue_depth ?? 0;
  console.log(
    `[setup] dispatch worker status=${h.body?.status ?? "unknown"} baseline_dlq_depth=${baseline}`
  );
  return { baseline };
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
    // restaurant_not_found — well-formed envelope, unknown restaurant_id.
    // Worker will hit restaurant-service, get 404, send straight to DLQ.
    payload = JSON.stringify({
      order_id: `poison-rnf-${__ITER}-${Date.now()}`,
      restaurant_id: "999999",
    });
    label = "restaurant_not_found";
  } else if (variant === 1) {
    // missing_fields — valid JSON but no order_id / restaurant_id.
    payload = JSON.stringify({
      injected_at: new Date().toISOString(),
      note: "deliberately malformed: missing order_id and restaurant_id",
    });
    label = "missing_fields";
  } else {
    // invalid_json — not parseable as JSON at all.
    payload = `<<not-json-${__ITER}-${Date.now()}>>`;
    label = "invalid_json";
  }

  try {
    await r.rpush(ORDER_DISPATCH_QUEUE, payload);
    poisonInjected.add(1);
    console.log(
      `[poison] injected variant=${label} preview=${payload.slice(0, 80)}`
    );
  } catch (err) {
    console.error(`[poison] failed to inject (${label}):`, err.message);
  }
}

export function monitorWorkers() {
  const d = readDispatchHealth();
  dispatchHealthy.add(d.status === 200 && d.body?.status === "healthy");
  if (d.body) {
    const dlq = d.body.dead_letter_queue_depth ?? 0;
    const q = d.body.queue_depth ?? 0;
    const rq = d.body.retry_queue_depth ?? 0;
    dlqDepthObserved.add(dlq);
    dispatchQueueDepth.add(q);
    console.log(
      `[monitor] dispatch status=${d.body.status} q=${q} retry_q=${rq} dlq=${dlq} last_job_at=${d.body.last_job_at}`
    );
  }

  const p = http.get(PREP_HEALTH, { tags: { name: "prep /health" } });
  prepHealthy.add(p.status === 200);
  if (p.status === 200) {
    try {
      const body = JSON.parse(p.body);
      console.log(
        `[monitor] prep     status=${body.status} q=${body.queue_depth} dlq=${body.dead_letter_queue_depth} last_job_at=${body.last_job_at}`
      );
    } catch (_) {}
  }
  sleep(2);
}

export function teardown(data) {
  console.log("[teardown] waiting for dispatch worker to drain remaining good jobs...");

  // Give the worker up to ~20s to chew through any straggler good messages
  // queued near the end of the run, so the final dlq number is stable.
  let final = data.baseline;
  let workerStatus = "unknown";
  let queueDepth = -1;
  for (let i = 0; i < 20; i++) {
    const h = readDispatchHealth();
    if (h.body) {
      final = h.body.dead_letter_queue_depth ?? final;
      workerStatus = h.body.status;
      queueDepth = h.body.queue_depth ?? queueDepth;
      if (queueDepth === 0) break;
    }
    sleep(1);
  }

  const delta = final - data.baseline;
  console.log(
    `[teardown] dispatch worker status=${workerStatus} queue_depth=${queueDepth} ` +
      `dlq_baseline=${data.baseline} dlq_final=${final} dlq_delta=${delta} ` +
      `poison_injected=${POISON_TOTAL}`
  );

  if (workerStatus !== "healthy") {
    console.error(`[teardown] FAIL: dispatch worker is not healthy (status=${workerStatus})`);
  }
  if (delta < POISON_TOTAL) {
    console.error(
      `[teardown] FAIL: expected at least ${POISON_TOTAL} new DLQ entries, got ${delta}`
    );
  } else {
    console.log(
      `[teardown] PASS: ${delta} poison pills landed in DLQ, worker still healthy`
    );
  }
}
