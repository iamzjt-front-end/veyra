# @veyraoss/codex

Codex CLI executor adapter.

Reuses the installed native client's existing authentication; no OpenAI API key is required for Veyra's default executor path. `CodexAdapter.doctor()` runs bounded `--version` and `login status` probes without exposing raw login output or reading/copying credential files. An explicit `executable` option selects a local binary. CLI users can run `ve doctor --codex-executable /path/to/codex`; optional API workflows are checked with `ve doctor --config veyra.yaml`.

This package is a release candidate in the Veyra monorepo; it is not published yet. See the [package strategy](https://github.com/iamzjt-front-end/veyra/blob/main/docs/PACKAGES.md) for scope ownership and release gates, and the [project documentation](https://github.com/iamzjt-front-end/veyra#development) for usage and development.
