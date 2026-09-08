# Basic example

Start with [GPT Planner + Codex Executor](../gallery/gpt-codex/veyra.yaml) in the [example gallery](../gallery/README.md). It uses the implemented development preset:

```text
planner → executor → verifier → reviewer
                           ↑         |
                           └── fix ──┘
```

Copy the configuration into a disposable project, replace the model placeholders, supply the required provider setup and inspect the project's verification scripts. The gallery includes provider-free human-gate and CI examples, prerequisites and commands. Deterministic tests verify the flows; live provider readiness and the blocked v0.1 smoke are reported separately in the TODO.
