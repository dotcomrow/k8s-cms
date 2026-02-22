# Agent Instructions (k8s-cms)

These instructions are mandatory for AI agents working in this repository.

## Required Runbook

Before making any Directus database-related change, agents must read:

- `docs/directus-db-change-management.md`

Directus DB-related work includes any change to:

- `manifests/19-directus-postschema-script.yaml`
- `manifests/20-directus-deployment.yaml`
- `manifests/15-directus-sites.yaml`
- `manifests/16-directus-layout-templates.yaml`
- `manifests/10-directus-config.yaml` (embedded extension behavior affecting DB metadata/flows)

## Non-Negotiable Requirements For DB Updates

Agents must apply the runbook every time and ensure:

1. GitOps-only changes (manifests + Argo sync), no ad-hoc live DB mutation as steady-state.
2. Idempotent SQL/patching patterns (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `ON CONFLICT`).
3. Directus flow graph constraints are respected (`directus_operations.resolve` and `reject` are unique).
4. Retry and timeout protections are present where DB/API races can occur.
5. Reconcile behavior is handled (checksum inputs and/or `DIRECTUS_POSTSCHEMA_RECONCILE_VERSION` bump when needed).
6. Validation commands are executed and reported:
   - `kubectl apply --dry-run=client -f manifests/19-directus-postschema-script.yaml`
   - `kubectl apply --dry-run=client -f manifests/20-directus-deployment.yaml`

## Required Output In Agent Response For DB Changes

When DB-related files are changed, agents must explicitly report:

- that the runbook was followed,
- which constraints/risks were checked,
- whether reconcile version/checksum implications were handled,
- and which validation commands were run.
