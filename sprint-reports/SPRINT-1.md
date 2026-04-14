# Sprint 1 Report — Team 7

**Sprint:** 1 — Foundation  
**Tag:** `sprint-1`  
**Submitted:** 04.14

---

## What We Built


Running `docker compose up` starts three core services (restaurant-service, driver-service, order-service), three Postgres databases, a shared Redis instance, and a Holmes investigation container. 

The restaurant-service connects to its own Postgres and Redis exposing its endpoints.

 The driver-service connects to its own Postgres and exposes its endpoints. The order-service connects to its own Postgres and Redis exposing its endpoints. The service also connects to resturant service to create an order. 
 
A k6 baseline load test hits the restaurant, order and driver read endpoints with 20 VUs.

---

## Individual Contributions

| Team Member | What They Delivered | Key Commits |
| ----------- | ------------------- | ----------- |
| Dev (dev8mehta) | Initial restaurant-service Express app, sprint plan docs | `758457a`, `26427a6`, `3cd7af8` |
| Beatrice Calvelo | Restaurant-service Redis health check, `GET /menu` stub, sync call test | `9803c1d`, `a4881d8`, `083b7bb` |
| Emily Joyce | Full driver-service implementation (schema, seed, Dockerfile, Express app, compose.yml) | `81cb1ca`, `d7af189`, `1ad2077`, `b779e38`, `130be86` |
| Kanika (kanikak1904) | Order-service Flask implementation | `9eecbd9` |
| Rishi Patel | Order-service Redis health check attempt | `ff0865c`, `81c9de2` |
| Raymond Huang | Sprint plan documentation | `3ee6879` |
| Shao Qin Tan | Compose.yml wiring, k6 baseline test, README.md | `0658044` |
| Luka (llasic7558) | Compose.yml fixes, restaurant-service DB schema/seed/connection, k6 test updates, README, skeleton dirs for all services, refactoring other code to properly work | `faa224d`, `26b4ee2`, `31f40bd`, `fdcb373`, `57cee59` |

Verify with:

```bash
git log --author="Name" --oneline -- path/to/directory/
```

---

## What Is Working

- [x] `docker compose up` starts all services without errors
- [x] `docker compose ps` shows every service as `(healthy)`
- [] `GET /health` on every service returns `200` with DB and Redis status(Driver service does not have redis status only db)
- [x] At least one synchronous service-to-service call works end-to-end
- [x] k6 baseline test runs successfully(with what is avaliable)

---

## What Is Not Working / Cut

Driver service not set up to use Redis and has it endpoints implemented yet. 
Other services that are not core not yet connected. Not everything is integrated with one another as of yet.
---

## k6 Baseline Results

Script: `k6/sprint-1.js`  
Run: `docker compose exec holmes k6 run /workspace/k6/sprint-1.js`

```
  █ THRESHOLDS 

    errors
    ✓ 'rate<0.01' rate=0.00%

    http_req_duration
    ✓ 'p(50)<300' p(50)=6.65ms
    ✓ 'p(95)<500' p(95)=211.85ms
    ✓ 'p(99)<1000' p(99)=336.34ms


  █ TOTAL RESULTS 

    checks_total.......: 8340    118.399972/s
    checks_succeeded...: 100.00% 8340 out of 8340
    checks_failed......: 0.00%   0 out of 8340

    ✓ GET /restaurants status 200
    ✓ GET /restaurants/1/menu status 200
    ✓ GET /orders status 200
    ✓ POST /orders status 201
    ✓ GET /orders/:id status 200
    ✓ GET /drivers status 200

    CUSTOM
    errors.........................: 0.00%  0 out of 0

    HTTP
    http_req_duration..............: avg=37.82ms  min=940.1µs  med=6.65ms   max=650.51ms p(90)=137.59ms p(95)=211.85ms
      { expected_response:true }...: avg=37.82ms  min=940.1µs  med=6.65ms   max=650.51ms p(90)=137.59ms p(95)=211.85ms
    http_req_failed................: 0.00%  0 out of 8340
    http_reqs......................: 8340   118.399972/s

    EXECUTION
    iteration_duration.............: avg=728.84ms min=516.94ms med=735.67ms max=1.3s     p(90)=939.7ms  p(95)=962.02ms
    iterations.....................: 1390   19.733329/s
    vus............................: 1      min=1         max=20
    vus_max........................: 20     min=20        max=20
```

| Metric             | Value     |
| ------------------ | --------- |
| p50 response time  | 6.65 ms   |
| p95 response time  | 211.85 ms |
| p99 response time  | 336.34 ms |
| Requests/sec (avg) | 118.40    |
| Error rate         | 0.00%     |

The test now covers all three core services including order creation (POST /orders) which makes a synchronous call to restaurant-service for menu validation. Higher latencies compared to read-only tests are expected due to the write path (DB inserts, Redis queue pushes, service-to-service HTTP calls). These numbers are the baseline. Sprint 2 caching should improve read-path latencies measurably.

---

## Blockers and Lessons Learned

People not getting their work done early so others could build off of it or test what they have. 

Get work done early so we do not have to cram the night and morning before the next sprint. 