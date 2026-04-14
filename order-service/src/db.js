import pg from 'pg';
 
const { Pool } = pg;
 
// DATABASE_URL will be set by docker-compose, e.g.
// postgres://order:order@order-db:5432/orders
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
 
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});
 
/**
 * Ping the database and return { status, latency_ms } for /health.
 */
export async function checkHealth() {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return { status: 'healthy', latency_ms: Date.now() - start };
  } catch (err) {
    return { status: 'unhealthy', error: err.message };
  }
}
