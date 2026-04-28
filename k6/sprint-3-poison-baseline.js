import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const ORDER_URL = "http://order-service:8000";

const goodOrders = new Counter("good_orders_accepted");
const goodLatency = new Trend("good_order_latency_ms", true);

export const options = {
  scenarios: {
    normal: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: "40s",
      preAllocatedVUs: 6,
      maxVUs: 12,
      exec: "normalOrder",
    },
  },
  thresholds: {
    "http_req_failed{scenario:normal}": ["rate<0.05"],
    "good_order_latency_ms": ["p(95)<3000"],
  },
};

export function normalOrder() {
  const key = `sprint3-baseline-${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(
    `${ORDER_URL}/orders`,
    JSON.stringify({
      customer_id: `k6-baseline-${__VU}`,
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
