# Sprint 3 Plan — Food Sim

**Sprint:** 3 — Reliability and Poison Pills  
**Dates:** 04.21 → 04.28  
**Written:** 04.21 in class

---

## Goal

[What reliability improvements and poison pill handling will your team add? Which queues get DLQ handling?]

Will add poison pill handling to the order dispatch worker, then the following workers will get poison pill handling this Spring or on the next one

Investigative Failure Opportunities in: Restaurant Service, Order Service, Driver Service, Order Dispatch worker, and Delivery Tracker service to see if there any point to add more reliability 

K6 testing

Adding DLQ handling to Notification Worker and Surge Pricing Worker once implemented fully 


Putting info from the website into readme so everyone can more easily look here then the online doc on what needs to get done this sprint: 

Last services/workers to add:
Notification Worker	worker	Consumes delivery status events from a Redis queue and logs notifications (order confirmed, driver assigned, order picked up, delivered). Tolerates duplicate events.

Surge Pricing Worker	worker	Consumes order volume events from a Redis queue. When the order rate for a restaurant exceeds a configurable threshold, it publishes a "surge active" event and writes the surge period and multiplier to its own pricing database, causing the Restaurant Service to attach a surge fee to affected menus. Idempotent — duplicate volume events must not double-apply a surcharge.


Every team must deliver:

Poison pill handling on at least one queue: when a worker encounters a message it cannot process (malformed data, references to something that does not exist), it moves the message to a dead letter queue instead of retrying forever or crashing
All remaining workers and services from your chosen system are implemented
The system handles basic failure scenarios gracefully (a failed payment does not leave a dangling reservation, a deleted document does not cause the export worker to crash in a loop)
After poison pills are injected, the affected worker's /health endpoint must show a non-zero dlq_depth while the worker's own status remains healthy — proving the worker is still running and processing good messages
Dead letter queue handling on all queues — every worker pipeline must handle poison pills and route them to a dead letter queue






---

## Ownership

| Team Member | Files / Directories Owned This Sprint |
| ----------- | ------------------------------------- |
| [Luka]      | `[/al workers/servicesl]` | 
| [Beatrice]      | `[/order-dispatch-worker]` |
| [emily joyce]      | `task/[notification-worker]` |
| [Name]      | `[path]` |
| [Name]      | `[path]` |
| [Name]      | `[path]` |
| [Name]      | `[path]` |
| [Name]      | `[path]` |

---

## Tasks

### [Luka]

- [ Investigate failure opportunities within each of the main services to see improvements in reliability ] 
- [ Investigate any bottle necks currently happening for the next sprint  ] 


### [Beatrice]

- [ ] adding poison pill handling in order dispatch worker

### [Emily Joyce]

- [notification worker Consumes delivery status events from a Redis queue ] ...

### [Raymond Huang]
Surge Pricing Worker- get it to read from redis queue and implement functionality 

- [ ] …

### [Name]

- [ ] …

### [Name]

- [ ] …

### [Name]

- [ ] ...
---

## Risks

---

## Definition of Done

After injecting poison pills, the worker's `/health` shows non-zero `dlq_depth` while status remains `healthy`. Good messages keep flowing. k6 results show throughput does not collapse.



