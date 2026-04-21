CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_id VARCHAR(64) NOT NULL,
  restaurant_id VARCHAR(64) NOT NULL,
  items JSONB NOT NULL,
  total_price NUMERIC(10,2) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  driver_id VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
