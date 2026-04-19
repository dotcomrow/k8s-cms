-- Single entrypoint for sample CMS content.
-- Runs seed (external preview/prod) then clone (all site/channel variants).
-- Requires psql (uses \ir include).
\set ON_ERROR_STOP on
\ir sample-content/00-apply-sample-content.sql
