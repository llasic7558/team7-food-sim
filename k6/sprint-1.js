// Sprint 1 — Baseline load test (no caching)
//
// Run from inside the holmes container:
//   docker compose exec holmes bash
//   k6 run /workspace/k6/sprint-1.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const errorRate = new Rate("errors");

export const options = {
  stages: [
    { duration: "30s", target: 20 }, // ramp up to 20 VUs
    { duration: "30s", target: 20 }, // sustain
    { duration: "10s", target: 0 },  // ramp down
  ],
  thresholds: {
    http_req_duration: ["p(50)<300", "p(95)<500", "p(99)<1000"],
    errors: ["rate<0.01"],
  },
};

const RESTAURANT_URL = "http://restaurant-service:8000";
const ORDER_URL = "http://order-service:8000";
const DRIVER_URL = "http://driver-service:8000";

let counter = 0;

export default function () {

  // ── Restaurant Service ──

  // list all restaurants
  const restaurants = http.get(`${RESTAURANT_URL}/restaurants`);
  check(restaurants, {
    "GET /restaurants status 200": (r) => r.status === 200,
  }) || errorRate.add(1);

  // get menu for restaurant 1
  const menu = http.get(`${RESTAURANT_URL}/restaurants/1/menu`);
  check(menu, {
    "GET /restaurants/1/menu status 200": (r) => r.status === 200,
  }) || errorRate.add(1);

  // ── Order Service ──

  // list all orders
  const orders = http.get(`${ORDER_URL}/orders`);
  check(orders, {
    "GET /orders status 200": (r) => r.status === 200,
  }) || errorRate.add(1);

  // create an order (idempotency key unique per iteration + VU)
  const idempotencyKey = `k6-${__VU}-${__ITER}-${counter++}`;
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
    }
  );
  check(createRes, {
    "POST /orders status 201": (r) => r.status === 201,
  }) || errorRate.add(1);

  // get the created order
  if (createRes.status === 201) {
    const orderId = JSON.parse(createRes.body).id;
    const getOrder = http.get(`${ORDER_URL}/orders/${orderId}`);
    check(getOrder, {
      "GET /orders/:id status 200": (r) => r.status === 200,
    }) || errorRate.add(1);
  }

  // ── Driver Service ──

  // list all drivers
  const drivers = http.get(`${DRIVER_URL}/drivers`);
  check(drivers, {
    "GET /drivers status 200": (r) => r.status === 200,
  }) || errorRate.add(1);

  sleep(0.5);
}
