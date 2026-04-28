// TODO: Notification Worker — consumes delivery status events from Redis queue, logs notifications

const Redis = require('ioredis');

const redis = new Redis();

const DEDUP_KEY_PREFIX = 'notification:seen:';
const DEDUP_TTL = 60 * 60 * 24; // 24 hours

function logNotification(event) {
  console.log(`[NOTIFICATION] ${event.type} → Order ${event.orderId}`);
}

async function isNewEvent(eventId) {
  const key = `${DEDUP_KEY_PREFIX}${eventId}`;

  
  const result = await redis.set(key, '1', 'NX', 'EX', DEDUP_TTL);

  return result === 'OK'; 
}

async function processEvent(raw) {
  let event;

  try {
    event = JSON.parse(raw);
  } catch {
    console.log('Invalid JSON, skipping');
    return;
  }

  if (!event.eventId) {
    console.log('No eventId → cannot deduplicate, processing anyway');
    logNotification(event);
    return;
  }

  const isNew = await isNewEvent(event.eventId);

  if (!isNew) {
    console.log(`Duplicate event ${event.eventId} skipped`);
    return;
  }

  
  logNotification(event);
}

(async () => {
  const event = JSON.stringify({
    eventId: 'abc123',
    type: 'order_confirmed',
    orderId: '42'
  });

  await processEvent(event);
  await processEvent(event); 
})();