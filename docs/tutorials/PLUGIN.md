# Author a local provider plugin

This example implements a small local text-statistics adapter. It measures the supplied goal; it does not claim to call or simulate a model. The real CLI imports it through the public plugin contract, records its input/result and returns the computed character count. Start with a [built checkout](../DEVELOPMENT.md) and a disposable directory.

## Implement the contract

Create `goal-stats.mjs` in that directory:

```js
/** @satisfies {import("@veyraoss/sdk").VeyraPlugin} */
const plugin = {
  apiVersion: 1,
  provider: "goal-stats",
  version: "1.0.0",
  createAgent(agent) {
    return {
      id: agent.id,
      provider: "goal-stats",
      describe() {
        return {
          schemaVersion: 1,
          id: agent.id,
          provider: "goal-stats",
          adapterVersion: "1.0.0",
          roles: ["analyzer"],
          capabilities: ["structured-output"],
        };
      },
      async run(input, controls) {
        controls?.signal?.throwIfAborted();
        const characters = [...input.goal].length;
        return {
          status: "success",
          summary: `Measured ${characters} Unicode code points in the goal.`,
          data: { characters },
        };
      },
    };
  },
};

export default plugin;
```

The factory has no effects; work happens in `run`. The descriptor advertises only the custom role and output behavior implemented here. The loop counts Unicode code points, not tokens or grapheme clusters. Cancellation is checked before this bounded local computation. No environment values, raw errors or goal text are copied to the result.

The JSDoc annotation is for strict editor/type checking when `@veyraoss/sdk` is available in the author's development dependencies; the module needs no runtime imports. TypeScript authors can use `satisfies VeyraPlugin` and compile to ESM JavaScript before configuring the CLI. The loader accepts local `.js`, `.mjs` and `.cjs`, not `.ts`. Packages remain unpublished candidates; source contributors can use the built workspace SDK. Exact third-party implementation versions are independent from `apiVersion: 1` and official package versions.

## Configure and run

Create `veyra.yaml`:

```yaml
version: 1
workflow:
  use: ./workflow.yaml
plugins:
  goal-stats:
    module: ./goal-stats.mjs
    version: 1.0.0
agents:
  analyze:
    provider: goal-stats
```

Create `workflow.yaml`:

```yaml
name: analyze-goal
version: 1
start: analyze
steps:
  analyze:
    type: agent
    agent: analyze
    requires:
      role: analyzer
      capabilities: [structured-output]
    next: done
  done:
    type: end
```

From the checkout, replace `/absolute/workshop` with the disposable directory:

```sh
pnpm ve -- workflow validate /absolute/workshop/workflow.yaml --config /absolute/workshop/veyra.yaml
pnpm ve -- run "Hello Veyra" --config /absolute/workshop/veyra.yaml --allow-plugin goal-stats --json
pnpm ve -- review --config /absolute/workshop/veyra.yaml --json
```

Validation does not import the module. After you inspect the module/dependencies, `--allow-plugin goal-stats` explicitly permits import and execution for this command. The run exits 0, and its `agent.completed` result reports **11** characters. Omit the trust flag and execution is refused before import. Change the configured version to `2.0.0` and execution is refused for a version mismatch after import. Restore `1.0.0` to run again. Status/review do not import plugins; resume requires the trust flag again.

Import executes arbitrary trusted JavaScript with the host process's filesystem, environment and network privileges. Declared version checks are not integrity verification or a sandbox. Do not grant trust to a module just because this tutorial's module is small. A plugin without a readiness probe reports unknown readiness; this example intentionally makes no account or service readiness claim.

## Adapt this to a model or native provider

Keep the same adapter boundary. Translate the full `AgentInput` envelope, including `instructionSources`, role profile, context provenance and named inputs, into the provider request. Preserve the distinction between trusted instructions and untrusted evidence; do not forward only `goal` as a real provider's complete prompt. Normalize provider output into `AgentResult` and validate structured outcomes. Report failures with safe codes/messages, and return usage only when actually supplied or measured.

Use environment-variable names in options and native login for credentials. Honor `signal`, `timeoutMs` and `cwd`; use Runtime's process runner for native CLIs so cancellation drains children. A read-only readiness probe must state whether it checks configuration, the local executable or a remote service. LLM review remains distinct from shell/test verification in Verifier.

Test success, malformed output, failure, cancellation, version/trust rejection and secret handling using a local fake transport or process fixture. Keep any real provider smoke explicitly opt-in. See the [SDK/plugin contract](../PLUGINS.md), [protocol](../PROTOCOL.md), [prompt source rules](../PROMPT-SAFETY.md), [authentication](../AUTHENTICATION.md) and [test strategy](../TESTING.md).
