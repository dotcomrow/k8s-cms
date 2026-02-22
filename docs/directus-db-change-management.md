# Directus DB Change Management (GitOps)

This runbook defines how to make safe database changes for Directus in this repo.

## Scope

This applies to:

- Schema/data/metadata changes in `manifests/19-directus-postschema-script.yaml`.
- Reconcile execution controls in `manifests/20-directus-deployment.yaml`.
- GitOps input data in `manifests/15-directus-sites.yaml`.
- GitOps input data in `manifests/16-directus-layout-templates.yaml`.
- Embedded Directus extension code in `manifests/10-directus-config.yaml`.

## Core Rules

1. Make changes only through manifests and Argo sync.
2. Keep changes idempotent with `CREATE ... IF NOT EXISTS`, `ALTER ... ADD COLUMN IF NOT EXISTS`, and `ON CONFLICT`.
3. Prefer additive/forward-only patches; avoid dropping columns/tables in routine changes.
4. Use retries for DB writes that can race by reusing `_psql_yb_retry`.
5. Respect Directus operation graph constraints:
   `directus.directus_operations.resolve` and `.reject` are unique; do not create fan-in patterns.
6. Keep Directus API calls bounded with connect and total timeouts.

## Reconcile Model

`directus-postschema` uses a patch ledger:

- `directus.schema_patch_log`
- `directus.schema_patch_runs`

Reconcile key:

- `postschema_reconcile_v1`

Reconcile checksum inputs include:

- `DIRECTUS_POSTSCHEMA_RECONCILE_VERSION`
- `sites.yaml` SHA
- `templates.yaml` SHA
- `settings.yaml` SHA
- postschema script SHA

This means script-only changes are tracked and can re-run without manual DB edits.

## Change Workflow

1. Edit manifests in Git:
   DB logic belongs in `manifests/19-directus-postschema-script.yaml`.
   If behavior must re-run regardless of checksum history, bump `DIRECTUS_POSTSCHEMA_RECONCILE_VERSION` in `manifests/20-directus-deployment.yaml`.
2. Validate manifests locally:
   `kubectl apply --dry-run=client -f manifests/19-directus-postschema-script.yaml`
   `kubectl apply --dry-run=client -f manifests/20-directus-deployment.yaml`
3. Sync with ArgoCD.
4. Verify postschema completed:
   `kubectl -n directus logs deploy/directus -c directus-postschema --tail=400`
5. Confirm no blocking errors before operational handoff.

## Required Verification Before Merge

Check logs for:

- No repeated `duplicate key value violates unique constraint "directus_operations_resolve_unique"`
- No repeated `Failed to persist links for operation`
- No long-running/hung token verification loops

Expected terminal state:

- Script reaches completion and idles (or equivalent success markers).

## Troubleshooting

### Symptom: Cache refresh endpoint called, but content stays stale/missing

Check:

1. `directus-postschema` completed flow provisioning.
2. Refresh flows are active for intended site/target.
3. App shell cache key includes site scope (for example `...:external:home`).

Likely causes:

- Flow graph partially provisioned due postschema failure/hang.
- Constraint violations in `directus_operations` link wiring.
- Downstream refresh auth or endpoint failures.

### Symptom: `directus_operations_resolve_unique` errors

Cause:

- Multiple operations linking `resolve` to the same target.

Fix pattern:

- Use single-path token mint op (no multi-attempt fan-in for operation links).
- Clear conflicting `resolve`/`reject` links in-flow before assigning new links.

### Symptom: postschema appears stuck during flow provisioning

Cause:

- Unbounded `curl` call while verifying Directus token or calling Directus API.

Fix pattern:

- Ensure API calls use connect timeout and max time.

## Operational Guardrails

1. Do not hot-edit DB manually as steady-state practice.
2. If emergency data correction is needed, follow with a manifest patch that makes desired state explicit.
3. Keep `DIRECTUS_POSTSCHEMA_FORCE_RECONCILE=false` by default.
4. Use `DIRECTUS_POSTSCHEMA_FORCE_RECONCILE=true` only for targeted recovery, then revert.

## PR Checklist For DB Changes

- [ ] Change is idempotent.
- [ ] Unique/foreign key constraints were considered.
- [ ] Retry/timeouts added where needed.
- [ ] Reconcile behavior considered (checksum inputs and/or version bump).
- [ ] Dry-run validation commands executed.
- [ ] Verification steps documented in PR notes.
