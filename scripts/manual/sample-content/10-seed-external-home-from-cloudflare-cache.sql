-- One-off manual seed from Cloudflare cache snapshots.
-- Purpose: repopulate external/home content for preview + prod channels.
-- This is intentionally NOT referenced by manifests/reconcile (ephemeral content seed).
--
-- Note: snapshot IDs collide across channels in source cache payloads.
-- Because primary keys are global, preview keeps original IDs and prod uses remapped IDs.

BEGIN;
SET search_path TO directus, public;

-- Remove existing external/home content for preview + prod.
WITH target_pages AS (
  SELECT id
  FROM cms_pages
  WHERE site_key = 'external'
    AND slug = 'home'
    AND release_channel IN ('preview', 'prod')
)
DELETE FROM cms_page_blocks
WHERE page_id IN (SELECT id FROM target_pages)
   OR (
     site_key = 'external'
     AND page_slug = 'home'
     AND release_channel IN ('preview', 'prod')
   );

DELETE FROM cms_block_rich_text
WHERE site_key = 'external'
  AND page_slug = 'home'
  AND release_channel IN ('preview', 'prod');

DELETE FROM cms_block_hero
WHERE site_key = 'external'
  AND page_slug = 'home'
  AND release_channel IN ('preview', 'prod');

DELETE FROM cms_block_module
WHERE site_key = 'external'
  AND page_slug = 'home'
  AND release_channel IN ('preview', 'prod');

DELETE FROM cms_block_template_ref
WHERE site_key = 'external'
  AND page_slug = 'home'
  AND release_channel IN ('preview', 'prod');

DELETE FROM cms_pages
WHERE site_key = 'external'
  AND slug = 'home'
  AND release_channel IN ('preview', 'prod');

-- Pages
INSERT INTO cms_pages (
  id,
  slug,
  title,
  status,
  seo_title,
  seo_description,
  site_key,
  release_channel,
  layout_template_key,
  theme_package_key,
  theme_mode,
  widget_dock_enabled,
  theme_switcher_position,
  theme_switcher_dock_direction,
  analytics_google_measurement_id,
  analytics_openobserve_rum_config,
  head_title,
  head_description,
  refresh_target
)
VALUES
  (
    '41799f0f-f4ef-49f0-a0f5-d09b8edd8125',
    'home',
    'Home',
    'published',
    'Home — Demo',
    'Demo home page powered by Directus Page Builder, 3',
    'external',
    'preview',
    'spa-default',
    'theme-clear',
    'auto',
    true,
    'top-right',
    'vertical',
    'G-ELP6DTZ8ZC',
    '{}'::jsonb,
    'Example App Shell',
    'Demo home page powered by Directus Page Builder, 3',
    'both'
  ),
  (
    '46692dbd-c0ca-422d-bd27-a04daae5ec8a',
    'home',
    'Home',
    'published',
    'Home — Demo',
    'Demo home page powered by Directus Page Builder, 3',
    'external',
    'prod',
    'spa-default',
    'theme-clear',
    'auto',
    true,
    'top-right',
    'vertical',
    'G-ELP6DTZ8ZC',
    '{}'::jsonb,
    'Example App Shell',
    'Demo home page powered by Directus Page Builder, 3',
    'both'
  );

-- Rich text blocks
INSERT INTO cms_block_rich_text (
  id,
  status,
  sort,
  body,
  site_key,
  release_channel,
  page_slug,
  refresh_target
)
VALUES
  -- preview roots
  (
    '8b4c38d3-8989-4435-a960-70d9f679395e',
    'published',
    NULL,
    $$This is header content #8$$,
    'external',
    'preview',
    'home',
    'preview'
  ),
  (
    '2cc82e06-5f85-4943-a745-85cf68a6943b',
    'published',
    NULL,
    $$# Hello from Directus

This page content is stored in Directus and fetched via GraphQL.

- Flexible schema
- Reusable blocks
- Headless delivery

<h1>test2</h1>$$,
    'external',
    'preview',
    'home',
    'preview'
  ),
  (
    '5137964f-4ff8-4cda-80c7-abc59e605423',
    'published',
    NULL,
    $$This is a footer. edited from mobile, and desktop

<h1>Footer!! x4</h1>$$,
    'external',
    'preview',
    'home',
    'preview'
  ),
  -- preview template children
  (
    'b4bb3d68-fc98-4a62-944c-f0991577f4d8',
    'published',
    NULL,
    $$test content

<h1>Adding a header here</h1>$$,
    'external',
    'preview',
    'home',
    'preview'
  ),
  (
    '29308406-955e-4583-aa86-6b2cbba13d03',
    'published',
    NULL,
    $$left content$$,
    'external',
    'preview',
    'home',
    'preview'
  ),
  (
    'd0752f1b-9aa4-4975-b952-b3b11f4caf1e',
    'published',
    NULL,
    $$more test content$$,
    'external',
    'preview',
    'home',
    'preview'
  ),
  (
    '9c4e35c1-1209-45d4-9d92-756ca892b4b9',
    'published',
    NULL,
    $$footer content for template$$,
    'external',
    'preview',
    'home',
    'preview'
  ),

  -- prod roots
  (
    'f9e91b00-71c1-43a2-9644-cf672db80684',
    'published',
    NULL,
    $$This is header content #4$$,
    'external',
    'prod',
    'home',
    'preview'
  ),
  (
    '5d86c2d9-08b1-48a2-aa5d-36ac49e5b79c',
    'published',
    NULL,
    $$# Hello from Directus

This page content is stored in Directus and fetched via GraphQL.

- Flexible schema
- Reusable blocks
- Headless delivery

<h1>test2</h1>$$,
    'external',
    'prod',
    'home',
    'preview'
  ),
  (
    '07a93c36-293d-4373-8a87-118b52703572',
    'published',
    NULL,
    $$This is a footer. edited from mobile, and desktop

<h1>Footer!! x4</h1>$$,
    'external',
    'prod',
    'home',
    'preview'
  ),
  -- prod template children
  (
    '6b12a02e-86be-4fa4-91bc-2e810c02a72b',
    'published',
    NULL,
    $$test content

<h1>Adding a header here</h1>$$,
    'external',
    'prod',
    'home',
    'preview'
  ),
  (
    '98e38315-239f-4284-9ebf-a13fa734b6d0',
    'published',
    NULL,
    $$left content$$,
    'external',
    'prod',
    'home',
    'preview'
  ),
  (
    '9f93f41c-95f6-443f-97bd-5f971ade96df',
    'published',
    NULL,
    $$more test content$$,
    'external',
    'prod',
    'home',
    'preview'
  ),
  (
    '2df92e2f-e6d3-41f3-8d3b-afe9c47e1981',
    'published',
    NULL,
    $$footer content for template....$$,
    'external',
    'prod',
    'home',
    'preview'
  );

-- Hero blocks
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
  refresh_target
)
VALUES
  (
    'fb89c6b4-c79b-4069-9c5f-8faaefa1bf52',
    'published',
    NULL,
    'Dotcomrow',
    'Dotcomrow Image',
    'https://cloudflare-shell-template-app-preview.suncoast.systems/assets/c391b91b-9f0a-4ef7-a551-a560355d5abd',
    'Dotcomrow website',
    'https://www.suncoast.systems',
    'external',
    'preview',
    'home',
    'preview'
  ),
  (
    '173a31ef-c8a1-4015-ae8f-d8dd3e188a38',
    'published',
    NULL,
    'Dotcomrow',
    'Dotcomrow Image',
    'https://cloudflare-shell-template-app-preview.suncoast.systems/assets/c391b91b-9f0a-4ef7-a551-a560355d5abd',
    'Dotcomrow website',
    'https://www.suncoast.systems',
    'external',
    'prod',
    'home',
    'preview'
  );

-- Module blocks
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
  refresh_target
)
VALUES
  -- preview accordion
  (
    'f255ea48-1217-4e86-959f-db953bd04687',
    'published',
    NULL,
    'radix',
    'radix-accordion',
    $$
    {
      "collapsible": true,
      "items": [
        {"content": "This is a CMS-driven SPA shell.", "title": "What is this app?", "value": "q1"},
        {"content": "Content is authored in Directus and cached in Cloudflare.", "title": "Where is content managed?", "value": "q2"}
      ],
      "label": "Frequently Asked Questions",
      "type": "single"
    }
    $$::jsonb,
    'external',
    'preview',
    'home',
    'preview'
  ),
  -- preview media
  (
    'bf50ee75-6b28-4d4a-82ee-4a0a386cd64a',
    'published',
    NULL,
    'radix',
    'radix-media',
    $$
    {
      "alt": "Media item",
      "autoplay": false,
      "caption": "Sunset",
      "controls": true,
      "height": 100,
      "linkLabel": "Open media",
      "loading": "lazy",
      "loop": false,
      "mediaType": "video",
      "mediaUrl": "https://cloudflare-shell-template-app-preview.suncoast.systems/assets/4d80990d-56cd-4bf1-87f4-769c6861213b",
      "muted": false,
      "objectFit": "cover",
      "openInNewTab": false,
      "posterUrl": "",
      "width": 100
    }
    $$::jsonb,
    'external',
    'preview',
    'home',
    'preview'
  ),
  -- preview nested mfe module
  (
    'a289cadc-05f2-4685-a5ed-d8f680948ee0',
    'published',
    NULL,
    'mfe',
    'mfe-generic-remote',
    $$
    {"async":{"correlationIdPath":"publish_async_request.request_id","enabled":true,"mode":"kafka-graphql-bridge","queue":{"dropPolicy":"backpressure","maxInflight":64,"orderingKey":"instance_id","supported":true},"request":{"defaultTimeoutMs":30000,"retry":{"initialBackoffMs":250,"jitter":true,"maxAttempts":2,"maxBackoffMs":2000},"supported":true},"requestChannel":"graphql.async.requests.v1","responseChannel":"graphql.async.responses.v1","stream":{"authMode":"inherit","endpointRef":"GRAPHQL_STREAM_ENDPOINT","reconnect":{"initialBackoffMs":500,"jitter":true,"maxAttempts":10,"maxBackoffMs":10000},"supported":true,"transport":"graphql-ws"}},"entryExport":"mount","input":{},"manifestUrl":"https://cloudflare-mfe-module-registry-service.suncoast.systems/assets/modules/prod/mfe-example-chat/sha-b7d9564792f1/manifest.json","mountStrategy":"module","preload":false,"registryKey":"mfe-example-chat","routeBase":"","sandbox":true,"ui":{"assistantLabel":"Assistant","graphql":{"authToken":"","conversationId":"","httpUrl":"https://cf-suncoast-graphql-proxy.prod.suncoast.systems/graphql","streamChunkMode":"replace","streamDonePath":"graphql_client_async_messages.0.status","streamErrorPath":"graphql_client_async_messages.0.error_payload","streamSubscription":"subscription StreamClientAsyncMessage($requestId: String!, $responseChannel: String!) { graphql_client_async_messages(where: { _and: [{ request_id: { _eq: $requestId } }, { kafka_topic: { _eq: $responseChannel } }] }, order_by: { updated_at: desc }, limit: 1) { request_id status response_payload error_payload completed_at updated_at } }","streamTextPath":"graphql_client_async_messages.0.response_payload","streamVariables":{"requestId":"{{requestId}}","responseChannel":"{{responseChannel}}"},"submitMutation":"mutation PublishAsyncRequest($input: json!) { publish_async_request(input: $input) }","submitRequestIdPath":"publish_async_request.request_id","submitVariables":{"input":{"expires_in_seconds":86400,"handler":"ai-service","metadata":{"asyncMode":"{{asyncMode}}","correlationIdPath":"{{correlationIdPath}}","instanceId":"{{instanceId}}","moduleKey":"{{moduleKey}}","requestChannel":"{{requestChannel}}","responseChannel":"{{responseChannel}}","source":"{{source}}"},"operation":"chat.completion","payload":{"conversationId":"{{conversationId}}","prompt":"{{prompt}}"}}},"wsUrl":"wss://cf-suncoast-graphql-proxy.prod.suncoast.systems/graphql"},"inputPlaceholder":"Ask AI...","maxMessages":20,"requestCommand":"mfe.example.chat.send","submitLabel":"Submit","title":"Example Chat MFE"},"version":"sha-b7d9564792f1"}
    $$::jsonb,
    'external',
    'preview',
    'home',
    'preview'
  ),

  -- prod accordion
  (
    '60e7a647-4e1f-4720-b544-0003abbd1666',
    'published',
    NULL,
    'radix',
    'radix-accordion',
    $$
    {
      "collapsible": true,
      "items": [
        {"content": "This is a CMS-driven SPA shell.", "title": "What is this app?", "value": "q1"},
        {"content": "Content is authored in Directus and cached in Cloudflare.", "title": "Where is content managed?", "value": "q2"}
      ],
      "label": "Frequently Asked Questions",
      "type": "single"
    }
    $$::jsonb,
    'external',
    'prod',
    'home',
    'preview'
  ),
  -- prod media
  (
    '6b9c3199-d8ae-43e6-b39f-f2227aba10c1',
    'published',
    NULL,
    'radix',
    'radix-media',
    $$
    {
      "alt": "Media item",
      "autoplay": false,
      "caption": "",
      "controls": true,
      "height": 100,
      "linkLabel": "Open media",
      "loading": "lazy",
      "loop": false,
      "mediaType": "image",
      "mediaUrl": "https://cloudflare-shell-template-app-preview.suncoast.systems/assets/c391b91b-9f0a-4ef7-a551-a560355d5abd",
      "muted": false,
      "objectFit": "cover",
      "openInNewTab": false,
      "posterUrl": "",
      "width": 100
    }
    $$::jsonb,
    'external',
    'prod',
    'home',
    'preview'
  );

-- Template reference blocks
INSERT INTO cms_block_template_ref (
  id,
  status,
  sort,
  name,
  template_key,
  site_key,
  release_channel,
  page_slug,
  refresh_target
)
VALUES
  (
    'd941f01f-4713-4b56-acd4-cf4ff3dd77e1',
    'published',
    NULL,
    'Container-A',
    'spa-two-column-equal',
    'external',
    'preview',
    'home',
    'preview'
  ),
  (
    '3697b36f-b8f3-4d19-b4d2-4d8e40c15c49',
    'published',
    NULL,
    'Container-A',
    'spa-two-column-equal',
    'external',
    'prod',
    'home',
    'preview'
  );

-- Page block links (preview)
INSERT INTO cms_page_blocks (
  id,
  page_id,
  collection,
  item,
  sort,
  slot,
  parent_block_id,
  template_scope,
  site_key,
  release_channel,
  page_slug,
  refresh_target
)
VALUES
  ('41bd2349-a7c1-4395-8303-09deffd203cf', '41799f0f-f4ef-49f0-a0f5-d09b8edd8125', 'cms_block_rich_text', '8b4c38d3-8989-4435-a960-70d9f679395e', 10, 'header', NULL, 'page', 'external', 'preview', 'home', 'preview'),
  ('66a73384-0eca-4370-bd25-a3a2bf7cbf0c', '41799f0f-f4ef-49f0-a0f5-d09b8edd8125', 'cms_block_hero',      'fb89c6b4-c79b-4069-9c5f-8faaefa1bf52', 20, 'header', NULL, 'page', 'external', 'preview', 'home', 'preview'),
  ('862867e2-df23-4cb2-9420-6ca8fc23658d', '41799f0f-f4ef-49f0-a0f5-d09b8edd8125', 'cms_block_rich_text', '2cc82e06-5f85-4943-a745-85cf68a6943b', 30, 'main',   NULL, 'page', 'external', 'preview', 'home', 'preview'),
  ('d5dd2588-6f62-4925-bd3d-b9c2fc45c115', '41799f0f-f4ef-49f0-a0f5-d09b8edd8125', 'cms_block_module',    'f255ea48-1217-4e86-959f-db953bd04687', 40, 'main',   NULL, 'page', 'external', 'preview', 'home', 'preview'),
  ('aa7a1593-3a7e-4616-9de1-ce1d1815c136', '41799f0f-f4ef-49f0-a0f5-d09b8edd8125', 'cms_block_template_ref','d941f01f-4713-4b56-acd4-cf4ff3dd77e1',50,'main',NULL,'page','external','preview','home','preview'),
  ('804d6f62-c9d8-4c91-acf5-96e8a5e25817', '41799f0f-f4ef-49f0-a0f5-d09b8edd8125', 'cms_block_module',    'bf50ee75-6b28-4d4a-82ee-4a0a386cd64a', 60, 'main',   NULL, 'page', 'external', 'preview', 'home', 'preview'),
  ('0bd8332a-4efd-4f79-be34-c0f4b00e84d6', '41799f0f-f4ef-49f0-a0f5-d09b8edd8125', 'cms_block_rich_text', '5137964f-4ff8-4cda-80c7-abc59e605423', 70, 'footer', NULL, 'page', 'external', 'preview', 'home', 'preview'),

  ('efe2b6d4-e063-42d3-bb66-b29d5cd63ad7', '41799f0f-f4ef-49f0-a0f5-d09b8edd8125', 'cms_block_rich_text', 'b4bb3d68-fc98-4a62-944c-f0991577f4d8', 10, 'header', 'aa7a1593-3a7e-4616-9de1-ce1d1815c136', 'template', 'external', 'preview', 'home', 'preview'),
  ('e0e20b19-6d42-48e1-b7f7-f7d328fde848', '41799f0f-f4ef-49f0-a0f5-d09b8edd8125', 'cms_block_rich_text', '29308406-955e-4583-aa86-6b2cbba13d03', 20, 'left',   'aa7a1593-3a7e-4616-9de1-ce1d1815c136', 'template', 'external', 'preview', 'home', 'preview'),
  ('191d3355-f786-450b-bd09-c9b8cc8c8def', '41799f0f-f4ef-49f0-a0f5-d09b8edd8125', 'cms_block_rich_text', 'd0752f1b-9aa4-4975-b952-b3b11f4caf1e', 30, 'right',  'aa7a1593-3a7e-4616-9de1-ce1d1815c136', 'template', 'external', 'preview', 'home', 'preview'),
  ('ca6f7d39-86a7-48b4-8c06-a72873f69127', '41799f0f-f4ef-49f0-a0f5-d09b8edd8125', 'cms_block_rich_text', '9c4e35c1-1209-45d4-9d92-756ca892b4b9', 40, 'footer', 'aa7a1593-3a7e-4616-9de1-ce1d1815c136', 'template', 'external', 'preview', 'home', 'preview'),
  ('d3a59323-9583-4d1d-af18-9dafdb489adc', '41799f0f-f4ef-49f0-a0f5-d09b8edd8125', 'cms_block_module',    'a289cadc-05f2-4685-a5ed-d8f680948ee0', 35, 'right',  'aa7a1593-3a7e-4616-9de1-ce1d1815c136', 'template', 'external', 'preview', 'home', 'preview');

-- Page block links (prod, remapped IDs)
INSERT INTO cms_page_blocks (
  id,
  page_id,
  collection,
  item,
  sort,
  slot,
  parent_block_id,
  template_scope,
  site_key,
  release_channel,
  page_slug,
  refresh_target
)
VALUES
  ('36b63066-35fb-4a68-966b-e1d7c6628bd5', '46692dbd-c0ca-422d-bd27-a04daae5ec8a', 'cms_block_rich_text',  'f9e91b00-71c1-43a2-9644-cf672db80684', 10, 'header', NULL, 'page', 'external', 'prod', 'home', 'preview'),
  ('df26df42-24a5-40c6-b5de-e8da9baed556', '46692dbd-c0ca-422d-bd27-a04daae5ec8a', 'cms_block_hero',       '173a31ef-c8a1-4015-ae8f-d8dd3e188a38', 20, 'header', NULL, 'page', 'external', 'prod', 'home', 'preview'),
  ('0060ffb1-35f4-4fae-999d-83031e76d5de', '46692dbd-c0ca-422d-bd27-a04daae5ec8a', 'cms_block_rich_text',  '5d86c2d9-08b1-48a2-aa5d-36ac49e5b79c', 30, 'main',   NULL, 'page', 'external', 'prod', 'home', 'preview'),
  ('e81044bd-49e1-4f65-8f0e-8891bde62069', '46692dbd-c0ca-422d-bd27-a04daae5ec8a', 'cms_block_module',     '60e7a647-4e1f-4720-b544-0003abbd1666', 40, 'main',   NULL, 'page', 'external', 'prod', 'home', 'preview'),
  ('b34611e8-d335-4e72-8354-bc2521de4cc3', '46692dbd-c0ca-422d-bd27-a04daae5ec8a', 'cms_block_template_ref','3697b36f-b8f3-4d19-b4d2-4d8e40c15c49', 50, 'main',  NULL, 'page', 'external', 'prod', 'home', 'preview'),
  ('f37c18cc-2e4f-4eb4-8a42-39938699e4cd', '46692dbd-c0ca-422d-bd27-a04daae5ec8a', 'cms_block_module',     '6b9c3199-d8ae-43e6-b39f-f2227aba10c1', 60, 'main',   NULL, 'page', 'external', 'prod', 'home', 'preview'),
  ('3bfac632-226e-46e8-95b1-31d6ce66df06', '46692dbd-c0ca-422d-bd27-a04daae5ec8a', 'cms_block_rich_text',  '07a93c36-293d-4373-8a87-118b52703572', 70, 'footer', NULL, 'page', 'external', 'prod', 'home', 'preview'),

  ('f321aab8-2663-4bb7-b2e0-c4097d382e69', '46692dbd-c0ca-422d-bd27-a04daae5ec8a', 'cms_block_rich_text',  '6b12a02e-86be-4fa4-91bc-2e810c02a72b', 10, 'header', 'b34611e8-d335-4e72-8354-bc2521de4cc3', 'template', 'external', 'prod', 'home', 'preview'),
  ('09f7ae8c-e762-4e2a-8f8e-bcc660ccaf68', '46692dbd-c0ca-422d-bd27-a04daae5ec8a', 'cms_block_rich_text',  '98e38315-239f-4284-9ebf-a13fa734b6d0', 20, 'left',   'b34611e8-d335-4e72-8354-bc2521de4cc3', 'template', 'external', 'prod', 'home', 'preview'),
  ('98c19085-4e03-4f71-9ec3-614d2004cd1c', '46692dbd-c0ca-422d-bd27-a04daae5ec8a', 'cms_block_rich_text',  '9f93f41c-95f6-443f-97bd-5f971ade96df', 30, 'right',  'b34611e8-d335-4e72-8354-bc2521de4cc3', 'template', 'external', 'prod', 'home', 'preview'),
  ('2ef901a5-a076-42d2-ab0f-6cdb863f35a2', '46692dbd-c0ca-422d-bd27-a04daae5ec8a', 'cms_block_rich_text',  '2df92e2f-e6d3-41f3-8d3b-afe9c47e1981', 40, 'footer', 'b34611e8-d335-4e72-8354-bc2521de4cc3', 'template', 'external', 'prod', 'home', 'preview');

COMMIT;
