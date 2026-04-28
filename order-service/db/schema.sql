CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_id VARCHAR(64) NOT NULL,
  restaurant_id VARCHAR(64) NOT NULL,
  items JSONB NOT NULL,
  base_total_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_price NUMERIC(10,2) NOT NULL,
  payment_status VARCHAR(32) NOT NULL DEFAULT 'authorized',
  payment_reference VARCHAR(128),
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  driver_id VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
