-- Postgres creates the "orders" DB from the POSTGRES_DB env var automatically.
-- Add any extensions or baseline schema here if needed.
-- SQLAlchemy's db.create_all() handles table creation, so this can stay minimal.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";