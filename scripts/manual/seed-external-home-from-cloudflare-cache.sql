-- Compatibility wrapper for manual sample seed.
-- Requires psql (uses \ir include).
\set ON_ERROR_STOP on
\ir sample-content/10-seed-external-home-from-cloudflare-cache.sql
