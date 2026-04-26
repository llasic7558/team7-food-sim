// TODO: Notification Worker — consumes delivery status events from Redis queue, logs notifications
import { createClient } from 'redis';

const SERVICE_NAME = process.env.SERVICE_NAME || 'notification-worker';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const NOTIFICATION_QUEUE = 'queue:notifications';

// Friendly log messages per event type. The Order Service publishes events
// shaped like { event: "order_<status>", order_id, status } ... 
//   order_confirmed, order_assigned (driver assigned),
//   order_picked_up, order_delivered.
const EVENT_MESSAGES = {
  order_confirmed: (e) => `Order ${e.order_id} confirmed`,
  order_assigned: (e) => `Driver assigned to order ${e.order_id}`,
  order_picked_up: (e) => `Order ${e.order_id} picked up by driver`,
  order_delivered: (e) => `Order ${e.order_id} delivered`,
};

function formatNotification(event) {
  const fn = EVENT_MESSAGES[event.event];
  if (fn) return fn(event);
  return `Order ${event.order_id} status update: ${event.status ?? event.event}`;
}

// Blocking client used for BRPOP. Kept separate so other Redis work
const worker = createClient({ url: REDIS_URL });
worker.on('error', (err) => console.error('redis worker error:', err.message));

async function processQueue() {
  while (true) {
    try {
      const result = await worker.brPop(NOTIFICATION_QUEUE, 0);
      const raw = result.element;

      // TOdo poison-pill detection + DLQ routing wraps this block.
      const event = JSON.parse(raw);

      // TODO: idempotency / duplicate-event 

      console.log(`[NOTIFY] ${formatNotification(event)}`);
    } catch (err) {
      // Swallow per-message errors so the loop keeps running on good messages.
      // TODO: route the offending payload to the notifications DLQ.
      console.error('[NOTIFY] processing error:', err.message);
    }
  }
}

async function main() {
  await worker.connect();
  console.log(`${SERVICE_NAME} connected to Redis, consuming ${NOTIFICATION_QUEUE}`);
  await processQueue();
}

main().catch((err) => {
  console.error('startup failed:', err.message);
  process.exit(1);
});