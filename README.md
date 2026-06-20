# k8s-cms
Suncoast Systems CMS system

## Apply

```sh
kubectl apply -f manifests/
```

## Docs

- `docs/directus-dynamic-selectors.md` - pattern for live Directus template/slot dropdowns used by pages/blocks.
- `docs/directus-db-change-management.md` - runbook for safe Directus DB schema/data/flow changes through GitOps.
- `docs/directus-image-action-openapi.yaml` - OpenAPI spec for the in-cluster image service used by Hasura actions.
- `docs/vm-stats-service-openapi.yaml` - OpenAPI spec for the VM stats reporting endpoints.
- `docs/ui-module-contract.md` - universal module contract for page components and MFEs with mandatory async configuration.
- `docs/schemas/ui-module-definition.schema.json` - JSON Schema for module definition manifests produced by module repos.
- `docs/schemas/ui-module-instance.schema.json` - JSON Schema for per-page module instances stored in CMS.
- `docs/schemas/ui-module-event-envelope.schema.json` - JSON Schema for module event/message envelopes.
- `AGENTS.md` - mandatory instructions for AI agents, including required use of the DB change-management runbook.

## New: VM reporting endpoint

This service now includes a reporting framework for gathering oracle-db VM health from a remote host via SSH.

- `GET /stats` -> gathers all collectors (storage, system, processes, services, ports, sessions, service_logs if args provided).
- `GET /stats?collector=storage` -> only the storage collector.
- `GET /stats?collector=services&state=active` -> service state filtered.
- `GET /stats?collector=processes&limit=50` -> top 50 processes by CPU.
- `GET /stats?collector=service_logs&service=directus&lines=200`
- `GET /stats?collector=sessions&scope=db` -> PostgreSQL session stats.
- `GET /stats?collector=sessions&scope=ssh` -> SSH login/session stats.
- `GET /stats?collector=all` -> same as no collector param.
- `POST /hasura/actions/stats` -> Hasura action payload wrapper around `getStats`.
- `GET /openapi.json` -> machine-readable OpenAPI for Gravitee/Hasura integration.

Because this service is Cloud Run-only, there is no Kubernetes Service for Gravitee annotation discovery.  
Expose via Gravitee/Hasura by pointing them to the Cloud Run URL and `/openapi.json`.

### Env vars for reporting

- `REPORTING_ENABLED` (`true`/`false`, default `false`)
- `REPORTING_REQUIRE_API_KEY` (`true`/`false`, default `true`)
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

For collector metadata and thresholds, see `src/src/server.ts` env parsing section.

### Available collectors

- `storage` (storage utilization + threshold state)
- `system` (load, memory, swap)
- `processes` (top processes)
- `services` (systemd services)
- `ports` (listening ports and process owners)
- `sessions` (`scope=db|ssh|all`, `limit=<n>`)
- `service_logs` (`service=<unit>`, `lines=<n>`, `since=<timestamp>`)
