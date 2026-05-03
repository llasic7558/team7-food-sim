# Team 7 - Food Delivery Coordination

- **Course:** COMPSCI 426
- **Team name:** Team 7
- **System name:** Food Delivery Coordination
- **Repository:** https://github.com/llasic7558/team7-food-sim

Food Delivery Coordination is a Docker Compose microservice system for restaurant lookup, order creation, asynchronous dispatch, preparation tracking, delivery tracking, driver assignment, surge pricing, notifications, and ratings.

---

## Team and Service Ownership

Ownership is based on `git log --all -- <path>` history.

| Team member | Services / components owned | Commit-history evidence |
| --- | --- | --- |
| Dev Mehta | Restaurant caching, k6 resilience tests | `dev8mehta` commits in `restaurant-service/` and `k6/` |
| Emily Joyce | Restaurant service and early Docker/service wiring | `Emily Joyce` commits in `restaurant-service/`, DB files, Dockerfile, package files, and `compose.yml` |
| Kanika Khosla | Order queue consumer and notification worker contributions | `kanikak1904` commits for Redis queue consumption and notification-worker work |
| Beatrice Calvelo | Restaurant validation tests, preparation/dispatch worker behavior | `Beatrice Calvelo` commits for sync validation, preparation worker setup, and dispatch poison-pill handling |
| Rishi Patel | Order service and notification/dispatch support | `Rishi Patel` commits for order service, Redis health checks, notification consumer, and dispatch DLQ/health |
| Raymond Huang | Order service and dispatch DLQ handling | `Raymond Huang` / `rayhuang12` commits for order service and dispatch DLQ work |
| Shao Qin Tan | Rating and review service, surge pricing worker, Caddy replication setup | `shaoqintan` commits in `rating-and-review-service/`, `surge-pricing-worker/`, `Caddyfile`, and `compose.yml` |
| Luka Lasic | Compose integration, driver service, delivery pipeline, k6, final hardening/docs | `llasic7558` commits across `compose.yml`, `driver-service/`, workers, `delivery-tracker-service/`, `k6/`, and README |

Audit commands:

```bash
git log --all --format='%h %an %s' -- restaurant-service
git log --all --format='%h %an %s' -- order-service order-dispatch-worker preparation-tracker-worker notification-worker delivery-tracker-service
git log --all --format='%h %an %s' -- driver-service rating-and-review-service surge-pricing-worker compose.yml Caddyfile k6
```

---

## How to Start the System

```bash
# Start everything (builds images on first run)
docker compose up --build

# Start everything with 3 replicated driver-service app instances behind Caddy
docker compose up --build --scale driver-service-app=3

# Verify all services are running
docker compose ps

# Stream logs
docker compose logs -f

# Open a shell in the Holmes investigation container
docker compose exec holmes bash
```

### Base URLs

From inside Holmes:

```
restaurant-service           http://restaurant-service:8000
order-service                http://order-service:8000
driver-service               http://driver-service:8000
order-dispatch-worker        http://order-dispatch-worker:8110
preparation-tracker-worker   http://preparation-tracker-worker:8100
delivery-tracker-service     http://delivery-tracker-service:8000
rating-and-review-service    http://rating-and-review-service:8000
surge-pricing-worker         http://surge-pricing-worker:8200
notification-worker          http://notification-worker:8000
```

From the host machine:

```
restaurant-service           http://localhost:8002
order-service                http://localhost:8001
driver-service               http://localhost
order-dispatch-worker        http://localhost:8110
preparation-tracker-worker   http://localhost:8100
delivery-tracker-service     http://localhost:8005
rating-and-review-service    http://localhost:8004
surge-pricing-worker         http://localhost:8200
notification-worker          http://localhost:8006
```

The curl examples below use the Holmes URLs because that is how the TA usually verifies the system.

---

## Seed Data

PostgreSQL seed files run automatically on fresh Docker volumes through `/docker-entrypoint-initdb.d`.

| Database | Seed data |
| --- | --- |
| `restaurant-db` | Restaurants 1-3, menu items 1-7, and availability windows. k6 uses restaurant `1` and menu item `1`. |
| `order-db` | Three starter orders. |
| `driver-db` | Ten free drivers. Async and dispatch tests require available drivers. |
| `rating-db` | Three starter ratings for ratings and rankings reads. |
| `pricing-db` | Schema only. Surge periods are generated at runtime. |

Reset to clean seed data before a demo or test run:

```bash
docker compose down -v
docker compose up --build
```

Reset and start the scaled driver setup:

```bash
docker compose down -v
docker compose up --build --scale driver-service-app=3
```

For the cache comparison test, first run with the default cache enabled. Then restart with cache disabled:

```bash
docker compose down -v
CACHE_ENABLED=false docker compose up --build
```

---

## API Reference

---

## Restaurant Service

### GET /health

```
GET /health

  Returns the health status of the restaurant service and its dependencies
  (PostgreSQL and Redis).

  Responses:
    200  Service and all dependencies healthy
    503  One or more dependencies unreachable
```

**Example request:**

```bash
curl http://restaurant-service:8000/health
```

**Example output (200):**

```json
{
  "status": "healthy",
  "service": "restaurant-service",
  "timestamp": "2026-05-02T12:00:00.000Z",
  "uptime_seconds": 120,
  "checks": {
    "database": { "status": "healthy", "latency_ms": 2 },
    "redis": { "status": "healthy", "latency_ms": 1 }
  }
}
```

---

### GET /restaurants

```
GET /restaurants

  Returns all restaurants ordered by name. Each restaurant includes its
  availability windows and whether it is currently open.

  Responses:
    200  Success
    500  Internal server error
```

**Example request:**

```bash
curl http://restaurant-service:8000/restaurants
```

**Example output (200):**

```json
{
  "restaurants": [
    {
      "id": 1,
      "name": "Bella Italia",
      "cuisine": "Italian",
      "address": "123 Main St",
      "rating": "4.5",
      "availability_windows": [
        { "day_of_week": 1, "opens_at": "09:00", "closes_at": "21:00" }
      ],
      "is_open_now": true
    }
  ]
}
```

---

### GET /restaurants/search

```
GET /restaurants/search

  Search restaurants by name using a case-insensitive partial match.

  Query:
    name  string  required

  Responses:
    200  Success
    400  Missing name query parameter
    500  Internal server error
```

**Example request:**

```bash
curl "http://restaurant-service:8000/restaurants/search?name=bella"
```

**Example output (200):**

```json
{
  "restaurants": [
    {
      "id": 1,
      "name": "Bella Italia",
      "cuisine": "Italian",
      "address": "123 Main St",
      "rating": "4.5",
      "availability_windows": [
        { "day_of_week": 1, "opens_at": "09:00", "closes_at": "21:00" }
      ],
      "is_open_now": true
    }
  ]
}
```

---

### GET /restaurants/:id

```
GET /restaurants/:id

  Returns full detail for one restaurant, including availability windows
  and whether it is currently open.

  Path:
    id  integer  required

  Responses:
    200  Success
    404  Restaurant not found
    500  Internal server error
```

**Example request:**

```bash
curl http://restaurant-service:8000/restaurants/1
```

**Example output (200):**

```json
{
  "id": 1,
  "name": "Bella Italia",
  "cuisine": "Italian",
  "address": "123 Main St",
  "rating": "4.5",
  "availability_windows": [
    { "day_of_week": 1, "opens_at": "09:00", "closes_at": "21:00" }
  ],
  "is_open_now": true
}
```

**Example output (404):**

```json
{
  "error": "restaurant not found",
  "id": "999"
}
```

---

### GET /restaurants/:id/menu

```
GET /restaurants/:id/menu

  Returns menu items for a restaurant. The response includes restaurant
  availability, item-level availability, and the current surge multiplier.
  Results are cached in Redis for 5 minutes when CACHE_ENABLED is true.

  Path:
    id  integer  required

  Responses:
    200  Success
    404  Restaurant not found
    500  Internal server error
```

**Example request:**

```bash
curl http://restaurant-service:8000/restaurants/1/menu
```

**Example output (200):**

```json
{
  "restaurant_id": "1",
  "restaurant_open": true,
  "availability_windows": [
    { "day_of_week": 1, "opens_at": "09:00", "closes_at": "21:00" }
  ],
  "items": [
    {
      "id": 1,
      "restaurant_id": 1,
      "name": "Margherita Pizza",
      "description": "Classic tomato and mozzarella",
      "price": "12.00",
      "available": true,
      "available_now": true
    }
  ],
  "surge_multiplier": 1
}
```

---

## Order Service

### GET /health

```
GET /health

  Returns the health status of the order service and its dependencies
  (PostgreSQL and Redis).

  Responses:
    200  Service and all dependencies healthy
    503  One or more dependencies unreachable
```

**Example request:**

```bash
curl http://order-service:8000/health
```

**Example output (200):**

```json
{
  "status": "healthy",
  "service": "order-service",
  "timestamp": "2026-05-02T12:00:00.000Z",
  "uptime_seconds": 120,
  "checks": {
    "database": { "status": "healthy", "latency_ms": 2 },
    "redis": { "status": "healthy", "latency_ms": 1 }
  }
}
```

---

### GET /orders

```
GET /orders

  Returns all orders, most recent first. Supports optional filters.

  Query:
    customer_id  string  optional
    status       string  optional

  Responses:
    200  Success
    500  Internal server error
```

**Example requests:**

```bash
curl http://order-service:8000/orders
curl "http://order-service:8000/orders?customer_id=customer-1&status=delivered"
```

**Example output (200):**

```json
[
  {
    "id": 1,
    "customer_id": "customer-1",
    "restaurant_id": "1",
    "items": [
      { "item_id": 1, "quantity": 2 },
      { "item_id": 3, "quantity": 1 }
    ],
    "base_total_price": 32,
    "total_price": 32,
    "payment_status": "captured",
    "payment_reference": "seed-payment-1",
    "status": "delivered",
    "driver_id": null,
    "created_at": "2026-05-02T12:00:00.000Z",
    "updated_at": "2026-05-02T12:00:00.000Z"
  }
]
```

---

### POST /orders

```
POST /orders

  Creates a new order. The service validates restaurant and menu items by
  calling Restaurant Service before inserting the order. It pushes events to
  the dispatch, surge pricing, and notification queues.

  Headers:
    X-Idempotency-Key  string  required

  Body:
    customer_id          string   required
    restaurant_id        string   required
    items                array    required
    items[].item_id      integer  required
    items[].quantity     integer  optional, defaults to 1

  Responses:
    201  Order created, or duplicate replay returned from idempotency cache
    400  Missing header or invalid body
    422  Restaurant/menu validation failed
    500  Internal server error
    503  Idempotent request is still in flight
```

**Example request:**

```bash
curl -X POST http://order-service:8000/orders \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: unique-key-123" \
  -d '{
    "customer_id": "customer-1",
    "restaurant_id": "1",
    "items": [
      { "item_id": 1, "quantity": 2 },
      { "item_id": 3, "quantity": 1 }
    ]
  }'
```

**Example output (201):**

```json
{
  "id": 4,
  "customer_id": "customer-1",
  "restaurant_id": "1",
  "items": [
    { "item_id": 1, "quantity": 2 },
    { "item_id": 3, "quantity": 1 }
  ],
  "base_total_price": 32,
  "total_price": 32,
  "payment_status": "authorized",
  "payment_reference": "auth-unique-key-123",
  "status": "pending",
  "driver_id": null,
  "created_at": "2026-05-02T12:00:00.000Z",
  "updated_at": "2026-05-02T12:00:00.000Z"
}
```

**Idempotency replay request:**

```bash
curl -X POST http://order-service:8000/orders \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: unique-key-123" \
  -d '{
    "customer_id": "customer-1",
    "restaurant_id": "1",
    "items": [
      { "item_id": 1, "quantity": 2 },
      { "item_id": 3, "quantity": 1 }
    ]
  }'
```

**Example replay output (201):**

```json
{
  "id": 4,
  "customer_id": "customer-1",
  "restaurant_id": "1",
  "status": "pending",
  "total_price": 32
}
```

---

### GET /orders/:id

```
GET /orders/:id

  Returns one order.

  Path:
    id  integer  required

  Responses:
    200  Success
    404  Order not found
    500  Internal server error
```

**Example request:**

```bash
curl http://order-service:8000/orders/1
```

**Example output (200):**

```json
{
  "id": 1,
  "customer_id": "customer-1",
  "restaurant_id": "1",
  "items": [
    { "item_id": 1, "quantity": 2 },
    { "item_id": 3, "quantity": 1 }
  ],
  "base_total_price": 32,
  "total_price": 32,
  "payment_status": "captured",
  "payment_reference": "seed-payment-1",
  "status": "delivered",
  "driver_id": null,
  "created_at": "2026-05-02T12:00:00.000Z",
  "updated_at": "2026-05-02T12:00:00.000Z"
}
```

---

### PUT /orders/:id/status

```
PUT /orders/:id/status

  Updates order status. Workers and Driver Service use this to advance orders.

  Path:
    id  integer  required

  Body:
    status     string  required  one of confirmed, dispatched, ready,
                                 in_transit, delivered, failed
    driver_id  string  optional

  Responses:
    200  Status updated
    400  Invalid status
    404  Order not found
    500  Internal server error
```

**Example request:**

```bash
curl -X PUT http://order-service:8000/orders/1/status \
  -H "Content-Type: application/json" \
  -d '{ "status": "dispatched", "driver_id": "1" }'
```

**Example output (200):**

```json
{
  "id": 1,
  "customer_id": "customer-1",
  "restaurant_id": "1",
  "status": "dispatched",
  "driver_id": "1",
  "total_price": 32,
  "updated_at": "2026-05-02T12:00:00.000Z"
}
```

---

### GET /orders/:id/verify-completed

```
GET /orders/:id/verify-completed

  Returns whether an order has status delivered. Rating and Review Service
  calls this before accepting a rating.

  Path:
    id  integer  required

  Responses:
    200  Completion status returned
    404  Order not found
    500  Internal server error
```

**Example request:**

```bash
curl http://order-service:8000/orders/1/verify-completed
```

**Example output (200):**

```json
{
  "order_id": 1,
  "completed": true
}
```

---

## Driver Service

### GET /health

```
GET /health

  Returns the health status of the driver service and its PostgreSQL database.

  Responses:
    200  Service and database healthy
    503  Database unreachable
```

**Example request:**

```bash
curl http://driver-service:8000/health
```

**Example output (200):**

```json
{
  "status": "healthy",
  "service": "driver-service",
  "checks": {
    "database": { "status": "healthy" }
  }
}
```

---

### GET /drivers

```
GET /drivers

  Returns all drivers. Optionally filters by status.

  Query:
    status  string  optional  Free or Busy

  Responses:
    200  Success
    500  Internal server error
```

**Example requests:**

```bash
curl http://driver-service:8000/drivers
curl "http://driver-service:8000/drivers?status=Free"
```

**Example output (200):**

```json
{
  "drivers": [
    {
      "id": 1,
      "name": "Joe",
      "status": "Free",
      "location": "Boston",
      "distance_from_order": null
    }
  ]
}
```

---

### POST /assign

```
POST /assign

  Assigns the next free driver using a row lock so scaled driver-service-app
  replicas do not assign the same driver concurrently. If order_id is present,
  Driver Service also updates Order Service to status dispatched and records
  the assignment.

  Body:
    order_id  integer|string  optional

  Responses:
    200  Driver assigned
    404  No drivers available
    500  Assignment failed
```

**Example request:**

```bash
curl -X POST http://driver-service:8000/assign \
  -H "Content-Type: application/json" \
  -d '{ "order_id": 1 }'
```

**Example output (200):**

```json
{
  "id": 1,
  "name": "Joe",
  "status": "Busy",
  "location": "Boston",
  "distance_from_order": null
}
```

**Example output (404):**

```json
{
  "error": "no drivers available"
}
```

---

### PUT /drivers/:id/distance

```
PUT /drivers/:id/distance

  Updates a driver's distance from the order. If status is Free and order_id
  is provided, Driver Service marks the order delivered and completes the
  driver assignment record.

  Path:
    id  integer  required

  Body:
    distance_from_order  string  required
    status               string  optional  Free or Busy
    order_id             integer optional

  Responses:
    200  Driver updated
    400  Missing distance or invalid status
    404  Driver not found
    500  Update failed
```

**Example request:**

```bash
curl -X PUT http://driver-service:8000/drivers/1/distance \
  -H "Content-Type: application/json" \
  -d '{ "distance_from_order": "5km", "status": "Busy", "order_id": 1 }'
```

**Example output (200):**

```json
{
  "id": 1,
  "name": "Joe",
  "status": "Busy",
  "location": "Boston",
  "distance_from_order": "5km",
  "order_completed": false
}
```

**Example delivered request:**

```bash
curl -X PUT http://driver-service:8000/drivers/1/distance \
  -H "Content-Type: application/json" \
  -d '{ "distance_from_order": "0km", "status": "Free", "order_id": 1 }'
```

**Example delivered output (200):**

```json
{
  "id": 1,
  "name": "Joe",
  "status": "Free",
  "location": "Boston",
  "distance_from_order": "0km",
  "order_completed": true
}
```

---

### GET /drivers/:id

```
GET /drivers/:id

  Returns one driver.

  Path:
    id  integer  required

  Responses:
    200  Success
    404  Driver not found
    500  Internal server error
```

**Example request:**

```bash
curl http://driver-service:8000/drivers/1
```

**Example output (200):**

```json
{
  "id": 1,
  "name": "Joe",
  "status": "Free",
  "location": "Boston",
  "distance_from_order": null
}
```

---

### GET /drivers/:id/assignments

```
GET /drivers/:id/assignments

  Returns assignment history for one driver, newest first.

  Path:
    id  integer  required

  Responses:
    200  Success
    500  Internal server error
```

**Example request:**

```bash
curl http://driver-service:8000/drivers/1/assignments
```

**Example output (200):**

```json
{
  "assignments": [
    {
      "id": 1,
      "order_id": "1",
      "driver_id": 1,
      "assigned_at": "2026-05-02T12:00:00.000Z",
      "completed_at": null,
      "final_status": "assigned",
      "last_known_distance": null
    }
  ]
}
```

---

## Order Dispatch Worker

Consumes `queue:order_dispatch`, validates restaurants, calls Driver Service `/assign`, publishes `order_dispatched`, retries transient failures, and moves poison pills to `queue:order_dispatch:dlq`.

### GET /health

```
GET /health

  Returns worker health, Redis health, main queue depth, retry queue depth,
  DLQ depth, and last processed job timestamp.

  Responses:
    200  Worker healthy
    503  Redis unreachable
```

**Example request:**

```bash
curl http://order-dispatch-worker:8110/health
```

**Example output (200):**

```json
{
  "status": "healthy",
  "service": "order-dispatch-worker",
  "uptime_seconds": 120,
  "queue_depth": 0,
  "retry_queue_depth": 0,
  "dlq_depth": 0,
  "dead_letter_queue_depth": 0,
  "last_job_at": null,
  "checks": {
    "redis": { "status": "healthy" }
  }
}
```

---

## Preparation Tracker Worker

Subscribes to `order_dispatched`, queues prep work in `prep_queue`, publishes `order_ready`, and sends notification events.

### GET /health

```
GET /health

  Returns worker health, Redis health, prep queue depth, DLQ depth, and last
  processed job timestamp.

  Responses:
    200  Worker healthy
    503  Redis unreachable
```

**Example request:**

```bash
curl http://preparation-tracker-worker:8100/health
```

**Example output (200):**

```json
{
  "status": "healthy",
  "service": "preparation-tracker-worker",
  "uptime_seconds": 120,
  "queue_depth": 0,
  "dlq_depth": 0,
  "dead_letter_queue_depth": 0,
  "last_job_at": null,
  "checks": {
    "redis": { "status": "healthy" }
  }
}
```

---

## Delivery Tracker Service

Subscribes to `order_ready`, simulates delivery progress, updates driver distance, and completes orders when delivery reaches `0km`.

### GET /health

```
GET /health

  Returns service health and Redis health.

  Responses:
    200  Service healthy
    503  Redis unreachable
```

**Example request:**

```bash
curl http://delivery-tracker-service:8000/health
```

**Example output (200):**

```json
{
  "status": "healthy",
  "service": "delivery-tracker-service",
  "timestamp": "2026-05-02T12:00:00.000Z",
  "uptime_seconds": 120,
  "checks": {
    "redis": { "status": "healthy", "latency_ms": 1 }
  }
}
```

---

### GET /status/:orderId

```
GET /status/:orderId

  Polls delivery status for one order. If no driver is assigned yet, the
  response says delivery has not started. If a driver is assigned and the
  order is delivered, it reports completion. Otherwise it returns the driver's
  current status and distance.

  Path:
    orderId  integer  required

  Responses:
    200  Status returned
    400  Invalid order id
    404  Order not found
    502  Driver service unavailable
```

**Example request:**

```bash
curl http://delivery-tracker-service:8000/status/3
```

**Example output (200, no driver assigned yet):**

```json
{
  "order_id": 3,
  "order_status": "pending",
  "message": "no driver assigned yet"
}
```

**Example output (200, in progress):**

```json
{
  "order_id": 4,
  "order_status": "in_transit",
  "driver_id": 1,
  "driver_status": "Busy",
  "distance_from_order": "5km"
}
```

---

## Rating and Review Service

### GET /health

```
GET /health

  Returns the health status of the rating service and its dependencies
  (PostgreSQL and Redis).

  Responses:
    200  Service and all dependencies healthy
    503  One or more dependencies unreachable
```

**Example request:**

```bash
curl http://rating-and-review-service:8000/health
```

**Example output (200):**

```json
{
  "status": "healthy",
  "service": "rating-and-review-service",
  "timestamp": "2026-05-02T12:00:00.000Z",
  "uptime_seconds": 120,
  "checks": {
    "database": { "status": "healthy", "latency_ms": 2 },
    "redis": { "status": "healthy", "latency_ms": 1 }
  }
}
```

---

### POST /ratings

```
POST /ratings

  Submits a rating for a delivered order. The service calls
  GET /orders/:id/verify-completed before inserting the rating. Only one
  rating per order is allowed.

  Body:
    order_id       integer  required
    restaurant_id  integer  required
    customer_id    string   required
    score          integer  required, 1 through 5
    review_text    string   optional

  Responses:
    201  Rating created
    400  Missing fields, invalid score, or order not delivered
    404  Order not found
    409  Rating already exists for this order
    500  Internal server error
    503  Order service unavailable
```

**Example request:**

```bash
curl -X POST http://rating-and-review-service:8000/ratings \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": 1,
    "restaurant_id": 1,
    "customer_id": "customer-1",
    "score": 5,
    "review_text": "Amazing pizza, delivered hot!"
  }'
```

**Example output (201):**

```json
{
  "id": 4,
  "order_id": 4,
  "restaurant_id": 1,
  "customer_id": "customer-1",
  "score": 5,
  "review_text": "Amazing pizza, delivered hot!",
  "created_at": "2026-05-02T12:00:00.000Z"
}
```

**Example output (409, if the order was already rated):**

```json
{
  "error": "rating already exists for this order",
  "rating": {
    "id": 1,
    "order_id": 1,
    "restaurant_id": 1,
    "customer_id": "customer-1",
    "score": 5,
    "review_text": "Amazing pizza, delivered hot!",
    "created_at": "2026-05-02T12:00:00.000Z"
  }
}
```

> Note: the seed data already includes a rating for order `1`, so this exact
> seeded example may return `409` after a fresh start. To create a new rating,
> create a new order, mark it delivered with `PUT /orders/:id/status`, then post
> the rating for that new order id.

---

### GET /ratings/restaurant/:id

```
GET /ratings/restaurant/:id

  Returns all ratings for a restaurant, plus average score and total count.
  Results are cached in Redis for 60 seconds.

  Path:
    id  integer  required

  Responses:
    200  Success
    500  Internal server error
```

**Example request:**

```bash
curl http://rating-and-review-service:8000/ratings/restaurant/1
```

**Example output (200):**

```json
{
  "restaurant_id": 1,
  "average_score": 4.5,
  "total_ratings": 2,
  "ratings": [
    {
      "id": 1,
      "order_id": 1,
      "restaurant_id": 1,
      "customer_id": "customer-1",
      "score": 5,
      "review_text": "Amazing pizza, delivered hot!",
      "created_at": "2026-05-02T12:00:00.000Z"
    }
  ]
}
```

---

### GET /rankings

```
GET /rankings

  Returns restaurants ranked by average rating score, highest first.
  Results are cached in Redis for 60 seconds.

  Responses:
    200  Success
    500  Internal server error
```

**Example request:**

```bash
curl http://rating-and-review-service:8000/rankings
```

**Example output (200):**

```json
{
  "rankings": [
    {
      "restaurant_id": 2,
      "total_ratings": 1,
      "average_score": "5.00"
    },
    {
      "restaurant_id": 1,
      "total_ratings": 2,
      "average_score": "4.50"
    }
  ]
}
```

---

## Surge Pricing Worker

Consumes `queue:surge_pricing`. When a restaurant reaches the configured order threshold inside the configured sliding window, the worker writes a surge multiplier to Redis and records the period in the pricing database. Restaurant Service reads that Redis multiplier in `/restaurants/:id/menu`.

### GET /health

```
GET /health

  Returns worker health, Redis health, pricing database health, queue depth,
  DLQ depth, and last processed job timestamp.

  Responses:
    200  Worker healthy
    503  Redis or database unreachable
```

**Example request:**

```bash
curl http://surge-pricing-worker:8200/health
```

**Example output (200):**

```json
{
  "status": "healthy",
  "service": "surge-pricing-worker",
  "timestamp": "2026-05-02T12:00:00.000Z",
  "uptime_seconds": 120,
  "queue_depth": 0,
  "dlq_depth": 0,
  "last_job_at": null,
  "checks": {
    "redis": { "status": "healthy" },
    "database": { "status": "healthy", "latency_ms": 2 }
  }
}
```

### How to Verify It Is Working

1. Watch worker health and queue metrics:

```bash
curl http://surge-pricing-worker:8200/health
```

2. Generate multiple orders for the same restaurant so the worker sees enough
   volume to cross the configured surge threshold.

3. Confirm the worker stays healthy and that `last_job_at` advances while
   `dlq_depth` remains low or zero for valid traffic.

4. Re-fetch the restaurant menu and confirm the response includes the current
   `surge_multiplier` and updated prices when surge is active:

```bash
curl http://restaurant-service:8000/restaurants/1/menu
```

5. If needed, inspect logs from the worker for surge activation messages:

```bash
docker compose logs -f surge-pricing-worker
```

---

## Notification Worker

Consumes `queue:notifications`, deduplicates events in Redis, logs valid notification messages, and moves malformed messages to `queue:notifications:dlq`.

### GET /health

```
GET /health

  Returns worker health, Redis health, notification queue depth, DLQ depth,
  and last processed job timestamp.

  Responses:
    200  Worker healthy
    503  Redis unreachable
```

**Example request:**

```bash
curl http://notification-worker:8000/health
```

**Example output (200):**

```json
{
  "status": "healthy",
  "service": "notification-worker",
  "uptime_seconds": 120,
  "queue_depth": 0,
  "dlq_depth": 0,
  "dead_letter_queue_depth": 0,
  "last_job_at": null,
  "checks": {
    "redis": { "status": "healthy" }
  }
}
```

---

## k6 Tests

Run k6 after the system is healthy. These commands execute k6 inside Holmes.

### Sprint 1 baseline

```bash
docker compose exec holmes k6 run /workspace/k6/sprint-1.js
```

### Sprint 2 cache comparison

Run with the default cache enabled:

```bash
docker compose exec holmes k6 run /workspace/k6/sprint-2-cache.js
```

Run again with Restaurant Service cache disabled:

```bash
docker compose down -v
CACHE_ENABLED=false docker compose up --build
docker compose exec holmes k6 run /workspace/k6/sprint-2-cache.js
```

### Sprint 2 async pipeline and idempotency

```bash
docker compose exec holmes k6 run /workspace/k6/sprint-2-async.js
```

### Sprint 3 happy-path baseline

```bash
docker compose exec holmes k6 run /workspace/k6/sprint-3-poison-baseline.js
```

### Sprint 3 order dispatch poison-pill resilience

```bash
docker compose exec holmes k6 run /workspace/k6/sprint-3-poison.js
```

### Sprint 3 notification poison-pill resilience

```bash
docker compose exec holmes k6 run /workspace/k6/sprint-3-notification-poison.js
```

Useful post-test checks:

```bash
docker compose exec holmes curl http://order-dispatch-worker:8110/health
docker compose exec holmes curl http://preparation-tracker-worker:8100/health
docker compose exec holmes curl http://notification-worker:8000/health
docker compose exec holmes curl http://surge-pricing-worker:8200/health
```

---

## Sprint History

| Sprint | Plan | Report |
| --- | --- | --- |
| 1 | [SPRINT-1-PLAN.md](sprint-plans/SPRINT-1-PLAN.md) | [SPRINT-1.md](sprint-reports/SPRINT-1.md) |
| 2 | [SPRINT-2-PLAN.md](sprint-plans/SPRINT-2-PLAN.md) | [SPRINT-2.md](sprint-reports/SPRINT-2.md) |
| 3 | [SPRINT-3-PLAN.md](sprint-plans/SPRINT-3-PLAN.md) | [SPRINT-3.md](sprint-reports/SPRINT-3.md) |
| 4 | [SPRINT-4-PLAN.md](sprint-plans/SPRINT-4-PLAN.md) | [SPRINT-4.md](sprint-reports/SPRINT-4.md) |
