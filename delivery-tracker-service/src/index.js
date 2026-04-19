const express = require('express');
const { createClient } = require('redis');

const app = express();
const PORT = process.env.PORT || 8000;
const SERVICE_NAME = process.env.SERVICE_NAME || 'delivery-tracker-service';
const DRIVER_SERVICE_URL = process.env.DRIVER_SERVICE_URL || 'http://driver-service:8000';
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:8000';
const STAGE_MS = parseInt(process.env.STAGE_MS || '1000', 10);
const ORDER_READY_CHANNEL = 'event:order_ready';
const NOTIFICATION_QUEUE = 'queue:notifications';
const DELIVERY_RETENTION_MS = 10 * 60 * 1000;
const startTime = Date.now();

app.use(express.json());

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('redis error:', err.message));

const subscriber = redis.duplicate();
subscriber.on('error', (err) => console.error('redis subscriber error:', err.message));

const STAGES = [
  { status: 'picked_up',  distance: '10km' },
  { status: 'in_transit', distance: '5km'  },
  { status: 'nearby',     distance: '1km'  },
  { status: 'delivered',  distance: '0km'  },
];

//local saving of deliveris so users can poll the service to get the info
//about distance from
const deliveries = new Map();

//send a request to the driver service to update thier distance from location
async function putDriverDistance(driverId, body) {
  const url = `${DRIVER_SERVICE_URL}/drivers/${driverId}/distance`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 1) {
        console.error(`PUT ${url} failed:`, err.message);
        return null;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
//get the driver currently handling a delivery
async function getDriverFromService(id) {
  try {
    const res = await fetch(`${DRIVER_SERVICE_URL}/drivers/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`GET /drivers/${id} failed:`, err.message);
    return null;
  }
}

//get the order to tell whether the delivery is already complete
async function getOrderFromService(id) {
  try {
    const res = await fetch(`${ORDER_SERVICE_URL}/orders/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`GET /orders/${id} failed:`, err.message);
    return null;
  }
}

//simulation of delviering 
async function runDelivery(evt) {
  const orderId = Number(evt.order_id);
  const driverId = Number(evt.driver_id);
  if (!orderId || !driverId) {
    console.error('bad event, missing ids:', evt);
    return;
  }
  if (deliveries.has(orderId)) {
    console.log(`delivery for order ${orderId} already in progress, skipping`);
    return;
  }
  //update the map for the order 
  deliveries.set(orderId, {
    order_id: orderId,
    driver_id: driverId,
    status: 'starting',
    distance_from_order: null,
    //some debug info leftover
    stage_index: -1,
    stages_total: STAGES.length,
    //debug/usefull for message 
    updated_at: new Date().toISOString(),
  });
  //loop to simulate a driver getting closer
  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i]
    //driver driving 
    await new Promise((r) => setTimeout(r, STAGE_MS));
    //update the map for new status
    deliveries.set(orderId, {
      order_id: orderId,
      driver_id: driverId,
      status: stage.status,
      distance_from_order: stage.distance,
      stage_index: i,
      stages_total: STAGES.length,
      updated_at: new Date().toISOString(),
    });
    //if driver has delviered update the driver service which help to end
    //and finsh the order as well as free up the driver else 
    //just update the driver service with thier new location
    if (stage.status === 'delivered') {
      await putDriverDistance(driverId, {
        distance_from_order: stage.distance,
        status: 'Free',
        order_id: orderId,
      });
    } else {
        
      await putDriverDistance(driverId, {
        distance_from_order: stage.distance,
      });
    }

    console.log(`order ${orderId} -> ${stage.status} (${stage.distance})`);
  }
  //remove the driver
  setTimeout(() => deliveries.delete(orderId), DELIVERY_RETENTION_MS);
}

app.get('/health', async (_req, res) => {
  const checks = {};
  let healthy = true;
  const redisStart = Date.now();
  try {
    await redis.ping();
    checks.redis = { status: 'healthy', latency_ms: Date.now() - redisStart };
  } catch (err) {
    checks.redis = { status: 'unhealthy', error: err.message };
    healthy = false;
  }
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    checks,
  });
});

//polling tool — does not rely on the deliveries map (entries expire).
//If the order is delivered, report completion and which driver delivered it,
//otherwise look up the driver live and report their location + status.
app.get('/status/:orderId', async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!orderId) {
    return res.status(400).json({ error: 'invalid order id' });
  }

  const order = await getOrderFromService(orderId);
  if (!order) {
    return res.status(404).json({ error: 'order not found', order_id: orderId });
  }

  //no driver yet delivery hasn't started
  if (!order.driver_id) {
    return res.json({
      order_id: order.id,
      order_status: order.status,
      message: 'no driver assigned yet',
    });
  }

  //order already delivered driver is done
  if (order.status === 'delivered') {
    return res.json({
      order_id: order.id,
      order_completed: true,
      delivered_by_driver_id: order.driver_id,
    });
  }

  //in-progress so fetch driver's live location
  const driver = await getDriverFromService(order.driver_id);
  if (!driver) {
    return res.status(502).json({ error: 'driver-service unavailable', order_id: orderId });
  }
  res.json({
    order_id: order.id,
    order_status: order.status,
    driver_id: driver.id,
    driver_status: driver.status,
    distance_from_order: driver.distance_from_order,
  });
});

async function start() {
  await redis.connect();
  await subscriber.connect();
  await subscriber.subscribe(ORDER_READY_CHANNEL, (message, channel) => {
    let evt;
    try {
      evt = JSON.parse(message);
    } catch (err) {
      console.error('bad payload on', channel, err.message);
      return;
    }
    runDelivery(evt).catch((err) => console.error('runDelivery error:', err.message));
  });
  app.listen(PORT, () => {
    console.log(`${SERVICE_NAME} listening on ${PORT}`);
  });
}

start().catch((err) => {
  console.error('startup failed:', err.message);
  process.exit(1);
});
