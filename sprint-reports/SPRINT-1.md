# Sprint 1 Report — Team 7

**Sprint:** 1 — Foundation  
**Tag:** `sprint-1`  
**Submitted:** 04.13

---

## What We Built


Running `docker compose up` starts three core services (restaurant-service, driver-service, order-service), three Postgres databases, a shared Redis instance, and a Holmes investigation container. 

The restaurant-service connects to its own Postgres and Redis exposing its endpoints.

 The driver-service connects to its own Postgres and exposes its endpoints. The order-service skeleton is in place but not yet functional.
 
A k6 baseline load test hits the restaurant and driver read endpoints with 20 VUs.

---

## Individual Contributions

| Team Member | What They Delivered | Key Commits |
| ----------- | ------------------- | ----------- |
| Dev (dev8mehta) | Initial restaurant-service Express app, sprint plan docs | `758457a`, `26427a6`, `3cd7af8` |
| Beatrice Calvelo | Restaurant-service Redis health check, `GET /menu` stub, sync call test | `9803c1d`, `a4881d8`, `083b7bb` |
| Emily Joyce | Full driver-service implementation (schema, seed, Dockerfile, Express app, compose.yml) | `81cb1ca`, `d7af189`, `1ad2077`, `b779e38`, `130be86` |
| Kanika (kanikak1904) | Order-service Flask implementation (on `kanika` branch, not merged) | `9eecbd9` |
| Rishi Patel | Order-service Redis health check attempt (on branch, not merged) | `ff0865c`, `81c9de2` |
| Raymond Huang | Sprint plan documentation | `3ee6879` |
| Shao Qin Tan | Compose.yml wiring, k6 baseline test, README.md | `0658044` |
| Luka (llasic7558) | Compose.yml fixes, restaurant-service DB schema/seed/connection, k6 test updates, README, skeleton dirs for all services | `faa224d`, `26b4ee2`, `31f40bd`, `fdcb373`, `57cee59` |

Verify with:

```bash
git log --author="Name" --oneline -- path/to/directory/
```

---

## What Is Working

- [ ] `docker compose up` starts all services without errors
- [ ] `docker compose ps` shows every service as `(healthy)`
- [x] `GET /health` on every service returns `200` with DB and Redis status(on what is working)
- [ ] At least one synchronous service-to-service call works end-to-end
- [x] k6 baseline test runs successfully(with what is avaliable)

---

## What Is Not Working / Cut

The Order Service was not delveired on time before class. 

Due to lateness in completing services connecting a service to another service could not be done before the start of the next sprint.

Every person needs to communicate with where they are at in their work and not leave it until the night before. 
---

## k6 Baseline Results

Script: `k6/sprint-1.js`  
Run: `docker compose exec holmes k6 run /workspace/k6/sprint-1.js`

```
  █ THRESHOLDS 

    errors
    ✓ 'rate<0.01' rate=0.00%

    http_req_duration
    ✓ 'p(50)<300' p(50)=1.95ms
    ✓ 'p(95)<500' p(95)=4.41ms
    ✓ 'p(99)<1000' p(99)=12.56ms


  █ TOTAL RESULTS 

    checks_total.......: 5961    84.807262/s
    checks_succeeded...: 100.00% 5961 out of 5961
    checks_failed......: 0.00%   0 out of 5961

    ✓ GET /restaurants status 200
    ✓ GET /restaurants/1/menu status 200
    ✓ GET /drivers status 200

    CUSTOM
    errors.........................: 0.00%  0 out of 0

    HTTP
    http_req_duration..............: avg=2.43ms   min=882µs    med=1.95ms   max=54.87ms  p(90)=3.19ms   p(95)=4.41ms  
      { expected_response:true }...: avg=2.43ms   min=882µs    med=1.95ms   max=54.87ms  p(90)=3.19ms   p(95)=4.41ms  
    http_req_failed................: 0.00%  0 out of 5961
    http_reqs......................: 5961   84.807262/s

    EXECUTION
    iteration_duration.............: avg=508.61ms min=504.02ms med=507.06ms max=645.55ms p(90)=510.92ms p(95)=514.75ms
    iterations.....................: 1987   28.269087/s
    vus............................: 1      min=1         max=20
    vus_max........................: 20     min=20        max=20
```

| Metric             | Value    |
| ------------------ | -------- |
| p50 response time  | 1.95 ms  |
| p95 response time  | 4.41 ms  |
| p99 response time  | 12.56 ms |
| Requests/sec (avg) | 84.81    |
| Error rate         | 0.00%    |

These numbers are your baseline. Sprint 2 caching should improve them measurably.

---

## Blockers and Lessons Learned

People not getting their work done early so others could build off of it or test what they have. 