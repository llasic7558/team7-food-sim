CREATE TABLE IF NOT EXISTS restaurants (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  cuisine TEXT,
  address TEXT,
  rating NUMERIC(2,1) DEFAULT 0.0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(8,2) NOT NULL,
  available BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS availability_windows (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens_at TIME NOT NULL,
  closes_at TIME NOT NULL,
  UNIQUE (restaurant_id, day_of_week, opens_at, closes_at)
);

CREATE INDEX IF NOT EXISTS idx_availability_windows_restaurant
  ON availability_windows (restaurant_id, day_of_week);
