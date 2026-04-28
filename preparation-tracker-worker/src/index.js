import express from 'express';
import { createClient } from 'redis';

const app = express();
const PORT = process.env.PORT || 8100;
const SERVICE_NAME = process.env.SERVICE_NAME || 'preparation-tracker-worker';
const REDIS_URL = process.env.REDIS_URL;
const PREP_QUEUE = 'prep_queue';
const PREP_DLQ = 'prep_dlq';
const DISPATCHED_CHANNEL = 'order_dispatched';
const READY_CHANNEL = 'order_ready';
const NOTIFICATION_QUEUE = 'queue:notifications';
const startTime = Date.now();

const subscriber = createClient({ url: REDIS_URL });
const publisher = createClient({ url: REDIS_URL });
// client for BRPOP blocks the connection while waiting which led to a bug which is now fixed
const worker = createClient({ url: REDIS_URL });
// a seperate non-blocking client so /health and the pubsub handler can still
// talk to Redis while worker is waiting on BRPOP.
const queue = createClient({ url: REDIS_URL });
//check for any error 
for (const [name, c] of [['subscriber', subscriber], ['publisher', publisher], ['worker', worker], ['queue', queue]]) {
  c.on('error', (err) => console.error(`redis ${name} error:`, err.message));
}

let lastJobAt = null;

async function initRedis() {
  //refactor to make sure all are good then go
  await Promise.all([subscriber.connect(), publisher.connect(), worker.connect(), queue.connect()]);
  console.log('Preparation Tracker Worker connected to Redis');
  // Listen for pub/sub events

  await subscriber.subscribe(DISPATCHED_CHANNEL, async (message) => {
    try {
      const event = JSON.parse(message);
      console.log(`[preparation-tracker-worker] dispatch event received order_id=${event.order_id} driver_id=${event.driver_id}`);
      // ALSO push into a queue for depth tracking
      await queue.lPush(PREP_QUEUE, message);
      console.log(`[preparation-tracker-worker] queued prep job order_id=${event.order_id}`);
    } catch (err) {
      //make sure we are catching errors
      console.error('failed to push onto prep_queue:', err.message);
    }
  });

  // Worker loop (process queue)
  processQueue();
}

async function processQueue() {
  while (true) {
    try {
      // BRPOP blocks until job arrives
      const result = await worker.brPop(PREP_QUEUE, 0);
      const message = result.element;
      //we now 
      const event = JSON.parse(message);
      console.log('[PREP] processing', event);

      const prepTime = Math.floor(Math.random() * 3000) + 2000;
      await new Promise((r) => setTimeout(r, prepTime));
      //updated for delivery tracker to have the driver id
      const readyEvent = {
        order_id: event.order_id,
        driver_id: event.driver_id,
        restaurantId: event.restaurantId ?? event.restaurant_id,
        status: 'ready',
        timestamp: new Date().toISOString(),
      };
      //added some logging to record the order is done and going to delivery tracker
      await publisher.publish(READY_CHANNEL, JSON.stringify(readyEvent));
      await queue.rPush(
        NOTIFICATION_QUEUE,
        JSON.stringify({
          event: 'order_ready',
          order_id: event.order_id,
          status: 'ready',
        })
      );
      console.log(`[PREP] order ${event.order_id} ready (prep=${prepTime}ms)`);

      lastJobAt = new Date().toISOString();
    } catch (err) {
      
      console.error('[PREP] worker error:', err.message);
      //move bad job to DLQ
      try {
        await queue.lPush(PREP_DLQ, JSON.stringify({ error: err.message, at: new Date().toISOString() }));
      } catch (dlqErr) {
        console.error('failed to push onto DLQ:', dlqErr.message);
      }
    }
  }
}

app.get('/health', async (_req, res) => {
  const checks = {};
  let healthy = true;
  try {
    await queue.ping();
    checks.redis = { status: 'healthy' };
  } catch (err) {
    checks.redis = { status: 'unhealthy', error: err.message };
    healthy = false;
  }

  const queueDepth = await queue.lLen(PREP_QUEUE).catch(() => null);
  const dlqDepth = await queue.lLen(PREP_DLQ).catch(() => null);

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    service: SERVICE_NAME,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    queue_depth: queueDepth,
    dlq_depth: dlqDepth,
    dead_letter_queue_depth: dlqDepth,
    last_job_at: lastJobAt,
    checks,
  });
});

initRedis().catch((err) => {
  console.error('startup failed:', err.message);
  process.exit(1);
});

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} listening on ${PORT}`);
});
