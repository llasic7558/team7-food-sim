# Sprint 1 Report — [Team Name]

**Sprint:** 1 — Foundation  
**Tag:** `sprint-1`  
**Submitted:** [date, before 04.14 class]

---

## What We Built

[One or two paragraphs. What is running? What does `docker compose up` produce? What endpoints are live?]

---

## Individual Contributions

| Team Member | What They Delivered                                     | Key Commits            |
| ----------- | ------------------------------------------------------- | ---------------------- |
| [Name]      | [e.g. order-service with DB schema, health endpoint]    | [short SHA or PR link] |
| [Name]      | [e.g. restaurant-service, synchronous call integration] |                        |
| [Name]      | [e.g. compose.yml wiring, k6 baseline script]           |                        |

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

[Be honest. What did you not finish? What did you cut from the sprint plan and why? How will you address it in Sprint 2?]

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

[What slowed you down? What would you do differently? What surprised you?]
