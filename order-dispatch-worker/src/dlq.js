const Redis = require("ioredis");
 
const QUEUE_KEY = process.env.QUEUE_KEY || "queue:order_dispatch";
const DLQ_KEY = process.env.DLQ_KEY || "queue:order_dispatch:dlq";
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
 
const redis = new Redis(REDIS_URL);
 

//things in the DLQ
async function listDlq({ start = 0, stop = -1 } = {}) {
  const items = await redis.lrange(DLQ_KEY, start, stop);
  return items.map((raw, i) => {
    try {
      return { index: start + i, ...JSON.parse(raw) };
    } catch {
      return { index: start + i, raw };
    }
  });
}
 
async function dlqDepth() {
  return redis.llen(DLQ_KEY);
}
 

async function retryFromDlq({ reasons, limit } = {}) {
  const all = await redis.lrange(DLQ_KEY, 0, -1);
  let retried = 0;
  let skipped = 0;
  const remaining = [];
 
  for (const raw of all) {
    if (limit != null && retried >= limit) {
      remaining.push(raw);
      continue;
    }
 
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      remaining.push(raw);
      skipped++;
      continue;
    }
 
    if (reasons && !reasons.includes(parsed.reason)) {
      remaining.push(raw);
      skipped++;
      continue;
    }
 
    const orderPayload = parsed.payload || {
      order_id: parsed.order_id,
      restaurant_id: parsed.restaurant_id,
    };
 
    if (!orderPayload.order_id) {
      remaining.push(raw);
      skipped++;
      continue;
    }
 
    await redis.rpush(QUEUE_KEY, JSON.stringify(orderPayload));
    retried++;
    console.log(
      `[DLQ] Retried order_id=${orderPayload.order_id} (was: ${parsed.reason})`
    );
  }
 
  const pipeline = redis.pipeline();
  pipeline.del(DLQ_KEY);
  for (const item of remaining) {
    pipeline.rpush(DLQ_KEY, item);
  }
  await pipeline.exec();
 
  return { retried, skipped, remaining: remaining.length };
}
 
//remvoe entries
async function purgeDlq({ reasons } = {}) {
  if (!reasons) {
    const count = await redis.llen(DLQ_KEY);
    await redis.del(DLQ_KEY);
    return { purged: count, kept: 0 };
  }
 
  const all = await redis.lrange(DLQ_KEY, 0, -1);
  const remaining = [];
  let purged = 0;
 
  for (const raw of all) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      remaining.push(raw);
      continue;
    }
 
    if (reasons.includes(parsed.reason)) {
      purged++;
    } else {
      remaining.push(raw);
    }
  }
 
  const pipeline = redis.pipeline();
  pipeline.del(DLQ_KEY);
  for (const item of remaining) {
    pipeline.rpush(DLQ_KEY, item);
  }
  await pipeline.exec();
 
  return { purged, kept: remaining.length };
}
 
async function close() {
  await redis.quit();
}
 
module.exports = {
  listDlq,
  dlqDepth,
  retryFromDlq,
  purgeDlq,
  close,
  QUEUE_KEY,
  DLQ_KEY,
};