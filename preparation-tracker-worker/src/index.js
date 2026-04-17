// TODO: Preparation Tracker Worker — listens for "order dispatched" events, simulates prep time, publishes "order ready"
// set up express and Redis
import express from 'express';
import { createClient } from 'redis';

const app = express();
const PORT = process.env.PORT || 8100;
const startTime = Date.now();

// Redis clients (separate for pub/sub)
const subscriber = createClient({ url: process.env.REDIS_URL });
const publisher = createClient({ url: process.env.REDIS_URL });

let lastJobAt = null;
let jobsProcessed = 0;

async function initRedis() {
  await subscriber.connect();
  await publisher.connect();

  console.log('Preparation Tracker Worker connected to Redis');

  // Subscribe to "order dispatched" events
  await subscriber.subscribe('order_dispatched', async (message) => {
    try {
      const order = JSON.parse(message);
      console.log('Received order_dispatched:', order);

      lastJobAt = new Date().toISOString();

      // Simulate preparation time for order (e.g., 2–5 seconds)
      const prepTime = Math.floor(Math.random() * 3000) + 2000;
      await new Promise((res) => setTimeout(res, prepTime));

      const readyEvent = {
        orderId: order.orderId,
        restaurantId: order.restaurantId,
        status: 'ready',
        timestamp: new Date().toISOString(),
      };

      // Publish "order ready"
      await publisher.publish('order_ready', JSON.stringify(readyEvent));

      jobsProcessed++;
      console.log('Published order_ready:', readyEvent);

    } catch (err) {
      console.error('Error processing order_dispatched:', err);
    }
  });
}

initRedis();


// Health endpoint
app.get('/health', (_req, res) => {
  res.json({
    // TODO: includes the current queue depth, 
    // the dead letter queue depth, 
    // and the timestamp of the last successfully processed job
    status: 'healthy',
    service: 'preparation-tracker-worker',
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    jobs_processed: jobsProcessed,
    last_job_at: lastJobAt,
  });
});


app.listen(PORT, () => {
  console.log(`Preparation Tracker Worker running on port ${PORT}`);
});