CREATE TABLE surge_periods (
  id            SERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL,
  multiplier    DECIMAL(3,2) NOT NULL DEFAULT 1.50,
  started_at    TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_restaurant_surge UNIQUE (restaurant_id, started_at)
);

CREATE INDEX idx_surge_restaurant ON surge_periods (restaurant_id);
CREATE INDEX idx_surge_expires    ON surge_periods (expires_at);
