CREATE TABLE IF NOT EXISTS drivers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Free',
  location TEXT,
  distance_from_order TEXT
);

CREATE TABLE IF NOT EXISTS driver_assignments (
  id SERIAL PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL UNIQUE,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  final_status TEXT NOT NULL DEFAULT 'assigned',
  last_known_distance TEXT
);

CREATE INDEX IF NOT EXISTS idx_driver_assignments_driver
  ON driver_assignments (driver_id, assigned_at DESC);
