// TODO: Preparation Tracker Worker — listens for "order dispatched" events, simulates prep time, publishes "order ready"
// set up express and Redis
import express from 'express';
import { createClient } from 'redis';

const app = express();
const PORT = process.env.PORT || 8100;
const startTime = Date.now();

// Redis clients
const subscriber = createClient({ url: process.env.REDIS_URL });
const publisher = createClient({ url: process.env.REDIS_URL });
const client = createClient({ url: process.env.REDIS_URL });

let lastJobAt = null;

async function initRedis() {
  await subscriber.connect();
  await publisher.connect();
  await client.connect();

  console.log('Preparation Tracker Worker connected to Redis');

  // Listen for pub/sub events
  await subscriber.subscribe('order_dispatched', async (message) => {
    // ALSO push into a queue for depth tracking
    await client.lPush('prep_queue', message);
  });

  // Worker loop (process queue)
  processQueue();
}

async function processQueue() {
  while (true) {
    try {
      // BRPOP blocks until job arrives
      const result = await client.brPop('prep_queue', 0);
      const message = result.element;

      const order = JSON.parse(message);
      console.log('Processing order:', order);

      // Simulate prep time
      const prepTime = Math.floor(Math.random() * 3000) + 2000;
      await new Promise((res) => setTimeout(res, prepTime));

      const readyEvent = {
        orderId: order.orderId,
        restaurantId: order.restaurantId,
        status: 'ready',
        timestamp: new Date().toISOString(),
      };

      await publisher.publish('order_ready', JSON.stringify(readyEvent));

      lastJobAt = new Date().toISOString();

    } catch (err) {
      console.error('Worker error:', err);

      //move bad job to DLQ
      await client.lPush('prep_dlq', JSON.stringify({ error: err.message }));
    }
  }
}

initRedis();


// health end point w/ required
// current queue depth, the dead letter queue depth,
//  and the timestamp of the last successfully processed job
app.get('/health', async (_req, res) => {
  const queueDepth = await client.lLen('prep_queue');
  const dlqDepth = await client.lLen('prep_dlq');

  res.json({
    status: 'healthy',
    service: 'preparation-tracker-worker',
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    queue_depth: queueDepth,
    dead_letter_queue_depth: dlqDepth,
    last_job_at: lastJobAt,
  });
});


app.listen(PORT, () => {
  console.log(`Preparation Tracker Worker running on port ${PORT}`);
});