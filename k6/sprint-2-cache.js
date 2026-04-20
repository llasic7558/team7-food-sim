// Sprint 2 — Cache comparison load test
// same stages and shapes as sprint 1, however checking how the redis chaching helps,
//doing a run with having chache enabled and not to better see the differnce
// Run from inside holmes:
//   docker compose exec holmes bash
//   k6 run /workspace/k6/sprint-2-cache.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const errorRate = new Rate("errors");

export const options = {
  stages: [
    { duration: "30s", target: 20 },
    { duration: "30s", target: 20 },
    { duration: "10s", target: 0 },
  ],
  thresholds: {
    // Aggregate thresholds
    http_req_duration: ["p(50)<300", "p(95)<500", "p(99)<1000"],
    errors: ["rate<0.01"],
    "http_req_duration{endpoint:list_restaurants}": ["p(95)<5000"],
    "http_req_duration{endpoint:menu}":             ["p(95)<5000"],
    "http_req_duration{endpoint:list_orders}":      ["p(95)<5000"],
    "http_req_duration{endpoint:create_order}":     ["p(95)<5000"],
    "http_req_duration{endpoint:get_order}":        ["p(95)<5000"],
    "http_req_duration{endpoint:list_drivers}":     ["p(95)<5000"],
  },
};

const RESTAURANT_URL = "http://restaurant-service:8000";
const ORDER_URL = "http://order-service:8000";
const DRIVER_URL = "http://driver-service:8000";

let counter = 0;
// here so idempotency keys don't collide across reruns
const RUN_ID = Date.now();

export default function () {
  // ── Restaurant Service ──
  const restaurants = http.get(`${RESTAURANT_URL}/restaurants`, {
    tags: { endpoint: "list_restaurants" },
  });
  check(restaurants, {
    "GET /restaurants status 200": (r) => r.status === 200,
  }) || errorRate.add(1);

  //  cached endpoint this is where the Redis cache effect shows up.
  const menu = http.get(`${RESTAURANT_URL}/restaurants/1/menu`, {
    tags: { endpoint: "menu" },
  });
  check(menu, {
    "GET /restaurants/1/menu status 200": (r) => r.status === 200,
  }) || errorRate.add(1);

  // ── Order Service ──
  const orders = http.get(`${ORDER_URL}/orders`, {
    tags: { endpoint: "list_orders" },
  });
  check(orders, {
    "GET /orders status 200": (r) => r.status === 200,
  }) || errorRate.add(1);

  const idempotencyKey = `k6-cache-${RUN_ID}-${__VU}-${__ITER}-${counter++}`;
  const createRes = http.post(
    `${ORDER_URL}/orders`,
    JSON.stringify({
      customer_id: `k6-customer-${__VU}`,
      restaurant_id: "1",
      items: [{ item_id: 1, quantity: 1 }],
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
      tags: { endpoint: "create_order" },
    }
  );
  check(createRes, {
    "POST /orders status 201": (r) => r.status === 201,
  }) || errorRate.add(1);

  if (createRes.status === 201) {
    const orderId = JSON.parse(createRes.body).id;
    const getOrder = http.get(`${ORDER_URL}/orders/${orderId}`, {
      tags: { endpoint: "get_order" },
    });
    check(getOrder, {
      "GET /orders/:id status 200": (r) => r.status === 200,
    }) || errorRate.add(1);
  }

  // ── Driver Service ──
  const drivers = http.get(`${DRIVER_URL}/drivers`, {
    tags: { endpoint: "list_drivers" },
  });
  check(drivers, {
    "GET /drivers status 200": (r) => r.status === 200,
  }) || errorRate.add(1);

  sleep(0.5);
}
