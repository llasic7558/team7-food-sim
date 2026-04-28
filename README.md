# Team 7 — Food Delivery Coordination

**Course:** COMPSCI 426  
**Team:** [Dev, Emily and Kanika], [Beatrice and Raymond], [Shao and Luka]  
**System:** Food Delivery Coordination  
**Repository:** [GitHub URL]

---

## Team and Service Ownership

| Team Member | Services / Components Owned                          |
| ----------- | ---------------------------------------------------- |
| [Dev, Emily and Kanika]      | `restaurant-service/`, `restaurant-service/db/`      |
| [Beatrice, Rishi and Raymond]      | `order-service/`, `order-service/db/`                |
| [Shao and Luka]      | `driver-service/`, `compose.yml`, `k6/`, `README.md` |

> Ownership is verified by `git log --author`. Each person must have meaningful commits in the directories they claim.

---

## How to Start the System

```bash
# Start everything (builds images on first run)
docker compose up --build

# Verify all services are healthy
docker compose ps

# Stream logs
docker compose logs -f

# Open a shell in the holmes investigation container
docker compose exec holmes bash
```

For a full reset that removes containers, networks, and named volumes before
bringing the stack back up:

```bash
docker compose down -v --remove-orphans
docker compose up --build
```

The seeded driver database starts with 10 free drivers so the async order
pipeline and k6 load tests have enough headroom for throughput experiments.

### Base URLs (from Holmes)

```
restaurant-service           http://restaurant-service:8000
order-service                http://order-service:8000
driver-service               http://driver-service:8000
order-dispatch-worker        http://order-dispatch-worker:8110   (health endpoint only)
preparation-tracker-worker   http://preparation-tracker-worker:8100   (health endpoint only)
delivery-tracker-service     http://delivery-tracker-service:8000
notification-worker          http://notification-worker:8000   (health endpoint only)
rating-and-review-service    http://rating-and-review-service:8000
surge-pricing-worker         http://surge-pricing-worker:8200   (health endpoint only)
```

> From inside Holmes, services are reachable by name:
> `curl http://restaurant-service:8000/health | jq .`
>
> See [holmes/README.md](holmes/README.md) for a full tool reference.

---

## System Overview

Users place food delivery orders from local restaurants. The **Order Service**
accepts incoming orders, validates menus against the **Restaurant Service**,
persists the order, and fans work out through Redis queues and pub/sub.

The current async pipeline is:

1. `POST /orders` writes an order and enqueues work to `queue:order_dispatch`,
   `queue:surge_pricing`, and `queue:notifications`.
2. **Order Dispatch Worker** consumes `queue:order_dispatch`, validates the
   restaurant, asks **Driver Service** for an assignment, retries transient
   failures with exponential backoff, and publishes `order_dispatched`.
3. **Preparation Tracker Worker** subscribes to `order_dispatched`, simulates
   kitchen preparation, publishes `order_ready`, and queues an `order_ready`
   notification.
4. **Delivery Tracker Service** subscribes to `order_ready`, simulates delivery
   stages, updates driver distance / completion, and queues additional delivery
   notifications.
5. **Notification Worker** consumes `queue:notifications`, deduplicates events,
   and moves malformed messages directly to its DLQ.
6. **Surge Pricing Worker** consumes `queue:surge_pricing`, detects bursts in
   restaurant demand, records surge windows, and exposes health / DLQ metrics.

Each service or worker exposes a `/health` endpoint. Queue-based workers expose
`queue_depth`, `dlq_depth`, and related metrics so we can observe poison pill
handling and retry behavior during load tests.

## Service Inventory

| Service | Port | Backing Store | Purpose |
| ------- | ---- | ------------- | ------- |
| `restaurant-service` | `8000` | Postgres + Redis | Restaurant metadata, menus, menu caching, surge multiplier reads |
| `order-service` | `8000` | Postgres + Redis | Order creation, idempotency, validation, queue fan-out |
| `driver-service` | `8000` | Postgres | Driver state, assignment, delivery completion updates |
| `order-dispatch-worker` | `8110` | Redis | Dispatch queue consumer with retries and DLQ |
| `preparation-tracker-worker` | `8100` | Redis | Prep queue worker and `order_ready` publisher |
| `delivery-tracker-service` | `8000` | Redis | Delivery progress simulation and status lookup |
| `notification-worker` | `8000` | Redis | Notification queue consumer with direct DLQ handling |
| `rating-and-review-service` | `8000` | Postgres + Redis | Ratings, review submission, rankings, caching |
| `surge-pricing-worker` | `8200` | Postgres + Redis | Surge detection, pricing windows, DLQ metrics |

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

**Example response (200):**

```json
{
  "status": "healthy",
  "service": "restaurant-service",
  "timestamp": "2026-04-07T10:23:01.000Z",
  "uptime_seconds": 3612,
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

  Returns a list of all restaurants, ordered by name. Every request hits
  the database (no caching in Sprint 1).

  Responses:
    200  Success — returns list of restaurants
    500  Internal server error
```

**Example request:**

```bash
curl http://restaurant-service:8000/restaurants
```

**Example response (200):**

```json
{
  "restaurants": [
    {
      "id": 1,
      "name": "Bella Italia",
      "cuisine": "Italian",
      "address": "123 Main St",
      "rating": "4.5"
    }
  ]
}
```

---

### GET /restaurants/search

```
GET /restaurants/search

  Search restaurants by name (case-insensitive partial match).

  Query:
    name  string  required  Search term

  Responses:
    200  Success — returns matching restaurants
    400  Missing name query parameter
    500  Internal server error
```

**Example request:**

```bash
curl "http://restaurant-service:8000/restaurants/search?name=bella"
```

**Example response (200):**

```json
{
  "restaurants": [
    {
      "id": 1,
      "name": "Bella Italia",
      "cuisine": "Italian",
      "address": "123 Main St",
      "rating": "4.5"
    }
  ]
}
```

---

### GET /restaurants/:id

```
GET /restaurants/:id

  Returns full detail for a single restaurant.

  Path:
    id  integer  The restaurant's ID

  Responses:
    200  Success — returns restaurant detail
    404  No restaurant found with that ID
    500  Internal server error
```

**Example request:**

```bash
curl http://restaurant-service:8000/restaurants/1
```

**Example response (200):**

```json
{
  "id": 1,
  "name": "Bella Italia",
  "cuisine": "Italian",
  "address": "123 Main St",
  "rating": "4.5"
}
```

**Example response (404):**

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

  Returns all menu items for a restaurant. Results are cached in Redis
  for 5 minutes; subsequent requests for the same restaurant skip the
  database until the cache expires.

  Path:
    id  integer  The restaurant's ID

  Responses:
    200  Success — returns list of menu items
    404  Restaurant not found
    500  Internal server error
```

**Example request:**

```bash
curl http://restaurant-service:8000/restaurants/1/menu
```

**Example response (200):**

```json
{
  "restaurant_id": "1",
  "items": [
    {
      "id": 1,
      "restaurant_id": 1,
      "name": "Margherita Pizza",
      "description": "Classic tomato and mozzarella",
      "price": "12.00",
      "available": true
    }
  ]
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

**Example response (200):**

```json
{
  "status": "healthy",
  "service": "order-service",
  "timestamp": "2026-04-07T10:23:01.000Z",
  "uptime_seconds": 109,
  "checks": {
    "database": { "status": "healthy", "latency_ms": 2 },
    "redis": { "status": "healthy", "latency_ms": 1 }
  }
}
```

---

### POST /orders

```
POST /orders

  Creates a new order. Validates the restaurant and menu items by making a
  synchronous HTTP call to the Restaurant Service before creating the order.
  Calculates total price from menu prices (including any surge multiplier).

  Headers:
    X-Idempotency-Key  string  required  Unique key to prevent duplicate orders

  Body:
    restaurant_id  string   required  ID of the restaurant
    customer_id    string   required  ID of the customer
    items          array    required  List of order items
    items[].item_id   integer  required  ID of the menu item
    items[].quantity  integer  optional  default=1  Number to order

  Responses:
    201  Order created successfully
    200  Duplicate request — returns existing order for this idempotency key
    400  Missing or invalid fields, or missing X-Idempotency-Key header
    422  Invalid menu items or restaurant not found
    500  Internal server error
```

**Example request:**

```bash
curl -X POST http://order-service:8000/orders \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: unique-key-123" \
  -d '{
    "restaurant_id": "1",
    "customer_id": "customer-1",
    "items": [
      { "item_id": 1, "quantity": 2 },
      { "item_id": 3, "quantity": 1 }
    ]
  }'
```

**Example response (201):**

```json
{
  "id": 1,
  "idempotency_key": "unique-key-123",
  "customer_id": "customer-1",
  "restaurant_id": "1",
  "items": [
    { "item_id": 1, "quantity": 2 },
    { "item_id": 3, "quantity": 1 }
  ],
  "total_price": 32,
  "status": "pending",
  "driver_id": null,
  "created_at": "2026-04-07T10:23:01.000Z",
  "updated_at": "2026-04-07T10:23:01.000Z"
}
```

---

### GET /orders

```
GET /orders

  Returns all orders, most recent first. Supports optional filters.

  Query:
    customer_id  string  optional  Filter by customer ID
    status       string  optional  Filter by order status

  Responses:
    200  Success — returns list of orders
    500  Internal server error
```

**Example request:**

```bash
curl http://order-service:8000/orders
curl "http://order-service:8000/orders?customer_id=customer-1&status=delivered"
```

---

### GET /orders/:id

```
GET /orders/:id

  Returns a single order.

  Path:
    id  integer  The order's ID

  Responses:
    200  Success — returns order
    404  Order not found
    500  Internal server error
```

**Example request:**

```bash
curl http://order-service:8000/orders/1
```

---

### PUT /orders/:id/status

```
PUT /orders/:id/status

  Updates the status of an order. Used internally by workers to advance
  order state.

  Body:
    status     string  required  New status (confirmed, dispatched, ready, in_transit, delivered, failed)
    driver_id  string  optional  Driver assigned to the order

  Responses:
    200  Status updated successfully
    400  Invalid status value
    404  Order not found
    500  Internal server error
```

**Example request:**

```bash
curl -X PUT http://order-service:8000/orders/1/status \
  -H "Content-Type: application/json" \
  -d '{ "status": "dispatched", "driver_id": "driver-1" }'
```

---

### GET /orders/:id/verify-completed

```
GET /orders/:id/verify-completed

  Checks whether an order has been delivered. Used by the Rating & Review
  Service to confirm delivery before accepting a rating.

  Path:
    id  integer  The order's ID

  Responses:
    200  Returns completion status
    404  Order not found
    500  Internal server error
```

**Example request:**

```bash
curl http://order-service:8000/orders/1/verify-completed
```

**Example response (200):**

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

  Returns the health status of the driver service and its database connection.

  Responses:
    200  Service and database healthy
    503  Database unreachable
```

**Example request:**

```bash
curl http://driver-service:8000/health
```

**Example response (200):**

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

  Returns all drivers. Optionally filter by status.

  Query:
    status  string  optional  Filter by driver status (Free, Busy)

  Responses:
    200  Success — returns list of drivers
    500  Internal server error
```

**Example request:**

```bash
curl http://driver-service:8000/drivers
curl "http://driver-service:8000/drivers?status=Free"
```

**Example response (200):**

```json
{
  "drivers": [
    {
      "id": 1,
      "name": "Joe",
      "status": "Free",
      "location": "Boston"
    }
  ]
}
```

---

### POST /assign

```
POST /assign

  Internal dispatch endpoint used by the order-dispatch-worker. Finds a free
  driver, marks them Busy, and updates the order status to dispatched.

  Body:
    order_id  integer|string  optional  Order being assigned

  Responses:
    200  Driver assigned
    404  No free drivers available
    500  Internal server error
```

**Example request:**

```bash
curl -X POST http://driver-service:8000/assign \
  -H "Content-Type: application/json" \
  -d '{"order_id": 12}'
```

---

### PUT /drivers/:id/distance

```
PUT /drivers/:id/distance

  Updates a driver's delivery distance. When status is set back to Free and an
  order_id is provided, the order is marked delivered and the assignment record
  is completed.

  Body:
    distance_from_order  string  required  Human-readable distance
    status               string  optional  Free or Busy
    order_id             integer optional  Delivery being completed

  Responses:
    200  Driver updated
    400  Invalid payload
    404  Driver not found
    500  Internal server error
```

---

### GET /drivers/:id

```
GET /drivers/:id

  Returns one driver record by ID.

  Responses:
    200  Driver found
    404  Driver not found
    500  Internal server error
```

---

### GET /drivers/:id/assignments

```
GET /drivers/:id/assignments

  Returns assignment history for a driver in reverse chronological order.

  Responses:
    200  Assignment history returned
    500  Internal server error
```

---

## Order Dispatch Worker

Consumes `queue:order_dispatch`. Known poison pills such as malformed JSON,
missing fields, or nonexistent restaurants go directly to
`queue:order_dispatch:dlq`. Transient failures such as downstream service
errors or no drivers available are retried through `queue:order_dispatch:retry`
with exponential backoff before eventually reaching the DLQ if retries are
exhausted.

### GET /health

```
GET /health

  Returns worker health plus queue metrics for the main queue, retry queue, and
  dead letter queue.

  Responses:
    200  Worker healthy
    503  Redis unreachable
```

**Example response (200):**

```json
{
  "status": "healthy",
  "service": "order-dispatch-worker",
  "queue_depth": 0,
  "retry_queue_depth": 0,
  "dlq_depth": 0,
  "dead_letter_queue_depth": 0,
  "last_job_at": "2026-04-28T13:33:03.257Z",
  "checks": {
    "redis": { "status": "healthy" }
  }
}
```

---

## Preparation Tracker Worker

Subscribes to `order_dispatched`, mirrors jobs into `prep_queue` for depth
tracking, simulates kitchen prep, publishes `order_ready`, and queues
notification events. Failed prep jobs are moved to `prep_dlq`.

### GET /health

```
GET /health

  Returns worker health plus prep queue and DLQ metrics.

  Responses:
    200  Worker healthy
    503  Redis unreachable
```

---

## Delivery Tracker Service

Subscribes to `order_ready`, simulates delivery stages, updates the driver
service, and emits notification events for `picked_up`, `in_transit`, `nearby`,
and `delivered`.

### GET /health

```
GET /health

  Returns the Redis health for the delivery tracker service.

  Responses:
    200  Service healthy
    503  Redis unreachable
```

### GET /status/:orderId

```
GET /status/:orderId

  Returns the live delivery status for an order. If the order is complete, the
  response indicates which driver delivered it.

  Responses:
    200  Delivery status returned
    400  Invalid order ID
    404  Order not found
    502  Driver service unavailable
```

---

## Notification Worker

Consumes `queue:notifications`, deduplicates repeated events with Redis keys,
formats log-friendly notification messages, and moves malformed payloads
directly to `queue:notifications:dlq`. Unlike order dispatch, this worker does
not use a retry queue; poison pills go straight to the DLQ.

### GET /health

```
GET /health

  Returns worker health plus notification queue and DLQ metrics.

  Responses:
    200  Worker healthy
    503  Redis unreachable
```

**Example response (200):**

```json
{
  "status": "healthy",
  "service": "notification-worker",
  "queue_depth": 0,
  "dlq_depth": 0,
  "dead_letter_queue_depth": 0,
  "last_job_at": "2026-04-28T13:34:09.034Z",
  "checks": {
    "redis": { "status": "healthy" }
  }
}
```

---

## Rating & Review Service

### GET /health

```
GET /health

  Returns the health status of the rating and review service and its
  dependencies (PostgreSQL and Redis).

  Responses:
    200  Service and all dependencies healthy
    503  One or more dependencies unreachable
```

**Example request:**

```bash
curl http://rating-and-review-service:8000/health
```

**Example response (200):**

```json
{
  "status": "healthy",
  "service": "rating-and-review-service",
  "timestamp": "2026-04-14T10:23:01.000Z",
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

  Submits a rating for a delivered order. Validates that the order exists and
  has been delivered by making a synchronous HTTP call to the Order Service
  (GET /orders/:id/verify-completed). Only one rating per order is allowed.

  Body:
    order_id       integer  required  ID of the delivered order
    restaurant_id  integer  required  ID of the restaurant
    customer_id    string   required  ID of the customer
    score          integer  required  Rating score, 1–5
    review_text    string   optional  Written review

  Responses:
    201  Rating created successfully
    400  Missing or invalid fields, or order not yet delivered
    404  Order not found
    409  Rating already exists for this order
    503  Order service unavailable
    500  Internal server error
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

**Example response (201):**

```json
{
  "id": 1,
  "order_id": 1,
  "restaurant_id": 1,
  "customer_id": "customer-1",
  "score": 5,
  "review_text": "Amazing pizza, delivered hot!",
  "created_at": "2026-04-14T10:23:01.000Z"
}
```

**Example response (400 — order not delivered):**

```json
{
  "error": "order has not been delivered yet",
  "order_id": 1
}
```

**Example response (409 — duplicate):**

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
    "created_at": "2026-04-14T10:23:01.000Z"
  }
}
```

---

### GET /ratings/restaurant/:id

```
GET /ratings/restaurant/:id

  Returns all ratings for a restaurant with the average score and total count.
  Served from Redis cache when available; cache expires after 60 seconds.

  Path:
    id  integer  The restaurant's ID

  Responses:
    200  Success — returns ratings with average
    500  Internal server error
```

**Example request:**

```bash
curl http://rating-and-review-service:8000/ratings/restaurant/1
```

**Example response (200):**

```json
{
  "restaurant_id": 1,
  "average_score": 4.5,
  "total_ratings": 2,
  "ratings": [
    {
      "id": 2,
      "order_id": 2,
      "restaurant_id": 1,
      "customer_id": "customer-2",
      "score": 4,
      "review_text": "Great pasta, slightly late delivery",
      "created_at": "2026-04-14T10:25:00.000Z"
    },
    {
      "id": 1,
      "order_id": 1,
      "restaurant_id": 1,
      "customer_id": "customer-1",
      "score": 5,
      "review_text": "Amazing pizza, delivered hot!",
      "created_at": "2026-04-14T10:23:01.000Z"
    }
  ]
}
```

---

### GET /rankings

```
GET /rankings

  Returns all restaurants ranked by average rating score (highest first).
  Served from Redis cache when available; cache expires after 60 seconds.

  Responses:
    200  Success — returns ranked list of restaurants
    500  Internal server error
```

**Example request:**

```bash
curl http://rating-and-review-service:8000/rankings
```

**Example response (200):**

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

Consumes order volume events from the `queue:surge_pricing` Redis queue. When
the order rate for a restaurant exceeds a configurable threshold within a sliding
time window, publishes a "surge active" event on Redis pub/sub and writes the
surge period and multiplier to the pricing database. The Restaurant Service reads
the surge multiplier from Redis and attaches a surge fee to affected menus.
Malformed or invalid messages are moved to `queue:surge_pricing:dlq`.

### GET /health

```
GET /health

  Returns 200 when Redis and the pricing database are reachable and the worker
  is processing jobs. Returns 503 if either dependency is down.

  Responses:
    200  Worker healthy
    503  Redis or database unreachable
```

**Example request:**

```bash
curl http://surge-pricing-worker:8200/health
```

**Example response (200):**

```json
{
  "status": "healthy",
  "service": "surge-pricing-worker",
  "timestamp": "2026-04-07T12:00:00.000Z",
  "uptime_seconds": 300,
  "queue_depth": 0,
  "dlq_depth": 0,
  "last_job_at": "2026-04-07T11:59:45.000Z",
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

## Load Testing

All load-test scripts live in [`k6/`](k6/).
Run them from inside Holmes:

```bash
docker compose exec holmes bash
```

Available scripts:

| Script | Purpose |
| ------ | ------- |
| `k6/sprint-1.js` | Baseline read traffic |
| `k6/sprint-2-cache.js` | Restaurant menu cache comparison |
| `k6/sprint-2-async.js` | Async order pipeline burst |
| `k6/sprint-3-poison.js` | Order-dispatch poison-pill resilience with retries |
| `k6/sprint-3-poison-baseline.js` | Normal-only baseline for the Sprint 3 dispatch comparison |
| `k6/sprint-3-notification-poison.js` | Notification-worker poison-pill handling without retries |

Sprint 1 example:

```bash
k6 run /workspace/k6/sprint-1.js
```

Sprint 2 examples:

```bash
# Cache comparison
k6 run /workspace/k6/sprint-2-cache.js

# Async pipeline burst
k6 run /workspace/k6/sprint-2-async.js
```

Sprint 3 examples:

```bash
# Dispatch worker poison-pill test
k6 run /workspace/k6/sprint-3-poison.js

# Matching normal-only baseline
k6 run /workspace/k6/sprint-3-poison-baseline.js

# Notification-worker poison-pill comparison
k6 run /workspace/k6/sprint-3-notification-poison.js
```

The dispatch poison test is expected to show:

- Normal `POST /orders` requests still return `201`
- `order-dispatch-worker` stays healthy throughout
- `dlq_depth` increases after poison pills are injected
- `retry_queue_depth` may also grow because real orders can retry when no
  driver is immediately available

The notification poison test is expected to show:

- Normal `POST /orders` requests still return `201`
- `notification-worker` stays healthy throughout
- Poison messages go directly to `queue:notifications:dlq`
- There is no retry queue in this worker path

## Sprint History

| Sprint | Tag        | Plan                                              | Report                                    |
| ------ | ---------- | ------------------------------------------------- | ----------------------------------------- |
| 1      | `sprint-1` | [SPRINT-1-PLAN.md](sprint-plans/SPRINT-1-PLAN.md) | [SPRINT-1.md](sprint-reports/SPRINT-1.md) |
| 2      | `sprint-2` | [SPRINT-2-PLAN.md](sprint-plans/SPRINT-2-PLAN.md) | [SPRINT-2.md](sprint-reports/SPRINT-2.md) |
| 3      | `sprint-3` | [SPRINT-3-PLAN.md](sprint-plans/SPRINT-3-PLAN.md) | [SPRINT-3.md](sprint-reports/SPRINT-3.md) |
| 4      | `sprint-4` | [SPRINT-4-PLAN.md](sprint-plans/SPRINT-4-PLAN.md) | [SPRINT-4.md](sprint-reports/SPRINT-4.md) |
