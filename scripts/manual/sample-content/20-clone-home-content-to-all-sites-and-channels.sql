-- One-off content clone script (ephemeral content only).
-- Source: cms_pages where (site_key='external', release_channel='preview', slug='home')
-- Targets: internal/external x preview/prod for slug='home'

BEGIN;
SET search_path TO directus, public;

CREATE TEMP TABLE tmp_source_page AS
SELECT *
FROM cms_pages
WHERE site_key = 'external'
  AND release_channel = 'preview'
  AND slug = 'home'
LIMIT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tmp_source_page) THEN
    RAISE EXCEPTION 'Source page external/preview/home not found';
  END IF;
END
$$;

CREATE TEMP TABLE tmp_source_page_blocks AS
SELECT pb.*
FROM cms_page_blocks pb
JOIN tmp_source_page sp ON sp.id = pb.page_id
ORDER BY pb.sort NULLS LAST, pb.id;

CREATE TEMP TABLE tmp_source_rich_text AS
SELECT b.*
FROM cms_block_rich_text b
JOIN tmp_source_page_blocks pb
  ON pb.collection = 'cms_block_rich_text'
 AND pb.item = b.id::text;

CREATE TEMP TABLE tmp_source_hero AS
SELECT b.*
FROM cms_block_hero b
JOIN tmp_source_page_blocks pb
  ON pb.collection = 'cms_block_hero'
 AND pb.item = b.id::text;

CREATE TEMP TABLE tmp_source_module AS
SELECT b.*
FROM cms_block_module b
JOIN tmp_source_page_blocks pb
  ON pb.collection = 'cms_block_module'
 AND pb.item = b.id::text;

CREATE TEMP TABLE tmp_source_template_ref AS
SELECT b.*
FROM cms_block_template_ref b
JOIN tmp_source_page_blocks pb
  ON pb.collection = 'cms_block_template_ref'
 AND pb.item = b.id::text;

CREATE TEMP TABLE tmp_targets (
  site_key text NOT NULL,
  release_channel text NOT NULL,
  PRIMARY KEY (site_key, release_channel)
);

INSERT INTO tmp_targets (site_key, release_channel)
VALUES
  ('external', 'preview'),
  ('external', 'prod'),
  ('internal', 'preview'),
  ('internal', 'prod');

INSERT INTO cms_pages (
  id,
  slug,
  title,
  status,
  seo_title,
  seo_description,
  parent,
  site_key,
  release_channel,
  layout_template_key,
  theme_package_key,
  theme_mode,
  widget_dock_enabled,
  widget_dock_position,
  widget_dock_direction,
  theme_selector_dock_position,
  analytics_google_measurement_id,
  analytics_openobserve_rum_script_url,
  analytics_openobserve_rum_config,
  head_title,
  head_description,
  head_theme_color,
  head_manifest_url,
  head_icon_url,
  head_apple_touch_icon_url,
  head_icon_shortcut_url,
  head_icon_svg_url,
  head_icon_16_url,
  head_icon_32_url,
  head_icon_180_url,
  head_icon_192_url,
  head_icon_512_url,
  head_icon_mask_url,
  head_icon_mask_color,
  head_canonical_url,
  head_robots,
  head_generator,
  theme_switcher_position,
  theme_switcher_dock_direction,
  refresh_target,
  date_created,
  date_updated
)
SELECT
  COALESCE(existing.id, cms_generate_uuid()) AS id,
  src.slug,
  src.title,
  src.status,
  src.seo_title,
  src.seo_description,
  src.parent,
  t.site_key,
  t.release_channel,
  src.layout_template_key,
  src.theme_package_key,
  src.theme_mode,
  src.widget_dock_enabled,
  src.widget_dock_position,
  src.widget_dock_direction,
  src.theme_selector_dock_position,
  src.analytics_google_measurement_id,
  src.analytics_openobserve_rum_script_url,
  src.analytics_openobserve_rum_config,
  src.head_title,
  src.head_description,
  src.head_theme_color,
  src.head_manifest_url,
  src.head_icon_url,
  src.head_apple_touch_icon_url,
  src.head_icon_shortcut_url,
  src.head_icon_svg_url,
  src.head_icon_16_url,
  src.head_icon_32_url,
  src.head_icon_180_url,
  src.head_icon_192_url,
  src.head_icon_512_url,
  src.head_icon_mask_url,
  src.head_icon_mask_color,
  src.head_canonical_url,
  src.head_robots,
  src.head_generator,
  src.theme_switcher_position,
  src.theme_switcher_dock_direction,
  src.refresh_target,
  COALESCE(existing.date_created, now()) AS date_created,
  now() AS date_updated
FROM tmp_targets t
CROSS JOIN tmp_source_page src
LEFT JOIN cms_pages existing
  ON existing.site_key = t.site_key
 AND existing.release_channel = t.release_channel
 AND existing.slug = src.slug
ON CONFLICT (site_key, release_channel, slug) DO UPDATE
SET
  title = EXCLUDED.title,
  status = EXCLUDED.status,
  seo_title = EXCLUDED.seo_title,
  seo_description = EXCLUDED.seo_description,
  parent = EXCLUDED.parent,
  layout_template_key = EXCLUDED.layout_template_key,
  theme_package_key = EXCLUDED.theme_package_key,
  theme_mode = EXCLUDED.theme_mode,
  widget_dock_enabled = EXCLUDED.widget_dock_enabled,
  widget_dock_position = EXCLUDED.widget_dock_position,
  widget_dock_direction = EXCLUDED.widget_dock_direction,
  theme_selector_dock_position = EXCLUDED.theme_selector_dock_position,
  analytics_google_measurement_id = EXCLUDED.analytics_google_measurement_id,
  analytics_openobserve_rum_script_url = EXCLUDED.analytics_openobserve_rum_script_url,
  analytics_openobserve_rum_config = EXCLUDED.analytics_openobserve_rum_config,
  head_title = EXCLUDED.head_title,
  head_description = EXCLUDED.head_description,
  head_theme_color = EXCLUDED.head_theme_color,
  head_manifest_url = EXCLUDED.head_manifest_url,
  head_icon_url = EXCLUDED.head_icon_url,
  head_apple_touch_icon_url = EXCLUDED.head_apple_touch_icon_url,
  head_icon_shortcut_url = EXCLUDED.head_icon_shortcut_url,
  head_icon_svg_url = EXCLUDED.head_icon_svg_url,
  head_icon_16_url = EXCLUDED.head_icon_16_url,
  head_icon_32_url = EXCLUDED.head_icon_32_url,
  head_icon_180_url = EXCLUDED.head_icon_180_url,
  head_icon_192_url = EXCLUDED.head_icon_192_url,
  head_icon_512_url = EXCLUDED.head_icon_512_url,
  head_icon_mask_url = EXCLUDED.head_icon_mask_url,
  head_icon_mask_color = EXCLUDED.head_icon_mask_color,
  head_canonical_url = EXCLUDED.head_canonical_url,
  head_robots = EXCLUDED.head_robots,
  head_generator = EXCLUDED.head_generator,
  theme_switcher_position = EXCLUDED.theme_switcher_position,
  theme_switcher_dock_direction = EXCLUDED.theme_switcher_dock_direction,
  refresh_target = EXCLUDED.refresh_target,
  date_updated = EXCLUDED.date_updated;

CREATE TEMP TABLE tmp_target_pages AS
SELECT p.id, p.site_key, p.release_channel, p.slug
FROM cms_pages p
JOIN tmp_targets t
  ON t.site_key = p.site_key
 AND t.release_channel = p.release_channel
JOIN tmp_source_page src
  ON src.slug = p.slug;

-- Remove prior target content to keep all four variants exactly in sync.
DELETE FROM cms_page_blocks pb
USING tmp_target_pages tp
WHERE pb.page_id = tp.id;

DELETE FROM cms_block_rich_text b
USING tmp_targets t, tmp_source_page src
WHERE b.page_slug = src.slug
  AND b.site_key = t.site_key
  AND b.release_channel = t.release_channel;

DELETE FROM cms_block_hero b
USING tmp_targets t, tmp_source_page src
WHERE b.page_slug = src.slug
  AND b.site_key = t.site_key
  AND b.release_channel = t.release_channel;

DELETE FROM cms_block_module b
USING tmp_targets t, tmp_source_page src
WHERE b.page_slug = src.slug
  AND b.site_key = t.site_key
  AND b.release_channel = t.release_channel;

DELETE FROM cms_block_template_ref b
USING tmp_targets t, tmp_source_page src
WHERE b.page_slug = src.slug
  AND b.site_key = t.site_key
  AND b.release_channel = t.release_channel;

CREATE TEMP TABLE tmp_target_block_map (
  target_page_id uuid NOT NULL,
  target_site_key text NOT NULL,
  target_release_channel text NOT NULL,
  source_block_id uuid NOT NULL,
  source_collection text NOT NULL,
  source_item_id uuid NOT NULL,
  new_page_block_id uuid NOT NULL,
  new_item_id uuid NOT NULL,
  source_parent_block_id uuid,
  source_tree_depth integer,
  source_sort integer,
  source_slot text,
  source_group_tag text,
  source_refresh_target text,
  PRIMARY KEY (target_page_id, source_block_id)
);

INSERT INTO tmp_target_block_map (
  target_page_id,
  target_site_key,
  target_release_channel,
  source_block_id,
  source_collection,
  source_item_id,
  new_page_block_id,
  new_item_id,
  source_parent_block_id,
  source_tree_depth,
  source_sort,
  source_slot,
  source_group_tag,
  source_refresh_target
)
SELECT
  tp.id,
  tp.site_key,
  tp.release_channel,
  pb.id,
  pb.collection,
  pb.item::uuid,
  cms_generate_uuid(),
  cms_generate_uuid(),
  pb.parent_block_id,
  pb.tree_depth,
  pb.sort,
  pb.slot,
  pb.group_tag,
  pb.refresh_target
FROM tmp_source_page_blocks pb
CROSS JOIN tmp_target_pages tp
WHERE pb.collection IN (
  'cms_block_rich_text',
  'cms_block_hero',
  'cms_block_module',
  'cms_block_template_ref'
);

INSERT INTO cms_block_rich_text (
  id,
  status,
  sort,
  body,
  site_key,
  release_channel,
  page_slug,
  refresh_target,
  date_created,
  date_updated
)
SELECT
  m.new_item_id,
  s.status,
  s.sort,
  s.body,
  m.target_site_key,
  m.target_release_channel,
  src.slug,
  COALESCE(s.refresh_target, 'both'),
  now(),
  now()
FROM tmp_target_block_map m
JOIN tmp_source_rich_text s ON s.id = m.source_item_id
CROSS JOIN tmp_source_page src
WHERE m.source_collection = 'cms_block_rich_text';

INSERT INTO cms_block_hero (
  id,
  status,
  sort,
  headline,
  subheadline,
  background_image,
  cta_label,
  cta_url,
  site_key,
  release_channel,
  page_slug,
  refresh_target,
  date_created,
  date_updated
)
SELECT
  m.new_item_id,
  s.status,
  s.sort,
  s.headline,
  s.subheadline,
  s.background_image,
  s.cta_label,
  s.cta_url,
  m.target_site_key,
  m.target_release_channel,
  src.slug,
  COALESCE(s.refresh_target, 'both'),
  now(),
  now()
FROM tmp_target_block_map m
JOIN tmp_source_hero s ON s.id = m.source_item_id
CROSS JOIN tmp_source_page src
WHERE m.source_collection = 'cms_block_hero';

INSERT INTO cms_block_module (
  id,
  status,
  sort,
  module_provider,
  module_key,
  props_json,
  site_key,
  release_channel,
  page_slug,
  refresh_target,
  date_created,
  date_updated
)
SELECT
  m.new_item_id,
  s.status,
  s.sort,
  s.module_provider,
  s.module_key,
  s.props_json,
  m.target_site_key,
  m.target_release_channel,
  src.slug,
  COALESCE(s.refresh_target, 'both'),
  now(),
  now()
FROM tmp_target_block_map m
JOIN tmp_source_module s ON s.id = m.source_item_id
CROSS JOIN tmp_source_page src
WHERE m.source_collection = 'cms_block_module';

INSERT INTO cms_block_template_ref (
  id,
  status,
  sort,
  name,
  template_key,
  site_key,
  release_channel,
  page_slug,
  refresh_target,
  date_created,
  date_updated
)
SELECT
  m.new_item_id,
  s.status,
  s.sort,
  s.name,
  s.template_key,
  m.target_site_key,
  m.target_release_channel,
  src.slug,
  COALESCE(s.refresh_target, 'both'),
  now(),
  now()
FROM tmp_target_block_map m
JOIN tmp_source_template_ref s ON s.id = m.source_item_id
CROSS JOIN tmp_source_page src
WHERE m.source_collection = 'cms_block_template_ref';

INSERT INTO cms_page_blocks (
  id,
  page_id,
  collection,
  item,
  sort,
  slot,
  parent_block_id,
  group_tag,
  site_key,
  release_channel,
  page_slug,
  refresh_target,
  date_created,
  date_updated
)
SELECT
  m.new_page_block_id,
  m.target_page_id,
  m.source_collection,
  m.new_item_id::text,
  m.source_sort,
  COALESCE(m.source_slot, 'main'),
  parent.new_page_block_id,
  m.source_group_tag,
  m.target_site_key,
  m.target_release_channel,
  src.slug,
  COALESCE(m.source_refresh_target, 'both'),
  now(),
  now()
FROM tmp_target_block_map m
LEFT JOIN tmp_target_block_map parent
  ON parent.target_page_id = m.target_page_id
 AND parent.source_block_id = m.source_parent_block_id
CROSS JOIN tmp_source_page src
ORDER BY
  m.target_site_key,
  m.target_release_channel,
  m.source_tree_depth NULLS FIRST,
  m.source_sort NULLS LAST,
  m.source_block_id;

DO $$
DECLARE
  rec record;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'directus'
      AND p.proname = 'recompute_cms_page_block_organization'
  ) THEN
    FOR rec IN SELECT id FROM tmp_target_pages LOOP
      PERFORM directus.recompute_cms_page_block_organization(rec.id);
    END LOOP;
  END IF;
END
$$;

COMMIT;
