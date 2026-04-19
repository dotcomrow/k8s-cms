-- Sample content bundle entrypoint.
-- Step 1: seed external home content from cache snapshot payload.
-- Step 2: clone external/preview home across all site/channel variants.
\set ON_ERROR_STOP on
\echo 'Running sample-content step 1/2: seed external home...'
\ir 10-seed-external-home-from-cloudflare-cache.sql
\echo 'Running sample-content step 2/2: clone home across sites/channels...'
\ir 20-clone-home-content-to-all-sites-and-channels.sql
\echo 'Sample content apply complete.'
