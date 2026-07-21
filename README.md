# k8s-cms
Suncoast Systems CMS system

## Apply

```sh
kubectl apply -f manifests/
```

## Shell App Site Keys

Each deployed shell app should use a stable `DIRECTUS_CONTENT_SITE_KEY`, and that value must match the `site_key` on its Directus content rows. Site entries in `manifests/15-directus-sites.yaml` drive Directus read policies, service-token binding, and bootstrap cache-refresh defaults for those keys.

Multiple apps can share `realm: external` or `realm: internal` while using distinct `app_key` values and whichever `site_key` they read content from. Cache refresh URLs live on `platform_apps` (`production_cache_refresh_url` and `preview_cache_refresh_url`), so multiple deployed apps can refresh from the same content site key when needed. Add a matching app row before deploying a shell app with a new app/site key, or have the future Organization Management flow create it.

## Platform Organization Management

The postschema reconcile creates Directus-managed registry collections for the internal Organization Management workflow: `platform_organizations`, `platform_apps`, and `platform_app_operations`. These store non-secret desired state and operation history only; deployment credentials stay server-side in the future control-plane service.

Directus site entries can opt into platform registry permissions with `platform_management.enabled: true`. The GraphQL audience alias used by the internal MFE is bound to the external site token today, so that site entry carries the platform-management grant while browser traffic still enters through Hasura and Gravitee.

## Docs

- `docs/directus-dynamic-selectors.md` - pattern for live Directus template/slot dropdowns used by pages/blocks.
- `docs/directus-db-change-management.md` - runbook for safe Directus DB schema/data/flow changes through GitOps.
- `docs/directus-image-action-openapi.yaml` - OpenAPI spec for the in-cluster image service used by Hasura actions.
- `docs/vm-stats-service-openapi.yaml` - OpenAPI spec for the VM stats reporting endpoints.
- `docs/cloud-billing-service-openapi.yaml` - OpenAPI spec for the cloud billing aggregation API and Hasura action.
- `docs/ui-module-contract.md` - universal module contract for page components and MFEs with mandatory async configuration.
- `docs/schemas/ui-module-definition.schema.json` - JSON Schema for module definition manifests produced by module repos.
- `docs/schemas/ui-module-instance.schema.json` - JSON Schema for per-page module instances stored in CMS.
- `docs/schemas/ui-module-event-envelope.schema.json` - JSON Schema for module event/message envelopes.
- `AGENTS.md` - mandatory instructions for AI agents, including required use of the DB change-management runbook.

## New: VM reporting endpoint

This service now includes a reporting framework for gathering VM health from one or more configured targets via SSH and Postgres querying.

- `GET /stats` -> gathers all default collectors (storage, system, hardware, processes, running services, ports, sessions, log files).
- `GET /stats?collector=storage` -> only the storage collector.
- `GET /stats?collector=hardware` or `GET /stats/sections/hardware` -> detailed CPU, DMI/platform, PCI, USB, block-device, and NIC inventory (`hardware_raw=false` suppresses verbose raw command output).
- `GET /stats?collector=services` -> running services by default.
- `GET /stats?collector=services&state=all` -> all services.
- `GET /stats?collector=processes&limit=50` -> top 50 processes by CPU.
- `GET /stats?collector=service_logs&service=directus&lines=200` -> today's service logs by default.
- `GET /stats?collector=service_logs&service=directus&range=all&level=error` -> error-only service logs across the available journal.
- `GET /stats?collector=sessions&scope=db` -> PostgreSQL session stats.
- `GET /stats?collector=sessions&scope=ssh` -> SSH login/session stats.
- `GET /stats?collector=all` -> same as no collector param.
- `POST /hasura/actions/stats` -> Hasura action payload wrapper around `getStats`.
- `GET /openapi.json` -> machine-readable OpenAPI for Gravitee/Hasura integration.

The VM stats code is now fully separated into the dedicated Kubernetes service (`manifests/71-vm-stats-service.yaml`)
and source directory (`vm-stats-service/`). The GitHub profile service file (`github-profile-service/src/server.ts`) is restored to
profile-only behavior.

The VM stats service is a dedicated Kubernetes service with Gravitee/Hasura discovery annotations.

For local/service discovery:
- VM stats: discover via `/vm-stats` context-path on Gravitee
- OpenAPI: `/openapi.json` from `vm-stats-service` service route

### Env vars for reporting

- `REPORTING_ENABLED` (`true`/`false`, default `false`)
- `REPORTING_REQUIRE_API_KEY` (`true`/`false`, default `true`)
- `REPORTING_SYSTEM_ID` (`oracle-db` default; used when `REPORTING_SYSTEMS_JSON` is unset)
- `REPORTING_SYSTEMS_JSON` (optional JSON array for multi-vm targeting; set through `vm-stats-service-targets` ConfigMap in `manifests/71-vm-stats-service.yaml`)
- `REPORTING_SSH_HOST` (required, e.g. `oracle-db-vm-ip`)
- `REPORTING_SSH_USER` (default `opc`)
- `REPORTING_SSH_KEY_PATH` (preferred) or `REPORTING_SSH_KEY` (inline key body)
- `REPORTING_SSH_PORT` (default `22`)
- `REPORTING_STRICT_HOST_KEY` (`true`/`false`, default `false`)
- `REPORTING_COMMAND_TIMEOUT_MS` (default `25000`)
- `REPORTING_CONNECT_TIMEOUT_MS` (default `12000`)
- `REPORTING_DB_HOST` (default `127.0.0.1`)
- `REPORTING_DB_PORT` (default `5432`)
- `REPORTING_DB_NAME` (default `directus`)
- `REPORTING_DB_USER` (default `postgres`)
- `REPORTING_DB_PASSWORD` (optional; if missing db sessions collector returns config error)
- `OPENAPI_SERVER_URL` (optional; sets `servers[].url` in `/openapi.json`, default `/`)

In this workspace, the default `REPORTING_SYSTEMS_JSON` is set in `manifests/71-vm-stats-service.yaml` to the Oracle VM target (`oracle-db`), using:

- `ssh_host`: `157.151.150.61`
- `db_host`: `157.151.150.61`
- `db_user`: `directus_app_k7m2v9q4x6r1t8h3`

For collector metadata and thresholds, see `vm-stats-service/src/server.ts` env parsing section.

### Available collectors

- `storage` (storage utilization + threshold state)
- `system` (load, memory, swap)
- `hardware` (CPU details, cache/topology, DMI/platform, PCI, USB, block devices, network adapters)
- `processes` (top processes)
- `services` (systemd services; default `state=running`, use `state=all` for all units)
- `ports` (listening ports and process owners)
- `sessions` (`scope=db|ssh|all`, `limit=<n>`)
- `service_logs` (`service=<unit>`, `lines=<n>`, `range=today|all`, `level=all|warning|error`, `since=<timestamp>`)

## Cloud billing service

The cloud billing backend for the Internal Operations MFE lives in `cloud-billing-service/` and is deployed by `manifests/74-cloud-billing-service.yaml`.

- REST summary: `GET /billing/summary`
- Service metadata: `GET /billing/services`
- Hasura action: `POST /hasura/actions/billing`
- OpenAPI: `GET /openapi.json`
- Gravitee context path: `/cloud-billing`

Billing service definitions are stored in the `cloud-billing-service-config` ConfigMap as `BILLING_SERVICES_JSON`. Provider credentials are injected through optional Kubernetes Secrets:

- `cloud-billing-service-aws`
- `cloud-billing-service-azure`
- `cloud-billing-service-gcp`
- `cloud-billing-service-oci`
- `cloud-billing-service-serverpronto`

Billing runtime env vars:

- `BILLING_SERVICES_JSON` or `BILLING_CONFIG_FILE` - configurable service definitions.
- `BILLING_SHARED_BEARER_TOKEN` - optional shared bearer token for direct service calls.
- `CACHE_TTL_SECONDS`, `REQUEST_TIMEOUT_MS`, `DEFAULT_CURRENCY`, `CORS_ALLOW_ORIGIN`, `OPENAPI_SERVER_URL` - runtime behavior and API metadata.

Generic providers without billing APIs use `adapter: "generic"` and can read costs from direct config values or env-backed Secret keys. The ServerPronto Miami colocation entry reads:

- `monthly-recurring-cost` -> `SERVERPRONTO_MONTHLY_RECURRING_COST`
- `month-to-date-cost` -> `SERVERPRONTO_MONTH_TO_DATE_COST`
- `previous-month-cost` -> `SERVERPRONTO_PREVIOUS_MONTH_COST`
- `billing-breakdown-json` -> `SERVERPRONTO_BILLING_BREAKDOWN_JSON`

For portal-only vendors, keep browser automation or AI screen parsing in a scheduled ingestion job that writes these generic billing values. Do not put portal scraping in the request path for `/billing/summary`.
