import { createClient } from 'redis';
import express from 'express';

const SERVICE_NAME = process.env.SERVICE_NAME || 'notification-worker';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const NOTIFICATION_QUEUE = 'queue:notifications';
const NOTIFICATION_DLQ = 'queue:notifications:dlq';
const PORT = process.env.PORT || 8000;
const DEDUPE_TTL_SEC = parseInt(process.env.NOTIFICATION_DEDUPE_TTL_SEC || '3600', 10);
const startTime = Date.now();
const app = express();

// Friendly log messages per event type. The Order Service publishes events
// shaped like { event: "order_<status>", order_id, status } ... 
//   order_confirmed, order_assigned (driver assigned),
//   order_picked_up, order_delivered.
const EVENT_MESSAGES = {
  order_confirmed: (e) => `Order ${e.order_id} confirmed`,
  order_assigned: (e) => `Driver assigned to order ${e.order_id}`,
  order_dispatched: (e) => `Driver assigned to order ${e.order_id}`,
  order_picked_up: (e) => `Order ${e.order_id} picked up by driver`,
  order_ready: (e) => `Order ${e.order_id} is ready for pickup`,
  order_in_transit: (e) => `Order ${e.order_id} is in transit`,
  order_nearby: (e) => `Order ${e.order_id} is nearby`,
  order_delivered: (e) => `Order ${e.order_id} delivered`,
};

function formatNotification(event) {
  const fn = EVENT_MESSAGES[event.event];
  if (fn) return fn(event);
  return `Order ${event.order_id} status update: ${event.status ?? event.event}`;
}

const worker = createClient({ url: REDIS_URL });
const queue = createClient({ url: REDIS_URL });
worker.on('error', (err) => console.error('redis worker error:', err.message));
queue.on('error', (err) => console.error('redis queue error:', err.message));

let lastJobAt = null;

function dedupeKey(event) {
  const eventName = event.event ?? 'unknown';
  const status = event.status ?? 'none';
  return `notif:dedupe:${eventName}:${event.order_id}:${status}`;
}

async function moveToDlq(record) {
  await queue.rPush(NOTIFICATION_DLQ, JSON.stringify(record));
  console.error(
    `[notification-worker] moved message to DLQ order_id=${record.order_id ?? 'n/a'} reason=${record.reason ?? 'unknown'}`
  );
}

async function parseAndValidate(raw) {
  let event;

  try {
    event = JSON.parse(raw);
  } catch (err) {
    await moveToDlq({
      payload: raw,
      reason: 'invalid_json',
      error: err.message,
      retryable: false,
      at: new Date().toISOString(),
    });
    return null;
  }

  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    await moveToDlq({
      payload: event,
      reason: 'invalid_payload_shape',
      retryable: false,
      at: new Date().toISOString(),
    });
    return null;
  }

  if (!event.event || event.order_id == null) {
    await moveToDlq({
      payload: event,
      order_id: event.order_id,
      reason: 'missing_required_fields',
      retryable: false,
      at: new Date().toISOString(),
    });
    return null;
  }

  return event;
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

  const queueDepth = await queue.lLen(NOTIFICATION_QUEUE).catch(() => null);
  const dlqDepth = await queue.lLen(NOTIFICATION_DLQ).catch(() => null);

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

async function processQueue() {
  while (true) {
    try {
      const result = await worker.brPop(NOTIFICATION_QUEUE, 5);
      if (!result) continue;

      const raw = result.element;
      const event = await parseAndValidate(raw);
      if (!event) continue;

      const reserved = await queue.set(dedupeKey(event), '1', {
        NX: true,
        EX: DEDUPE_TTL_SEC,
      });

      if (!reserved) {
        console.log(
          `[NOTIFY] duplicate ignored event=${event.event} order_id=${event.order_id}`
        );
        lastJobAt = new Date().toISOString();
        continue;
      }

      console.log(`[NOTIFY] ${formatNotification(event)}`);
      lastJobAt = new Date().toISOString();
    } catch (err) {
      console.error('[NOTIFY] processing error:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

app.listen(PORT, () => {
  console.log(`${SERVICE_NAME} running on port ${PORT}`);
});

async function main() {
  await Promise.all([worker.connect(), queue.connect()]);
  console.log(
    `${SERVICE_NAME} connected to Redis, consuming ${NOTIFICATION_QUEUE} (DLQ: ${NOTIFICATION_DLQ})`
  );
  await processQueue();
}

main().catch((err) => {
  console.error('startup failed:', err.message);
  process.exit(1);
});
