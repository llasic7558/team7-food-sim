# Sprint 2 Plan — Team 7

**Sprint:** 2 — Async Pipelines and Caching  
**Dates:** 04.14 → 04.21  
**Written:** 04.14 in class

—
## Design Ideas

Key Interactions

User places order → Order Service → Restaurant Service (synchronous HTTP to validate menu items)AFTER DONE
Push the order from user on Redis Queue after validation from Restaurant Service
In case of error send back message to order service about 
New order → push to Redis order dispatch queue → Order Dispatch Worker assigns driver via Driver Service

Driver assigned → publish "order dispatched" on Redis pub/sub → Preparation Tracker Worker begins countdown

Preparation done → publish "order ready" on Redis pub/sub → Delivery Tracker Service simulates transit

Each status change → push to Redis notification queue → Notification Worker logs the update

Malformed order in dispatch queue → dead letter queue

Need to get Done This week:

Order Dispatch Worker	worker	Consumes new orders from a Redis queue. Calls the Driver Service to assign a driver, then publishes an "order dispatched" event on Redis pub/sub. Must handle poison pills — an order referencing a nonexistent restaurant should be moved to a dead letter queue.
Preparation Tracker Worker	worker	Listens on Redis pub/sub for "order dispatched" events. Simulates restaurant preparation time, then publishes an "order ready" event.








Delivery Tracker Service	service	Listens on Redis pub/sub for "order ready" events. Simulates driver transit and publishes location updates. Exposes a status endpoint for clients to poll.

Rating & Review Service	service	Accepts post-delivery ratings from customers. Validates the order was completed via a synchronous call to the Order Service. Stores ratings in its own database. Exposes a restaurant ranking endpoint that aggregates average ratings. Publishes a "rating submitted" event on Redis pub/sub so the Restaurant Service can invalidate its cached menu metadata.




Stretch Goals: 

Notification Worker	worker	Consumes delivery status events from a Redis queue and logs notifications (order confirmed, driver assigned, order picked up, delivered). Tolerates duplicate events.
Surge Pricing Worker	worker	Consumes order volume events from a Redis queue. When the order rate for a restaurant exceeds a configurable threshold, publishes a "surge active" event and writes the surge period and multiplier to its own pricing database, causing the Restaurant Service to attach a surge fee to affected menus. Idempotent — duplicate volume events must not double-apply a surcharge.

## Goal

---

## Ownership

| Team Member | Files / Directories Owned This Sprint |
| ----------- | ------------------------------------- |
| Luka      | `delivery-tracker-service/` `k6/` |
| Raymond      | `[path]` |
|  Beatrice   | `preparation-tracker-worker/` |
|  Dev   | `restaurant-service/` |
|  Emily   | `drivers-service/ and order-dispatch-worker/` |
|  Kanika   | `[path]` |
|  Rishi   | `[path]` |
|  Shao   | `[path]` |




---

## Tasks

### [Dev]

- [ ] Implement Redis cache for menu

### [Raymond]

- [ Working on the Order Dispatch worker team and helping to get that connected] 

### [Luka]

- [Work on the Delivery Tracker Service getting it ready for its worker  ] …
- Get it to listen on redis queue for order ready events 
- Stim driver transit and locations 
- endpoints for clients to poll
- Complete k6 endpoints


### [Rishi]

- [ ]  Provides the order dispatch queue part of redis cache

### [Beatrice]

- [ ] set up Preparation Tracker Worker, listening for order dispatch and publishing an order ready event

### [Emily]

- [ ] Starting Order Dispatch Worker and making sure it works with driver service

---

## Risks
We need to make sure the new workers align with the core services we did last week.
Everything is starting to get heavily integrated this week so key communication is needed to make sure things keep going and we do not get stuck. 

---

## Definition of Done

A TA can trigger an action, watch the queue flow in Docker Compose logs, hit the worker's `/health` to see queue depth and last-job-at, and review k6 results showing the caching improvement.


