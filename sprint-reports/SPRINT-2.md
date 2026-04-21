# Sprint 2 Report — Food Sim

**Sprint:** 2 — Async Pipelines and Caching  
**Tag:** `sprint-2`  
**Submitted:** 4.21 before class

---

## What We Built

[What cache did you add? What queue and worker are running? What does the async pipeline do?]
We added a cache to the restaurant service to more easily get menus from the db. The order queue and order dispatch worker are working correctly. As well as the preparation tracker worker and delivery tracker service. The entire service pipeline at this point is running. We can have an order be sent in, checked if already sent, validate with the restaurant service, send the order to the dispatch worker, then connect to a driver, send the order to the preparation worker to simulate making the food(via redis pub/sub), then send out a message the order is ready for the delivery tracker service which simulates the driver delivering the food, we then complete the order here, free up the driver, and mark the order as delivered. So the essential e2e pipeline at this point is implemented.
---

## Individual Contributions

| Team Member | What They Delivered | Key Commits |
| ----------- | ------------------- | ----------- |
| [Luka]      |worked on Delivery Tracker service, fixing idempotency within order service,  |0fdea34 eafb974 ecff527 eafb974 2c61adc 1f6d53b |
| [Emily Joyce]      |worked on order dispatch worker and driver endpoints|436ea03 a69b872|
| Beatrice Calvelo| completed Preparation Tracker Worker | 436ea03 a69b872 |

---

## What Is Working

- [x ] Redis cache in use — repeated reads do not hit the database
- [x ] Async pipeline works end-to-end (message published → worker consumes → action taken)
- [x ] At least one write path is idempotent (same request twice produces same result)
- [ x] Worker logs show pipeline activity in `docker compose logs`
- [x ] Worker `GET /health` returns queue depth, DLQ depth, and last-job-at

---

## What Is Not Working / Cut

—
There is nothing that is visibly or noticeably not working this week

## k6 Results

### Test 1: Caching Comparison (`k6/sprint-2-cache.js`)

| Metric | Sprint 1 Baseline | Sprint 2 Cached | Change |
| ------ | ----------------- | --------------- | ------ |
| p50    | 6.65 ms           | 9.11 ms         | +2.46 ms (+37.0%)   |
| p95    | 211.85 ms         | 303.59 ms       | +91.74 ms (+43.3%)  |
| p99    | 336.34 ms         | 427.45 ms       | +91.11 ms (+27.1%)  |
| RPS    | 118.40            | 103.68          | -14.72 (-12.4%)     |

The aggregate numbers look worse than Sprint 1. However this is misleading since in Sprint 2 we are also doing an idempotency check, and pushing to a dispatch queue and get /order grows to return more data as the async pipeline fills. There are more writes and lists happening on the endpoints that dominate the aggregate percentiles. We are also measuring a more full service then we did before. 

However if we break it down by endpoint shows the cache is actually working. Compare cache-on vs cache-off on the same Sprint 2 code (`CACHE_ENABLED=true` vs `false`):

| Endpoint             | Cache OFF p95 | Cache ON p95 | Change |
| -------------------- | ------------- | ------------ | ------ |
| `GET /restaurants/1/menu`   | 39.96 ms | 13.92 ms | -65%   |
| `GET /restaurants`          | 30.65 ms | 21.33 ms | -30%   |
| `GET /orders`               | 776.81 ms | 361.10 ms | -53%  |
| `POST /orders`              | 928.77 ms | 425.24 ms | -54%  |
| Aggregate p95               | 626.36 ms | 303.59 ms | -52%  |
| Aggregate RPS               | 71.18    | 103.68    | +46%   |

So Redis caching drops aggregate p95 by ~52% and lifts throughput by ~46% on the same Sprint 2 stack. So comparing cache on and off to a very empty app from Spring 1 is not a fair comparison to make. 



### Test 2: Async Pipeline Burst (`k6/sprint-2-async.js`)
There are 3 scenarios running at once, a 50-VU burst on `POST /orders`, a monitor that polls both workers' `/health` every 2s for 60s, and an idempotency replay that sends the same `X-Idempotency-Key` twice.

```
  █ THRESHOLDS

    checks{scenario:idempotency}
    ✓ 'rate==1.0' rate=100.00%

    http_req_failed{scenario:burst}
    ✓ 'rate<0.01' rate=0.00%

    order_ack_latency_ms
    ✓ 'p(95)<2000' p(95)=365.79ms


  █ TOTAL RESULTS

    checks_total.......: 53      0.879948/s
    checks_succeeded...: 100.00% 53 out of 53
    checks_failed......: 0.00%   0 out of 53

    ✓ burst POST /orders status 201
    ✓ idempotency first response is 201
    ✓ idempotency replay response is 2xx
    ✓ idempotency replay returns same order id (no duplicate row)

    CUSTOM
    accepted_orders................: 50    0.830139/s
    dispatch_queue_depth...........: avg=0        min=0       med=0        max=0        p(90)=0        p(95)=0
    duplicate_orders_blocked.......: 1     0.016603/s
    order_ack_latency_ms...........: avg=284.67ms min=90.43ms med=301.8ms  max=367.08ms p(90)=356.43ms p(95)=365.79ms
    prep_queue_depth...............: avg=0.066667 min=0       med=0        max=1        p(90)=0        p(95)=0.55

    HTTP
    http_req_duration..............: avg=128.89ms min=2.05ms  med=4.33ms   max=367.08ms p(90)=341.14ms p(95)=354.77ms
    http_req_failed................: 0.00% 0 out of 112
      { scenario:burst }...........: 0.00% 0 out of 50
    http_reqs......................: 112   1.859512/s

    EXECUTION
    iteration_duration.............: avg=922.19ms min=27.75ms med=346.76ms max=2.02s    p(90)=2s       p(95)=2s
    iterations.....................: 81    1.344826/s
```

All the 50 burst orders were accepted without error, p95 ack latency was 365.79 ms, and the idempotency replay returned the same `order_id` on the second POST.

Worker health during the burst (hit `/health` while k6 is running):

```json
// preparation-tracker-worker — queue_depth = 1 captured by the monitor during the burst
{
  "status": "healthy",
  "service": "preparation-tracker-worker",
  "uptime_seconds": 1595,
  "queue_depth": 1,
  "dlq_depth": 0,
  "dead_letter_queue_depth": 0,
  "last_job_at": "2026-04-21T13:27:43.240Z",
  "checks": { "redis": { "status": "healthy" } }
}
```

```json
// order-dispatch-worker — drains fast
{
  "status": "healthy",
  "service": "order-dispatch-worker",
  "uptime_seconds": 1656,
  "queue_depth": 0,
  "dlq_depth": 863,
  "last_job_at": "2026-04-21T13:28:26.956Z",
  "checks": { "redis": { "status": "healthy" } }
}
```

The dispatch worker's `queue_depth` stayed at 0 because it drains jobs faster than the 50-VU burst can enqueue them. So we just see the `last_job_at` advancing and the monitor observing `prep_queue_depth` to only tick up to 1 during the burst. The non-zero `dlq_depth: 863` on dispatch is residue from earlier DLQ-poisoning tests, not this run.

Idempotency check: the script sent the same payload twice with the same `X-Idempotency-Key` (`idem-1776778106858`). Both return 201 with same order id and there is no duplicaiton of orders and we have a 100% pass right.

---

## Blockers and Lessons Learned

Not large blockers this week. However a reexamine of the current pipeline is most likely needed to make sure things are flowing correctly. As well as understandblaity remains clear in the code.




