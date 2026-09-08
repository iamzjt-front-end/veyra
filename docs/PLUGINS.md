# Provider plugins and the SDK

M4.2 adds an explicit provider plugin registry to `@veyra/sdk` in this `0.1.0` development checkout. A plugin constructs protocol adapters; Core continues to receive injected `AgentAdapter` instances and never imports provider code or plugin modules. This initial contract covers providers. Custom workflow node/tool registration remains separate work.

## Contract and registration

```ts
import { PluginRegistry, type VeyraPlugin } from "@veyra/sdk";
import { MyAdapter } from "./my-adapter.js";

const plugin = {
  apiVersion: 1,
  provider: "example",
  version: "1.2.3",
  createAgent(agent, context) {
    return new MyAdapter({
      ...context.options,
      ...agent.options,
      ...(agent.model ? { model: agent.model } : {}),
      id: agent.id,
    });
  },
} satisfies VeyraPlugin;

const registry = new PluginRegistry();
registry.register(plugin, { endpoint: "http://127.0.0.1:8080" }, "1.2.3");
const adapter = registry.createAgent("example", {
  id: "planner",
  options: {},
});
// Inject { planner: adapter } into VeyraEngine.
```

`VeyraPlugin` is a plain object with `apiVersion: 1`, `provider`, `version`, a synchronous `createAgent(agent, context)` hook, and optional asynchronous `checkReadiness(agent, context, controls)`. The provider identifier uses lowercase letters/digits separated by `.`, `_`, or `-`, up to 128 characters. Versions use an exact `major.minor.patch` string with optional prerelease/build suffixes; version ranges are unsupported. `isVeyraPlugin` rejects unknown fields, incompatible APIs and getters without invoking hooks.

`PluginAgentConfig` contains the binding `id` (up to 128 characters), optional `model` (up to 512 characters) and JSON `options`. `PluginContext.options` contains the provider namespace settings. Each factory/probe receives independent copies. Plugin options have a 256 KiB serialized JSON limit. A returned adapter must match the requested ID and registered provider and implement `run`; metadata/readiness methods remain optional under the [capability contract](CAPABILITIES.md). Factories should construct adapters without starting work, writing output or contacting services. Agent execution belongs in `run`, and local subprocess lifecycle belongs in `@veyra/runtime`.

Registration does not invoke factories or probes. Each registry owns its registrations; there is no global registry. `list()` returns independent provider/API/version metadata. Duplicate names cannot override built-ins or previous registrations. Incompatible APIs, exact-version mismatches, missing plugins, invalid adapters and thrown factories produce stable `PluginError.code` values and safe diagnostics without raw plugin exceptions.

The CLI explicitly registers OpenAI, Codex and Claude through the same contract in `apps/cli/src/plugins.ts`. Those registrations compose the existing adapter implementations in `plugins/*`; the SDK itself has no vendor imports. Built-in adapter defaults are overridden by namespace options, then agent options, then the explicit agent `model`; the binding always supplies `id`. Third-party plugins own and document their option interpretation.

## Local modules and trust

```yaml
version: 1
workflow:
  use: ./workflow.yaml
plugins:
  example:
    module: ./plugins/example.mjs
    version: 1.2.3
    options:
      endpoint: http://127.0.0.1:8080
agents:
  planner:
    provider: example
    model: configured-model
    options: {}
```

The module must default-export a matching `VeyraPlugin`. Compile/build it locally first and install its dependencies yourself. `module` accepts an explicit relative (`./` or `../`) or absolute `.js`, `.mjs`, or `.cjs` file path. Relative paths resolve from the selected config directory, including when `ve` runs elsewhere. The loader resolves symlinks to an existing regular file and uses Node's native module loader. URLs, package specifiers, executable strings and automatic downloads/installation are unsupported. `.js` files follow their package's module type; `.mjs` is unambiguously ESM.

After reviewing the module and its dependency graph, explicitly authorize each provider for the current command:

```bash
ve run "Plan the change" --allow-plugin example
ve doctor --allow-plugin example
ve resume --approve --allow-plugin example
```

Repeat `--allow-plugin <provider>` for multiple plugins. Trust is not stored in the repository or run state and must be supplied again when resuming. Unknown/mismatched names do not authorize another provider. Required plugin declarations and trust are checked before any requested module imports. Run/resume configure only reachable workflow providers; unused plugins are left unloaded. Doctor diagnoses each configured provider independently and refuses to import an untrusted module; an unavailable required provider fails doctor, while optional failures remain reported.

Loading a plugin executes arbitrary JavaScript, including import-time code and dependencies, with the host process's filesystem, environment and network access. This is a trusted extension mechanism, not a sandbox. Version pins detect declared version mismatches after import; they are not integrity hashes and cannot prevent import-time effects. Built-ins cannot be replaced by configured modules. Review changed plugin files/dependencies before repeating authorization. Native Node import caching applies within a process; restart after changing a module.

Programmatic callers can use `loadLocalPlugin(registry, { provider, module, version, options? }, { cwd, trusted: true })` after making the same trust decision. Direct `register()` likewise assumes trusted in-process code. Neither API installs packages or changes environment authentication.

`ve workflow validate` parses plugin declarations and checks that referenced provider names are built-ins or declared local modules. It never imports code, checks runtime exports/versions, calls factories, or probes services. `status`, `review`, workflow listing, and configuration parsing also leave plugins unloaded. Execution/import/readiness errors identify what must be configured, trusted, built or corrected; they do not claim a declaration proves plugin availability.

## Readiness and authentication

`registry.checkReadiness(provider, agent, controls?)` calls the optional plugin hook. Without it, the registry constructs the adapter and calls its optional `checkReadiness`; if neither has a probe it reports `unknown`. A plugin-level hook can diagnose setup even when the adapter cannot yet be constructed. Probes receive ephemeral `cwd`, `signal`, and `timeoutMs`; they must honor controls, bound output and clean up work. A pre-aborted signal skips probing. Arbitrary trusted JavaScript that ignores cancellation cannot be forcibly stopped by an in-process registry.

Return the same scoped `AgentReadiness` contract as adapter discovery. CLI doctor includes scope, optional version and validated adapter descriptors when construction succeeds. OpenAI and Claude hooks check credential-variable presence only; Codex uses its native bounded version/login-status checks. Plugin loading and ordinary workflow execution do not automatically probe services.

Keep credentials in environment variables or native login. Config/namespace options may name an `apiKeyEnv`, never contain a key. CLI redaction includes credential variables named by agent or plugin namespace options and recognized secret environment names. Providers must normalize/redact all other credentials themselves, return safe readiness messages and avoid writing to CLI stdout. Third-party hooks are responsible for their external effects and secret handling; returning a typed object does not sanitize arbitrary content.

Plugin definitions/configuration and trust flags are not persisted by Core. Saved workflows retain role/capability requirements; fresh adapters are checked again on resume and `agent.selected` records their advertised identity/version for each attempt. The current configuration selects and pins the plugin for the new process. General plugin upgrades/migrations and isolated plugin execution are not implemented here.
