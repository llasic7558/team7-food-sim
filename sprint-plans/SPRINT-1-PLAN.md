# Sprint 1 Plan — [Team Name]

**Sprint:** 1 — Foundation  
**Dates:** 04.07 → 04.14  
**Written:** 04.07 in class

---

## Goal

By the end of the spring, we will get our core services running in Docker Compose and talking to each other. The core services we will build are the restaurant service which will manage the restaurant profiles, menus, and availability windows, and the order service which will allow the system to accept and manage the orders that comes in from users (must also be protected against duplicates). We must also simulate and track driver availability and location.

---

## Ownership

| Team Member | Files / Directories Owned This Sprint           |
| ----------- | ----------------------------------------------- |
| [Dev, Emily and Kanika]      | `[service-dir]/`, `[service-dir]/db/schema.sql` |
| [Beatrice and Raymond]      | `[service-dir]/`, `compose.yml` additions       |
| [Shao and Luka]      | `k6/sprint-1.js`, `[worker-dir]/`               |

Each person must have meaningful commits in the paths they claim. Ownership is verified by:

```bash
git log --author="Name" --oneline -- path/to/directory/
```

---

## Tasks

### [Dev, Emily and Kanika]

- [ ] Set up `[service]/` with Express + Postgres connection
- [ ] Implement `GET /health` with DB check
- [ ] Write `db/schema.sql` and seed script
- [ ] Add `healthcheck` directive to `compose.yml`

### [Beatrice and Raymond]

- [ ] Set up `[service]/` with Express + Redis connection
- [ ] Implement `GET /health` with Redis check
- [ ] Implement `GET /[resource]` — stub returning placeholder data
- [ ] Test synchronous call to [other service]

### [Shao and Luka]

- [ ] Wire `depends_on: condition: service_healthy` in `compose.yml`
- [ ] Write `k6/sprint-1.js` baseline load test
- [ ] Write `README.md` startup instructions and endpoint list

---

## Risks

[What could go wrong? What are you uncertain about? What will you do if a task takes longer than expected?]

---

## Definition of Done

A TA can clone this repo, check out `sprint-1`, run `docker compose up`, and:

- `docker compose ps` shows every service as `(healthy)`
- `GET /health` on each service returns `200` with DB and Redis status
- The synchronous service-to-service call works end-to-end
- k6 baseline results are included in `SPRINT-1.md`
