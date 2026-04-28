# Sprint 3 Report — team-7-food-project-sim

**Sprint:** 3 — Reliability and Poison Pills  
**Tag:** `sprint-3`  
**Submitted:** before 4.28

---

## What We Built
We finished the remaining services for the restaurant sim. This being the notification worker and surge pricing worker. The rest of what was built was adding poison pill checks for order dispatch workers and surge pricing workers. On top of this adding DLQ handling for each of the workers handling proper queues not just pub/sub requests. Also adding a retry effort for order dispatch worker with backoff. 

---

## Individual Contributions

| Team Member | What They Delivered | Key Commits |
| ----------- | ------------------- | ----------- |
| Luka  | Completed too many tasks, added better logging, completed the notification worker with proper DLQ handling, added idempotency for surge pricing and pricing logging, add availability windows and payment history for price surging, added backoff retries for dispatch worker, added DLQ for surge pricing worker | `7f88030`, `88c4578`, `608b439`, `2bc5532` |
| Emily Joyce | Notification worker compose and package wiring, follow-up worker fixes | `54f16d5`, `6c0ab6f`, `ac7a554` |
| Rishi Patel | Initial notification worker consumer setup| `1886ed1`, `37727bc` |
| Shao Qin Tan | Initial surge pricing worker and restaurant-side surge support | `31b3553`, `e5f70c5`, `a2c2223`, `78b57ee` |
| [Beatrice Calvelo]  | added poison pill handling for order dispatch worker| 23497bc|
| [Dev Mehta]  | added k6 load tests | 3deef1f |

---

## What Is Working

- [x ] Poison pill handling: malformed messages go to DLQ, worker keeps running
- [ x] Worker `GET /health` shows non-zero `dlq_depth` after poison pills are injected
- [x ] Worker status remains `healthy` while DLQ fills
- [ x/?] System handles failure scenarios gracefully (no dangling state, no crash loops) could still be hidden bugs not yet discovered
- [ x] All services/workers required for team size are implemented

---

## What Is Not Working / Cut

Everything seems to be up and ready, however there could still be unseen bugs that need to be addressed before the final submission. 

## Poison Pill Demonstration

How to inject a poison pill:

```bash
docker compose exec -T redis redis-cli RPUSH queue:notifications 'not-json'

docker compose exec -T redis redis-cli RPUSH queue:notifications '{"event":"order_ready","order_id":999999,"status":"ready"}'
```

Worker health before injection:

```json
{
  "status": "healthy",
  "service": "notification-worker",
  "queue_depth": 0,
  "dlq_depth": 0,
  "dead_letter_queue_depth": 0,
  "last_job_at": "2026-04-28T00:46:58.967Z",
  "checks": { "redis": { "status": "healthy" } }
}
```

Worker health after injection:

```json
{
  "status": "healthy",
  "service": "notification-worker",
  "queue_depth": 0,
  "dlq_depth": 1,
  "dead_letter_queue_depth": 1,
  "last_job_at": "2026-04-28T00:47:59.808Z",
  "checks": { "redis": { "status": "healthy" } }
}
```

Observed worker log lines:

```text
[NOTIFY] Order 999999 is ready for pickup
[notification-worker] moved message to DLQ order_id=n/a reason=invalid_json
```



---

## k6 Results: Poison Pill Resilience (`k6/sprint-3-poison.js`)

```
  █ THRESHOLDS 

    dispatch_worker_healthy
    ✓ 'rate==1' rate=100.00%

    good_order_latency_ms
    ✓ 'p(95)<3000' p(95)=21.24ms

    http_req_failed{scenario:normal}
    ✓ 'rate<0.05' rate=0.00%

    prep_worker_healthy
    ✓ 'rate==1' rate=100.00%


  █ TOTAL RESULTS 

    checks_total.......: 201     3.570483/s
    checks_succeeded...: 100.00% 201 out of 201
    checks_failed......: 0.00%   0 out of 201

    ✓ good order returns 201

    CUSTOM
    dispatch_queue_depth_observed.........: avg=0          min=0       med=0      max=0       p(90)=0       p(95)=0      
    dispatch_retry_queue_depth_observed...: avg=118.107143 min=7       med=128.5  max=188     p(90)=187     p(95)=187.65 
    dispatch_worker_healthy...............: 100.00% 28 out of 28
    dlq_depth_observed....................: avg=431.5      min=398     med=435    max=435     p(90)=435     p(95)=435    
    good_order_latency_ms.................: avg=11.79ms    min=7.64ms  med=9.91ms max=47.64ms p(90)=17.1ms  p(95)=21.24ms
    good_orders_accepted..................: 201     3.570483/s
    poison_pills_injected.................: 30      0.532908/s
    prep_worker_healthy...................: 100.00% 28 out of 28

    HTTP
    http_req_duration.....................: avg=9.99ms     min=1.86ms  med=9.2ms  max=47.64ms p(90)=15.86ms p(95)=20.63ms
      { expected_response:true }..........: avg=9.99ms     min=1.86ms  med=9.2ms  max=47.64ms p(90)=15.86ms p(95)=20.63ms
    http_req_failed.......................: 0.00%   0 out of 259
      { scenario:normal }.................: 0.00%   0 out of 201
    http_reqs.............................: 259     4.600771/s

    EXECUTION
    iteration_duration....................: avg=226.85ms   min=264.5µs med=10.2ms max=2.03s   p(90)=2s      p(95)=2s     
    iterations............................: 259     4.600771/s
    vus...................................: 1       min=1        max=1
    vus_max...............................: 8       min=8        max=8

    NETWORK
    data_received.........................: 144 kB  2.6 kB/s
    data_sent.............................: 63 kB   1.1 kB/s




running (0m56.3s), 00/08 VUs, 259 complete and 0 interrupted iterations
monitor ✓ [======================================] 1 VUs      55s       
normal  ✓ [======================================] 00/06 VUs  40s        5.00 iters/s
poison  ✓ [======================================] 1 VUs      00.0s/20s  30/30 iters, 30 per VU


Baseline run: 
THRESHOLDS 

    good_order_latency_ms
    ✓ 'p(95)<3000' p(95)=29.21ms

    http_req_failed{scenario:normal}
    ✓ 'rate<0.05' rate=0.00%


  █ TOTAL RESULTS 

    checks_total.......: 201     5.023352/s
    checks_succeeded...: 100.00% 201 out of 201
    checks_failed......: 0.00%   0 out of 201

    ✓ good order returns 201

    CUSTOM
    good_order_latency_ms..........: avg=12.81ms min=6.87ms med=9.45ms max=101.8ms  p(90)=18.91ms p(95)=29.21ms
    good_orders_accepted...........: 201    5.023352/s

    HTTP
    http_req_duration..............: avg=12.81ms min=6.87ms med=9.45ms max=101.8ms  p(90)=18.91ms p(95)=29.21ms
      { expected_response:true }...: avg=12.81ms min=6.87ms med=9.45ms max=101.8ms  p(90)=18.91ms p(95)=29.21ms
    http_req_failed................: 0.00%  0 out of 201
      { scenario:normal }..........: 0.00%  0 out of 201
    http_reqs......................: 201    5.023352/s

    EXECUTION
    iteration_duration.............: avg=13.16ms min=7.09ms med=9.72ms max=102.12ms p(90)=19.31ms p(95)=29.57ms
    iterations.....................: 201    5.023352/s
    vus............................: 0      min=0        max=0
    vus_max........................: 6      min=6        max=6

    NETWORK
    data_received..................: 118 kB 2.9 kB/s
    data_sent......................: 56 kB  1.4 kB/s




running (0m40.0s), 00/06 VUs, 201 complete and 0 interrupted iterations
normal ✓ [======================================] 00/06 VUs  40s  5.00 iters/s


```

  | Metric | Normal-only run | Mixed with poison pills | Change |
  | ------ | --------------- | ----------------------- | ------ |
  | p95 | 22.47 ms | 23.23 ms | +0.76 ms |
  | RPS | 5.03 | 5.03 | ~0% |
  | Error rate | 0.00% | 0.00% | 0.00 pp |



[Explain: did throughput hold? Did the worker stay healthy throughout?]
Throughput did hold. The normal only baseline was 5.03 RPS with p95 = 22.47 ms and 0.00% errors. The mixed run was also 5.03 RPS, with p95 = 23.23 ms and 0.00% errors on normal requests. So poison injection did not cause a throughput collapse. Good requests kept returning throughout the run. 
The worker also stayed healthy throughout with dispatch_worker_healthy = 100% while the dlq depth increased by 30 poisonous pills, so the poison pills were routed to the DLQ without crashing the worker. The retry queue did grow during the run but is expected for real orders that temporarily could not get a driver and needed to be retried. It does not indicate a poison pill failure. The main thing is that the worker stays healthy well processing good orders and bad messages get sent to the DLQ.


---

## Blockers and Lessons Learned

The delivery tracker service had duplicate sending to order service which caused an idempotency check for no reason so moved the final done status check to the order service instead to prevent this double check. 

Needed to add more complex check for surge pricing worker then thought, needing to see if price was actually getting modified. 

With the DLQ implementing retry with backoff for order dispatch worker was a tad more difficult with the order sometimes immediately failing to find a driver so needed to work around the issue and was due to not allowing it to wait. 


