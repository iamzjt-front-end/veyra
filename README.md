# Veyra

> **One goal. Many agents. Verified execution.**

Veyra is an agent control plane for orchestrating heterogeneous AI agents and deterministic tools in one verifiable workflow.

Instead of asking one model to do everything, Veyra is designed around a simple idea: **use the best agent for each job, then verify the result.**

```text
Goal
  ↓
Planner (GPT / Claude / Gemini)
  ↓
Executor (Codex / Claude Code / Gemini CLI / OpenCode)
  ↓
Verifier (tests / lint / build / benchmark)
  ↓
Reviewer (same or different model)
  ↓
PASS → next step
FAIL → repair loop
```

## Why Veyra?

Developers increasingly act as the human message bus between planning models, coding agents, test tools, and reviewers. Veyra is intended to remove that manual coordination layer while keeping deterministic verification, resumable state, and explicit human approval gates.

## Architecture scaffold

The repository keeps the long-term architecture visible from day one. A directory may exist before its implementation milestone is complete.

```text
veyra/
├── apps/
│   ├── cli/                 # `ve` command line
│   ├── tui/                 # terminal mission control
│   └── dashboard/           # Web GUI / control center (planned)
│
├── packages/
│   ├── core/                # orchestration engine
│   ├── workflow/            # Workflow DSL / state machine
│   ├── runtime/             # agent/process runtime
│   ├── verifier/            # shell/test/build verification
│   ├── protocol/            # provider-neutral contracts
│   ├── config/              # configuration parsing
│   └── sdk/                 # third-party extension SDK
│
├── plugins/
│   ├── openai/
│   ├── codex/
│   ├── claude/              # API reasoning adapter
│   ├── claude-code/         # CLI executor adapter
│   ├── gemini/              # API reasoning adapter
│   └── opencode/            # planned
│
├── workflows/
│   ├── dev.yaml
│   ├── bugfix.yaml
│   ├── review.yaml
│   └── research.yaml
│
├── docs/
├── examples/
├── AGENTS.md
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

## CLI workflow

The project is **Veyra**; the public CLI command is intentionally short: **`ve`**.

```bash
ve init
ve run "finish the current milestone"
ve status
ve review
ve resume
ve workflow list
ve workflow validate dev
```

In this checkout use `pnpm ve -- <command>` after building. The commands above work; see the [CLI reference](docs/CLI.md) for provider setup, flags, exit codes, and approval handling. Running `ve` without arguments will eventually open the TUI. The Web dashboard is a later management surface built on the same core event stream.

## Architecture vs implementation

The **architecture scaffold is intentionally stable** while implementation lands incrementally:

| Area        | Scaffold | Current status                    |
| ----------- | -------- | --------------------------------- |
| CLI         | ✓        | headless workflow commands        |
| TUI         | ✓        | scaffolded                        |
| Dashboard   | ✓        | planned                           |
| Core        | ✓        | persisted workflow loop           |
| Workflow    | ✓        | YAML loader and validation        |
| Runtime     | ✓        | local process execution           |
| Verifier    | ✓        | sequential shell checks           |
| Protocol    | ✓        | contracts and JSON guard          |
| Config      | ✓        | YAML loader and validation        |
| SDK         | ✓        | plugin registry and contracts     |
| OpenAI      | ✓        | Responses and compatible adapters |
| Codex       | ✓        | CLI executor adapter              |
| Claude      | ✓        | API adapter; live smoke blocked   |
| Claude Code | ✓        | CLI adapter; live smoke blocked   |
| Gemini      | ✓        | API/CLI adapters; live unverified |
| OpenCode    | ✓        | CLI adapter; live smoke blocked   |

## Implementation plan

Development is intentionally executed one focused task at a time:

- [`docs/TODO.md`](docs/TODO.md) — **canonical detailed implementation TODO**, including task order, dependencies, requirements, tests, and acceptance criteria.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestone-level summary.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — stable package and responsibility boundaries.
- [`AGENTS.md`](AGENTS.md) — rules for Codex and other coding agents contributing to the repository.

The current next task is defined at the bottom of `docs/TODO.md`.

For a first contribution, complete the [development setup](#development), read the coding rules and architecture above, then follow the [next eligible TODO](docs/TODO.md#next-task). The TODO contains implementation truth and acceptance criteria; the roadmap is a summary. Commit history is not required to find the next task.

## Development

Requirements:

- Node.js >= 20
- pnpm 10.15.1 (pinned in `package.json`)

```bash
corepack enable
pnpm install
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm build
pnpm ve -- doctor
```

If Corepack reports `Cannot find matching keyid`, [update Corepack](https://pnpm.io/10.x/installation#using-corepack) to a release compatible with your Node.js version, then retry. On Node.js 22.22.0, `npm install --global corepack@0.34.7` was verified with the pinned pnpm version.

Run `pnpm format` to format the repository. Prettier handles TypeScript, JSON, Markdown, and YAML; Biome supplies the recommended TypeScript/JSON lint rules. Two tools are used because Biome does not yet format Markdown or YAML. Generated build outputs, dependencies, coverage, Turbo cache, and local run state are excluded. TypeScript checking remains a separate `pnpm check` command.

CI runs the same five checks for pull requests and pushes to `main`, using Node.js 22, Corepack, a cached pnpm store, and `pnpm install --frozen-lockfile`. The default suite does not require provider credentials or live API calls.

See [testing conventions](docs/TESTING.md) for deterministic fake agents, unit/integration/E2E test placement, and disposable fixture workspaces.

The [configuration reference](docs/CONFIGURATION.md) documents the implemented version 1 schema and loader. The Core loop, first adapters, and headless CLI commands work; live provider runs require the corresponding accounts and credentials.

The [workflow reference](docs/WORKFLOWS.md) covers preset/file loading, node validation, and outcome transitions.

The [preset reference](docs/PRESETS.md) explains the development, bugfix, read-only review and research flows, their required adapters/commands, bounded repairs and human reports.

The [protocol reference](docs/PROTOCOL.md) defines shared agent/result/event contracts and the boundary between persisted data and execution controls.

The [capability reference](docs/CAPABILITIES.md) covers configured adapter metadata, opt-in readiness discovery and explicit workflow role/capability requirements.

The [plugin reference](docs/PLUGINS.md) defines the public SDK contract, built-in registration, provider namespaces and explicitly trusted local third-party modules.

The [authentication policy](docs/AUTHENTICATION.md) documents credential precedence, native login, scoped readiness and secret redaction.

The [runtime reference](docs/RUNTIME.md) covers local command execution, output limits, cancellation, and platform behavior.

The [verification reference](docs/VERIFICATION.md) describes sequential command checks, aggregate results, and verification events.

The [state reference](docs/STATE.md) documents local snapshots, event history, recovery errors, and the single-writer boundary.

The [Core reference](docs/CORE.md) describes programmatic execution, outcome routing, persisted events, and bounded context.

The [approval reference](docs/APPROVALS.md) covers explicit human gates, decision auditing, and safe pause/resume through the Core API.

The [OpenAI adapter reference](docs/OPENAI.md) covers planner/reviewer configuration, normalized results, and the optional live smoke test.

The [OpenAI-compatible reference](docs/OPENAI-COMPATIBLE.md) covers explicit Chat Completions endpoints, output-mode selection and local Ollama/LM Studio examples.

The [Codex adapter reference](docs/CODEX.md) covers CLI execution, permissions, readiness checks, and the disposable live smoke test.

The [Claude adapter reference](docs/CLAUDE.md) covers planner/reviewer/judge results, usage accounting, deadlines and the opt-in API smoke test.

The [Claude Code reference](docs/CLAUDE-CODE.md) covers native CLI execution, permissions, readiness, bounded diagnostics and the guarded fixture smoke test.

The [Gemini reference](docs/GEMINI.md) covers structured reasoning, explicit inline image input, bounded requests and the guarded API smoke test.

The [Gemini CLI reference](docs/GEMINI-CLI.md) covers native execution, strict result validation, permissions and offline readiness limitations.

The [OpenCode reference](docs/OPENCODE.md) covers the native contract, disabled sharing, event normalization and guarded fixture smoke.

## Current milestone

The first product milestone is the **v0.1 vertical slice**:

1. load `veyra.yaml`
2. load a workflow preset
3. call a planner adapter
4. invoke Codex as executor
5. run deterministic verification commands
6. review the result
7. persist run state
8. retry or stop at a human approval gate

Start with [`docs/TODO.md`](docs/TODO.md), then consult [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/ROADMAP.md`](docs/ROADMAP.md).
