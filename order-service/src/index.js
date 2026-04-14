import express from 'express';
import healthRouter from './health.js';
import ordersRouter from './orders.js';
import { connectRedis } from './redis.js';
 
const PORT = Number(process.env.PORT) || 8000;
 
const app = express();
app.use(express.json());
 
app.use(healthRouter);
app.use(ordersRouter);
 
(async () => {
  await connectRedis();
  app.listen(PORT, () => {
    console.log(`[order-service] listening on :${PORT}`);
  });
})();
