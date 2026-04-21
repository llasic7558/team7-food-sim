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

### Base URLs (from Holmes)

```
restaurant-service           http://restaurant-service:8000
order-service                http://order-service:8000
driver-service               http://driver-service:8000
rating-and-review-service    http://rating-and-review-service:8000
```

> From inside Holmes, services are reachable by name:
> `curl http://restaurant-service:8000/health | jq .`
>
> See [holmes/README.md](holmes/README.md) for a full tool reference.

---

## System Overview

Users place food delivery orders from local restaurants. The **Order Service** accepts incoming orders and validates each order's restaurant and menu items by making a synchronous HTTP call to the **Restaurant Service**. The **Restaurant Service** manages restaurant profiles, menus, and availability, backed by its own PostgreSQL database. The **Driver Service** tracks driver availability and location in a separate PostgreSQL database. A shared Redis instance is connected to all services for future caching and queue support. Each service exposes a `/health` endpoint that checks its database and Redis connections.

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

## Sprint History

| Sprint | Tag        | Plan                                              | Report                                    |
| ------ | ---------- | ------------------------------------------------- | ----------------------------------------- |
| 1      | `sprint-1` | [SPRINT-1-PLAN.md](sprint-plans/SPRINT-1-PLAN.md) | [SPRINT-1.md](sprint-reports/SPRINT-1.md) |
| 2      | `sprint-2` | [SPRINT-2-PLAN.md](sprint-plans/SPRINT-2-PLAN.md) | [SPRINT-2.md](sprint-reports/SPRINT-2.md) |
| 3      | `sprint-3` | [SPRINT-3-PLAN.md](sprint-plans/SPRINT-3-PLAN.md) | [SPRINT-3.md](sprint-reports/SPRINT-3.md) |
| 4      | `sprint-4` | [SPRINT-4-PLAN.md](sprint-plans/SPRINT-4-PLAN.md) | [SPRINT-4.md](sprint-reports/SPRINT-4.md) |
