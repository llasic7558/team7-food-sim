CREATE TABLE ratings (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL UNIQUE,
  restaurant_id INTEGER NOT NULL,
  customer_id   VARCHAR(255) NOT NULL,
  score         INTEGER NOT NULL CHECK (score >= 1 AND score <= 5),
  review_text   TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ratings_restaurant ON ratings (restaurant_id);
CREATE INDEX idx_ratings_customer   ON ratings (customer_id);
