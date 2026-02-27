# CMS Page Blocks Manager Interface

This document explains the custom Directus interface used on `cms_pages.blocks`.

## Purpose

The interface replaces the default relation UI with a block-focused manager for SPA content editing:

- Search/filter large block sets quickly.
- Group blocks by template/tag/slot/collection.
- Inline edit common fields (`slot`, `sort`, `group_tag`).
- Open related records quickly (`cms_page_blocks` row + content item).

## Source Files

- Interface seed code: `manifests/10-directus-config.yaml`
  - `cms-page-blocks-manager.package.json`
  - `cms-page-blocks-manager.index.js`
- Metadata wiring: `manifests/19-directus-postschema-script.yaml`
  - sets `cms_pages.blocks` interface to `cms-page-blocks-manager`
- Deployment wiring: `manifests/20-directus-deployment.yaml`
  - mounts extension from seed ConfigMap to extensions PVC

## Runtime Model

The interface fetches data directly from Directus REST API using same-origin auth:

1. Resolve current page id from form values or URL.
2. Load page context (`site_key`, `layout_template_key`).
3. Load valid slots for the page template.
4. Load page blocks for the current page.
5. Present grouped rows with inline draft editing.
6. PATCH changed rows to `cms_page_blocks`.

## Extension Points

Keep new behavior additive and isolated:

- Add new filters as local refs + computed filters only.
- Add new editable fields by extending:
  - `normalizeBlockRow`
  - `primeDrafts`
  - `buildPatchPayload`
  - row render controls
- Keep API request logic centralized in `apiRequest`.
- Prefer collection/field names from interface options instead of hardcoding.

## Safety Guidelines

- Do not mutate unrelated records.
- Keep patch payload minimal (only changed fields).
- Preserve existing behavior when options are missing by using defaults.
- Avoid introducing required dependencies on non-core Directus internals.

## Validation Checklist

After changes:

1. Validate JS parses as ESM:
   - `yq eval 'select(.metadata.name == "directus-extensions-seed") | .data["cms-page-blocks-manager.index.js"]' manifests/10-directus-config.yaml > /tmp/cms-page-blocks-manager.index.js`
   - `node --check --input-type=module < /tmp/cms-page-blocks-manager.index.js`
2. Validate manifest syntax:
   - `kubectl apply --dry-run=client -f manifests/10-directus-config.yaml`
   - `kubectl apply --dry-run=client -f manifests/19-directus-postschema-script.yaml`
   - `kubectl apply --dry-run=client -f manifests/20-directus-deployment.yaml`
3. In Directus page editor:
   - confirm blocks manager loads
   - filter/group controls work
   - single row save works
   - bulk save works
   - open row/content links route correctly
