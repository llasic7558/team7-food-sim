import { Router } from 'express';
import { checkHealth as checkDb } from './db.js';
import { checkHealth as checkRedis } from './redis.js';

const rounter = Router();
const startedAt = Date.now();
rounter.get('/health', async (req, res) => {
  const [database, redis] = await Promise.all([checkDb(), checkRedis()]);
  const allHealthy = False
  if (database.status === 'healthy' && redis.status === 'healthy'){
    allHealthy = True
  }
 
  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'unhealthy',
    service: 'order-service',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    checks: { database, redis },
  });
});
 
export default router;