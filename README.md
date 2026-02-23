# k8s-cms
Suncoast Systems CMS system

## Apply

```sh
kubectl apply -f manifests/
```

## Docs

- `docs/directus-dynamic-selectors.md` - pattern for live Directus template/slot dropdowns used by pages/blocks.
- `docs/directus-db-change-management.md` - runbook for safe Directus DB schema/data/flow changes through GitOps.
- `docs/ui-module-contract.md` - universal module contract for page components and MFEs with mandatory async configuration.
- `docs/schemas/ui-module-definition.schema.json` - JSON Schema for module definition manifests produced by module repos.
- `docs/schemas/ui-module-instance.schema.json` - JSON Schema for per-page module instances stored in CMS.
- `docs/schemas/ui-module-event-envelope.schema.json` - JSON Schema for module event/message envelopes.
- `AGENTS.md` - mandatory instructions for AI agents, including required use of the DB change-management runbook.
