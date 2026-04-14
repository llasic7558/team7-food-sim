# Order Service: Python to Node.js Rewrite

## Overview

Rewrite the order-service from Python (Flask/SQLAlchemy/gunicorn) to Node.js (Express/pg/redis) to match the pattern used by all other services in the system (restaurant-service, delivery-tracker-service, rating-and-review-service).

## Motivation

The order-service is the only Python service among the core services. This inconsistency creates friction for development and maintenance. All other services use Node.js/Express with the `pg` driver and `redis` client.

## File Structure

```
order-service/
├── Dockerfile          (rewrite: node:20-alpine)
├── package.json        (add express, pg, redis deps)
├── src/
│   ├── index.js        (Express app with all routes)
│   └── db.js           (pg Pool wrapper)
└── db/
    ├── schema.sql      (CREATE TABLE orders)
    └── seed.sql        (empty/placeholder)
```

## Files to Delete

- `app.py`
- `models.py`
- `db.py`
- `requirements.txt`

## Database Schema

Derived from the existing SQLAlchemy model in `models.py`:

```sql
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  idempotency_key VARCHAR(128) UNIQUE NOT NULL,
  customer_id     VARCHAR(64) NOT NULL,
  restaurant_id   VARCHAR(64) NOT NULL,
  items           JSONB NOT NULL,
  total_price     NUMERIC(10,2) NOT NULL,
  status          VARCHAR(32) NOT NULL DEFAULT 'pending',
  driver_id       VARCHAR(64),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_idempotency_key ON orders(idempotency_key);
```

## Endpoints

All endpoints preserve identical request/response contracts.

### GET /health
- Checks database (`SELECT 1`) and Redis (`PING`) connectivity
- Returns `{ status, service, timestamp, uptime_seconds, checks }` with latency
- 200 if healthy, 503 if not

### GET /orders
- Query params: `?customer_id=`, `?status=` (both optional)
- Returns `[{ id, idempotency_key, customer_id, restaurant_id, items, total_price, status, driver_id, created_at, updated_at }]`
- Ordered by `created_at DESC`

### POST /orders
- Requires `X-Idempotency-Key` header (400 if missing)
- If idempotency key already exists, returns existing order with 200
- Body: `{ customer_id, restaurant_id, items }` (400 if missing fields)
- Validates items against restaurant-service menu (`GET /restaurants/:id/menu`)
- Calculates total price with surge multiplier
- On success: inserts order, pushes to `queue:order_dispatch` and `queue:notifications`
- Returns created order with 201
- Race condition on idempotency: catches unique constraint violation, returns existing order with 200

### GET /orders/:id
- Returns single order or 404

### PUT /orders/:id/status
- Body: `{ status, driver_id? }`
- Valid statuses: confirmed, dispatched, ready, in_transit, delivered, failed
- Updates status and `updated_at`, optionally sets `driver_id`
- Pushes notification to `queue:notifications`
- Returns updated order

### GET /orders/:id/verify-completed
- Returns `{ order_id, completed: bool }` where completed = (status === 'delivered')

## Key Behaviors

### Idempotency
- `X-Idempotency-Key` header required on POST /orders
- Check before insert, catch unique constraint on race

### Menu Validation
- `fetch` to `${RESTAURANT_SERVICE_URL}/restaurants/${restaurant_id}/menu`
- Normalize item keys: menu items may use `id` or `item_id`; line items may use `item_id`, `menu_item_id`, or `id`
- Apply `surge_multiplier` from response body

### Redis Queues
- `queue:order_dispatch`: RPUSH on order creation
- `queue:notifications`: LPUSH on status changes and order creation

### Response Format
- `total_price` returned as float (parseFloat)
- Timestamps returned as ISO strings

## Environment Variables (unchanged)

- `DATABASE_URL`: `postgres://app:secret@order-db:5432/orders`
- `REDIS_URL`: `redis://redis:6379`
- `RESTAURANT_SERVICE_URL`: `http://restaurant-service:8000`
- `SERVICE_NAME`: `order-service`
- `PORT`: `8000`

## No Changes Required

- `compose.yml` (same ports, env vars, healthcheck, depends_on)
- `order-db` service and its init scripts
- Workers that interact with order-service (they use HTTP + Redis queues, both unchanged)
