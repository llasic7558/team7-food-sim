// TODO: Order Dispatch Worker — consumes new orders from Redis queue, assigns driver, publishes "order dispatched" event
const Redis = require("ioredis");

const QUEUE_KEY = "queue:orders";
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";

const redis = new Redis(REDIS_URL);

async function run() {
  console.log(`Order Dispatch Worker listening on ${QUEUE_KEY}`);

  while (true) {
    try {
      const result = await redis.blpop(QUEUE_KEY, 5);
      if (!result) continue;

      const [, raw] = result;
      const order = JSON.parse(raw);
      console.log(`[DISPATCH] Consumed order ${order.order_id}`);

      //call driver
      const res=await fetch(`${DRIVER_SERVICE_URL}/assign`,{
        method:"POST",
        headers:{
          "Content-Type":"application/json"
        },
        body:JSON.stringify({
          order_id:order.order_id
        })
      });

      if (!res.ok){
        throw new Error(`Driver service error: ${res.status}`);
      }
      
      const driver = await res.json();
      console.log(
        `[DISPATCH] Assigned driver ${driver.id} to order ${order.order_id}`
      );
      //publish event
      await redis.publish(
        "event:order_dispatched",
        JSON.stringify({
          order_id: order.order_id,
          driver_id: driver.id
        })
      );
      
    } catch (err) {
      console.error("[ERROR]", err.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

run();
