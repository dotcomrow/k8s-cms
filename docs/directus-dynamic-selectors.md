# Directus Dynamic Selectors (Templates/Slots)

This documents the working pattern used for Directus dropdowns that must:

- look native in Directus UI
- load live validated values
- avoid hardcoded defaults
- support nested editor context (page editor vs block editor)

## Files

- Extension UI: `manifests/10-directus-config.yaml`
  - embedded file: `cms-content-model-select.index.js`
- Field metadata writer (GitOps): `manifests/19-directus-postschema-script.yaml`

## Working Pattern

1. Use custom interface `cms-content-model-select` on:
- `cms_pages.layout_template_key`
- `cms_page_blocks.slot`

2. Store interface options with explicit mode:
- template field options: `mode: "template"`
- slot field options: `mode: "slot"`

3. In interface code, resolve mode with context guardrails:
- if `field === "slot"` => slot mode
- if `field === "layout_template_key"` => template mode
- keep explicit mode from options as first priority

4. Load options live from Directus API:
- templates from `cms_layout_templates` (published + site scope)
- slots from `cms_layout_template_slots` filtered by selected template/site

5. No defaults:
- return empty with a visible error notice if no valid rows exist.

6. Keep current value visible:
- if saved value is not in current result set, show `<value> (current)`.

## Native UI

The selector uses Directus components:

- `v-select` for dropdown look/behavior
- `v-notice` for inline errors

Fallback to native `<select>` is kept only as a safety net.

## Troubleshooting

If dropdown values look wrong:

1. Verify field metadata in `directus_fields`:
- `cms_pages.layout_template_key` -> `mode: "template"`
- `cms_page_blocks.slot` -> `mode: "slot"`

2. Verify source data exists:
- `cms_layout_templates`
- `cms_layout_template_slots`

3. Argo sync `directus`, then hard refresh Directus UI.

4. If stale UI persists, restart Directus pod so extension bundle reloads.

