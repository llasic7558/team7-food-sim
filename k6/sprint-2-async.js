// Sprint 2 — Async pipeline throughput test
//what we are doing
//burst fires 50 vu on POST /orders as fast as possible measuring latency(not e2e)
//monitor polls on the /heath like before to see queue depth and any built up backlog
//idempotncy check to make sure the key gives back right info, and no dup row made
//how to run
//docker compose exec holmes bash
//k6 run /workspace/k6/sprint-2-async.js
//docker compose logs -f order-service order-dispatch-worker preparation-tracker-worker

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

const ORDER_URL = "http://order-service:8000";
const DISPATCH_HEALTH = "http://order-dispatch-worker:8110/health";
const PREP_HEALTH = "http://preparation-tracker-worker:8100/health";

const ackLatency = new Trend("order_ack_latency_ms", true);
const dispatchDepth = new Trend("dispatch_queue_depth", false);
const prepDepth = new Trend("prep_queue_depth", false);
const acceptedOrders = new Counter("accepted_orders");
const duplicateOrdersRejected = new Counter("duplicate_orders_blocked");

export const options = {
  scenarios: {
    burst: {
      executor: "per-vu-iterations",
      vus: 50,
      iterations: 1,
      startTime: "1s",
      maxDuration: "30s",
      exec: "burstOrder",
    },
    monitor: {
      executor: "constant-vus",
      vus: 1,
      duration: "60s",
      startTime: "0s",
      exec: "monitorQueues",
    },
    idempotency: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      startTime: "45s",
      exec: "idempotencyCheck",
    },
  },
  thresholds: {
    "http_req_failed{scenario:burst}": ["rate<0.01"],
    "order_ack_latency_ms": ["p(95)<2000"],
    "checks{scenario:idempotency}": ["rate==1.0"],
  },
};

export function burstOrder() {
  const key = `burst-${__VU}-${Date.now()}`;
  const res = http.post(
    `${ORDER_URL}/orders`,
    JSON.stringify({
      customer_id: `k6-burst-${__VU}`,
      restaurant_id: "1",
      items: [{ item_id: 1, quantity: 1 }],
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": key,
      },
      tags: { name: "burst POST /orders" },
    }
  );

  check(res, {
    "burst POST /orders status 201": (r) => r.status === 201,
  });

  if (res.status === 201) {
    acceptedOrders.add(1);
    ackLatency.add(res.timings.duration);
  }
}

export function monitorQueues() {
  const d = http.get(DISPATCH_HEALTH, { tags: { name: "dispatch /health" } });
  if (d.status === 200) {
    try {
      const body = JSON.parse(d.body);
      if (typeof body.queue_depth === "number") {
        dispatchDepth.add(body.queue_depth);
        console.log(
          `[monitor t=${__ITER * 2}s] dispatch queue_depth=${body.queue_depth} last_job_at=${body.last_job_at}`
        );
      }
    } catch (_) {}
  }

  const p = http.get(PREP_HEALTH, { tags: { name: "prep /health" } });
  if (p.status === 200) {
    try {
      const body = JSON.parse(p.body);
      if (typeof body.queue_depth === "number") {
        prepDepth.add(body.queue_depth);
        console.log(
          `[monitor t=${__ITER * 2}s] prep     queue_depth=${body.queue_depth} dlq=${body.dead_letter_queue_depth} last_job_at=${body.last_job_at}`
        );
      }
    } catch (_) {}
  }

  sleep(2);
}

export function idempotencyCheck() {
  const key = `idem-${Date.now()}`;
  const body = JSON.stringify({
    customer_id: "k6-idem",
    restaurant_id: "1",
    items: [{ item_id: 1, quantity: 1 }],
  });
  const headers = {
    "Content-Type": "application/json",
    "X-Idempotency-Key": key,
  };

  const first = http.post(`${ORDER_URL}/orders`, body, {
    headers,
    tags: { name: "idempotency POST (first)" },
  });
  const second = http.post(`${ORDER_URL}/orders`, body, {
    headers,
    tags: { name: "idempotency POST (replay)" },
  });

  let firstId, secondId;
  try { firstId = JSON.parse(first.body).id; } catch (_) {}
  try { secondId = JSON.parse(second.body).id; } catch (_) {}

  const sameId = firstId !== undefined && firstId === secondId;
  if (sameId) duplicateOrdersRejected.add(1);

  check(first, {
    "idempotency first response is 201": (r) => r.status === 201,
  });
  check(second, {
    "idempotency replay response is 2xx": (r) => r.status >= 200 && r.status < 300,
  });
  check({ firstId, secondId }, {
    "idempotency replay returns same order id (no duplicate row)": (ctx) =>
      ctx.firstId !== undefined && ctx.firstId === ctx.secondId,
  });

  console.log(
    `[idempotency] key=${key} first=${first.status}/id=${firstId} replay=${second.status}/id=${secondId} sameId=${sameId}`
  );
}
