# @veyra/gemini

Status: **API adapter implemented and deterministically verified; live smoke blocked by missing `GEMINI_API_KEY`**. See [M4.5](../../docs/TODO.md#m45--gemini-api-provider) for evidence and the unblock command.

Planner/reviewer adapter for the Gemini Developer API, with structured results, bounded HTTP transport and opt-in image understanding for documented model IDs. All input/output crosses `@veyra/protocol`; deadlines use `@veyra/runtime`.

See [configuration, capabilities and smoke testing](../../docs/GEMINI.md). Gemini CLI execution remains a later task.
