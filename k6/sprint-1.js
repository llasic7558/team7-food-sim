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
const DRIVER_URL = "http://driver-service:8000";

export default function () {

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

  // list all drivers
  const drivers = http.get(`${DRIVER_URL}/drivers`);
  check(drivers, {
    "GET /drivers status 200": (r) => r.status === 200,
  }) || errorRate.add(1);

  sleep(0.5);
}
