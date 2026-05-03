# Sprint 4 Plan — [Team 7]

**Sprint:** 4 — Replication, Scaling, and Polish  
**Dates:** 04.28 → 05.07  
**Written:** 04.28 in class

---

## Goal

[Which services will you replicate? What is the exact `--scale` command? What polish work remains?]
Would we want to replicate the driver service, restaurant service, and order service. 

docker compose up --scale order-service=3 --scale restaurant-service=3 --scale driver-service=2


Need to double check if we cover DLQ handling for all queues. Double check handling poison pill events for those queues. See how well the system does with increasing the number of drivers. 
---

## Ownership

| Team Member | Files / Directories Owned This Sprint |
| ----------- | ------------------------------------- |
| [Dev]      | `[k6/sprint-4-scale.js]` |
| [Luka]      | `[driver-service/index.js], caddy compost and config, final README.md` |
| [Emily]      | `[notification-worker/index.js dlq handling check its working and order-service/ stateless can be duplicated help]`|
| [Kanika]      | `[order-service/ dealing with replicates and scaling]` |
| [Beatrice]      | `[ restaurant-service/index.js]` |


---

## Tasks

### [Dev]

- [ ] k6 scaling comparison load test

### [Luka]

- [ ] I will help check if the driver service is stateless, get the caddy up and ready, update the final Sprint and readme with information, as well as be the last checker for things 

### [Beatrice]

- [ ] replicating the restaurant service


### [Kanika]

- [ ] implementing the order service replicating 

---

## Risks

—
Risk is making sure things are truly stateless as we go and that each of the service pub sub events can handle the new traffic incoming and not miss out on things. Also that notification worker can handle the increased load. 

## Definition of Done

`docker compose up --scale [service]=3` starts successfully. `docker compose ps` shows all replicas as `(healthy)`. k6 scaling comparison shows measurable improvement. Replica failure test shows no dropped requests.



