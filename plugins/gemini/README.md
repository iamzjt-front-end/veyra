# @veyra/gemini

Status: **API adapter implemented and deterministically verified; live smoke blocked by missing `GEMINI_API_KEY`**. See [M4.5](https://github.com/iamzjt-front-end/veyra/blob/main/docs/TODO.md#m45--gemini-api-provider) for evidence and the unblock command.

Planner/reviewer adapter for the Gemini Developer API, with structured results, bounded HTTP transport and opt-in image understanding for documented model IDs. All input/output crosses `@veyra/protocol`; deadlines use `@veyra/runtime`.

See [configuration, capabilities and smoke testing](https://github.com/iamzjt-front-end/veyra/blob/main/docs/GEMINI.md). The same package also exports the Gemini CLI adapter; see its [reference](https://github.com/iamzjt-front-end/veyra/blob/main/docs/GEMINI-CLI.md).

This package is a release candidate and is not published yet. See the [package strategy](https://github.com/iamzjt-front-end/veyra/blob/main/docs/PACKAGES.md).
