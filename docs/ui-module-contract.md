# UI Module Contract (Components + MFEs)

## Purpose

Define one contract that both GUI components and MFEs must follow so the platform can:

- render modules from CMS data with strong validation
- keep runtime behavior consistent across web and native
- support async interaction patterns from day one
- preserve inline-first performance (no runtime code downloads in production)

## Design Rules

1. One contract for everything: "component" and "mfe" are `kind` values, not different APIs.
2. Inline-first runtime: module code is compiled into app artifacts at build time.
3. Async config is mandatory: every module definition and module instance must include async configuration blocks, even when async is disabled.
4. CMS stores configuration and layout placement only; executable code ships with the app build.

## Contract Artifacts

Use three documents together:

1. Module Definition
- file: `docs/schemas/ui-module-definition.schema.json`
- produced by module repositories
- describes capabilities, I/O, lifecycle, async support, and entry metadata

2. Module Instance
- file: `docs/schemas/ui-module-instance.schema.json`
- stored per page/slot in CMS
- binds `module_key` + `props` + `slot` + async runtime settings

3. Event Envelope
- file: `docs/schemas/ui-module-event-envelope.schema.json`
- standard envelope for host/module messages and async events

## Runtime API (Host <-> Module)

Every module package must export a factory with this shape:

```ts
export type ModuleFactory = (ctx: ModuleContext) => ModuleRuntime;

export interface ModuleRuntime {
  init?(input: InitInput): Promise<void> | void;
  mount(input: MountInput): Promise<void> | void;
  update?(input: UpdateInput): Promise<void> | void;
  handleCommand?(input: CommandInput): Promise<CommandResult | void> | CommandResult | void;
  suspend?(reason: string): Promise<void> | void;
  resume?(): Promise<void> | void;
  unmount(): Promise<void> | void;
}
```

Notes:

- `mount` and `unmount` are required runtime lifecycle hooks.
- Async support is represented by config and event/command handling, not by a separate module type.
- If a module does not support a command or stream mode, it must fail predictably with a typed error event.

## Mandatory Async Configuration

Async configuration is required in both definition and instance contracts:

- `async.enabled`
- `async.mode`
- `async.request`
- `async.stream`
- `async.queue`

Even if a module is synchronous in behavior, it must still declare:

- `async.enabled: false`
- `async.mode: "none"`
- valid defaults for request/stream/queue blocks

This prevents schema drift when enabling Kafka, GraphQL subscriptions, or other streaming later.

## Inline Build Strategy (Current Platform Fit)

Current shell pipeline already compiles app code into deploy artifacts (`.open-next/worker.js` + `.open-next/assets`).
For module repos, use the same principle:

1. Each module repo outputs:
- compiled web/native entry code
- module definition manifest (validated against definition schema)

2. Shell build step generates a static module registry:
- key: `module_key`
- value: module factory import

3. CMS page data resolves to registry entries by `module_key`.

No runtime code fetching is required in production.

## Suggested Module Repo Output

```text
dist/
  web/index.js
  native/index.js
  module.definition.json
```

`module.definition.json` must validate against:

- `docs/schemas/ui-module-definition.schema.json`

## Versioning and Compatibility

- Contract version field: `contract_version` (semver)
- Module version field: `module_version` (semver)
- Definition includes host compatibility range (`min_host_contract_version`, optional max)
- Breaking changes require a new `module_key` major or clear semver major policy

## CI / Validation Gates

Recommended CI checks:

1. Validate each module definition JSON against `ui-module-definition.schema.json`
2. Validate CMS-exported module instances against `ui-module-instance.schema.json`
3. Validate emitted events against `ui-module-event-envelope.schema.json`
4. Ensure all referenced `module_key` values exist in the generated inline registry

## Security and Capability Model

Capabilities are explicit in definition contract (`network`, `storage`, `navigation`, etc.).
Host runtime should enforce capability checks before allowing commands or resource access.

## Examples

- `docs/examples/ui-module-definition.calendar.v1.json`
- `docs/examples/ui-module-instance.calendar-home.json`
- `docs/examples/ui-module-event.calendar-selected.json`

