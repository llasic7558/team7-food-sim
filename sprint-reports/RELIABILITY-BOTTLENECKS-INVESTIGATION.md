# Reliability and Bottlenecks Investigation

Date: 2026-04-24

## Live System Snapshot

- `docker compose ps` shows the wired services are up and healthy.
- Live worker health shows:
  - `order-dispatch-worker`: `queue_depth=0`, `dlq_depth=1504`
  - `preparation-tracker-worker`: `queue_depth=0`, `dlq_depth=0`
- Live order counts show:
  - `pending=1505`
  - `delivered=31`
  - `in_transit=1`
- Live driver counts show:
  - `Free=2`
  - `Busy=1`

Interpretation:
- The main bottleneck is not a growing dispatch queue.
- The system is accepting orders quickly, but many orders are being dropped into the dispatch DLQ when drivers are unavailable.
- Those orders remain `pending` forever because there is no retry or compensation path.

## Highest-Impact Current Bottlenecks

### 1. Dispatch failure on driver exhaustion

Evidence:
- Live DLQ sample contains repeated `driver_assign_failed` records with `404 {"error":"no drivers available"}`.
- Driver seed data only creates 3 drivers, and one starts `Busy`.
- Dispatch worker sends any driver assignment failure directly to DLQ.

Why this matters:
- This is the main live throughput limiter right now.
- Capacity is bounded by a tiny driver pool, and transient capacity shortage is treated as a terminal failure.
- Orders accumulate as `pending` rows with no recovery path.

Priority fix:
- Treat `no drivers available` as retryable, not poison-pill behavior.
- Requeue with backoff or move to a retry queue instead of DLQ.
- Mark truly exhausted jobs as `failed` in `order-service` if retries are abandoned.

### 2. Unbounded order listing path

Evidence:
- `GET /orders` returns the full dataset ordered by `created_at DESC`.
- There are already 1537 orders in the live system, 1505 of them pending.
- The orders table has no secondary indexes.

Why this matters:
- This path gets slower as the table grows.
- It inflates response size and pushes extra serialization work onto the API.
- The Sprint 2 report already showed `GET /orders` becoming one of the slowest endpoints.

Priority fix:
- Add pagination and default limits to `GET /orders`.
- Add indexes for `status`, `customer_id`, and `created_at`.

### 3. Single-worker prep throughput

Evidence:
- `preparation-tracker-worker` processes one job at a time and sleeps 2-5 seconds per job.
- The worker uses a single blocking `BRPOP` loop.

Why this matters:
- Dispatch is currently the first bottleneck, but once driver retry behavior is fixed, prep will become the next capacity ceiling.
- Throughput is capped by design.

Priority fix:
- Add horizontal scaling or worker concurrency.
- Replace pub/sub fan-out with durable queue semantics to support more than one consumer cleanly.

## Reliability Risks by Service

### `order-service`

Main risks:
- Order creation is not atomic with queue publication. The service inserts into Postgres and only then pushes to Redis. If the Redis push fails, the client gets a `500`, but the order row may already exist.
- Synchronous call to `restaurant-service` has no timeout, so slow downstream behavior can stall `POST /orders`.
- Redis connection startup is not awaited.
- `GET /orders` is unbounded and currently expensive as the dataset grows.

Improvements:
- Use a transaction plus outbox pattern, or at minimum update the order to `failed` if queue publish fails after insert.
- Add request timeouts and circuit-breaker style handling for downstream fetches.
- Await dependency readiness at startup.
- Paginate `GET /orders`.

### `restaurant-service`

Main risks:
- Search and menu lookups rely on full scans as data grows.
- Redis startup is not awaited.
- Menu cache is read-through only; if menu writes are added later, stale-cache behavior will surface immediately.

Improvements:
- Add indexes on `restaurants.name` and `menu_items.restaurant_id`.
- Add timeout handling around Redis and DB operations where appropriate.
- Add cache invalidation strategy if menu updates are introduced.

### `driver-service`

Main risks:
- Driver assignment is race-prone: it selects a free driver and then updates separately, with no row lock or transaction.
- If the follow-up order status update fails, the driver can stay `Busy` while the order never gets a driver assignment recorded.
- `PUT /drivers/:id/distance` updates the driver first and only then tries to mark the order delivered, which can leave driver state and order state inconsistent.
- Health check does not verify Redis even though Redis is configured in Compose.

Improvements:
- Use `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction for assignment.
- Add compensation if order-service update fails after reserving a driver.
- Persist a driver-to-order assignment explicitly so delivery completion can be verified safely.

### `order-dispatch-worker`

Main risks:
- Transient capacity failure (`no drivers available`) is treated as a DLQ-worthy terminal error.
- Queue consumption is destructive: `BLPOP` removes the message before downstream work is complete, so a crash after pop can lose work.
- Downstream fetches have no timeouts.
- Health reports Redis only; it does not surface downstream dependency degradation.

Improvements:
- Add retry queue or delayed requeue for capacity-related failures.
- Use Redis Streams or a reserve/ack pattern instead of destructive pop semantics.
- Distinguish poison pills from retryable operational failures.

### `preparation-tracker-worker`

Main risks:
- Uses Redis pub/sub to receive dispatch events, which is lossy if the subscriber is down at publish time.
- Single-threaded worker creates a hard throughput ceiling.
- DLQ entries only store generic error metadata, not the failed payload.

Improvements:
- Replace pub/sub handoff with durable queue or stream semantics.
- Preserve the original payload in the DLQ.
- Add concurrency or replication once dispatch retry is fixed.

### `delivery-tracker-service`

Main risks:
- Uses Redis pub/sub for `order_ready`, so ready events are lossy on restart or disconnect.
- Active delivery state is held in memory and disappears on restart.
- Intermediate statuses (`picked_up`, `nearby`) are not written back to `order-service`, so the order state machine is only partially reflected in the source of truth.
- Downstream fetches have no timeout control.

Improvements:
- Persist delivery progress or derive it from durable events.
- Move from pub/sub to durable queue/stream semantics.
- Update order status transitions centrally so order state stays authoritative.

### `rating-and-review-service`

Main risks:
- `POST /ratings` synchronously depends on `order-service` with no timeout.
- The service verifies only that an order is delivered, not that the `restaurant_id` and `customer_id` in the rating match the order.

Improvements:
- Add a timeout for the order verification call.
- Validate rating payload fields against the order record, not just delivery status.

## Incomplete Reliability Surface

These components exist in the repo but are not wired into the running stack:

- `notification-worker/src/index.js` is still a TODO.
- `surge-pricing-worker/src/index.js` is still a TODO.

That means the notification queue is currently write-only, and surge pricing is not an active runtime factor yet.

## Recommended Next Sprint Order

1. Fix dispatch retry behavior for `no drivers available`.
2. Add order status recovery so orders do not remain `pending` forever after worker failures.
3. Make driver assignment transactional and race-safe.
4. Add pagination and indexes to `GET /orders`.
5. Replace pub/sub handoffs with durable queue or stream semantics.
6. Add timeouts to all inter-service HTTP calls.
7. Scale or parallelize preparation processing after dispatch retries are in place.

## Candidate Sprint Tickets

- Retry queue for dispatch when no drivers are free.
- Mark irrecoverable dispatch failures as `failed` in `order-service`.
- Transactional driver reservation with row locking.
- Pagination and indexes for `orders`.
- Durable event transport for dispatch-to-prep and prep-to-delivery handoffs.
- Timeout and fallback policy for all service-to-service HTTP calls.
- Notification worker implementation and wiring.
