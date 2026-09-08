# OpenAI-compatible and local reasoning models

M4.8 adds `OpenAICompatibleAdapter` from `@veyraoss/openai` and the built-in provider `openai-compatible`. It supports planner, reviewer and judge roles through an explicitly configured Chat Completions endpoint. The existing `openai` provider still uses the official OpenAI Responses adapter; its endpoint and behavior are unchanged. Core receives either implementation through the same protocol contracts.

## Configuration

```yaml
agents:
  planner:
    provider: openai-compatible
    model: your-installed-model-id
    options:
      role: planner
      baseURL: http://127.0.0.1:11434/v1
      responseFormat: json_object
      timeoutMs: 120000
      maxOutputTokens: 8192
```

`baseURL` is required and must include the server's API prefix. The adapter appends `/chat/completions`, preserving custom prefixes. HTTPS endpoints are accepted; plain HTTP is limited to `localhost`, IPv4 loopback and `[::1]`. URLs cannot contain credentials, queries or fragments. Redirects are refused so requests and credentials cannot silently move to another endpoint. This validation does not sandbox a configured service or verify its privacy policy.

The adapter sends one non-streaming request with `model`, system/user `messages`, `max_tokens` and `stream: false`. It does not assume Responses support, developer messages, tools, vision, web access, conversation storage or server-side sessions. The service controls its own logging, model loading and data retention. Reasoning/provider-specific fields returned beside the final assistant content are not persisted.

`model` is required and names the model on that server (up to 512 characters). Optional `id` is at most 128 characters. `role` can restrict the adapter to planner, reviewer or judge; otherwise the workflow role selects the contract. Timeout defaults to 120 seconds, accepts 1–86400000 milliseconds and can be overridden by ephemeral run controls. The output-token limit defaults to 8192 and accepts 1–65536. A server/model may impose a smaller limit. Unknown options are rejected.

## Output support and explicit fallback

| `responseFormat` | Request behavior                                                          | Advertised capabilities          |
| ---------------- | ------------------------------------------------------------------------- | -------------------------------- |
| `text` (default) | Omits `response_format`; the system prompt supplies the exact JSON schema | `reasoning`                      |
| `json_object`    | Requests JSON object mode; the prompt supplies the role schema            | `reasoning`                      |
| `json_schema`    | Requests a strict named JSON schema in the Chat Completions format        | `reasoning`, `structured-output` |

Choose a mode the server **and model** support. JSON object mode alone does not promise schema conformance; `structured-output` is conservatively advertised only for explicit schema mode. All three paths perform the same strict local JSON/schema and artifact-evidence validation. Invalid JSON, Markdown wrappers, missing/extra fields, invented evidence, contradictory review verdicts, tool calls, and truncated responses fail. Text mode never treats arbitrary prose as success.

There is no automatic downgrade, retry, endpoint substitution or model substitution. If a server rejects schema mode, explicitly configure `json_object` or `text` after checking its support. Adjust any workflow `requires.capabilities` consistently; the adapter cannot satisfy a `structured-output` requirement in those weaker modes. Selecting schema mode declares configured support; it does not prove the server honors that request. [Capability matching](CAPABILITIES.md) and local validation remain separate checks.

## Authentication and readiness

Omit `apiKeyEnv` for an unauthenticated local server. In that case no Authorization header is sent, even when `OPENAI_API_KEY` or other provider credentials exist. To authenticate, set an environment variable and name it with `apiKeyEnv: LOCAL_MODEL_API_KEY`; only that variable supplies the Bearer header. Never put a key in YAML or the endpoint URL. An explicitly named missing/blank credential fails before HTTP. No native provider login or ambient base-URL setting is read.

Readiness validates configuration and named credential presence without sending HTTP requests. `ready` with scope `configuration` means only that setup is present; server reachability, model access and output-mode support remain untested. `ve doctor --json` reports this distinction and never prints key values.

Inputs are limited to 256 KiB, HTTP bodies to 512 KiB and final assistant content to 256 KiB. The Runtime deadline covers headers and the entire response body; cancellation closes stalled readers. Only exactly one normally stopped assistant choice is accepted. Provider refusal/content filtering and authentication rejection return `needs_input`. Other non-normal finish reasons fail even when partial text looks valid.

Usage maps reported prompt, completion, total, cached-prompt and reasoning token counts when they are valid nonnegative integers. Missing counters and cost remain unknown. Normalized errors omit raw server bodies and transport exceptions. Input/output sanitization removes credential-shaped fields, the selected key and its URL-encoded variants, and Bearer strings. This is not a guarantee that an unknown secret embedded in arbitrary project text will be recognized.

## Local examples

[Ollama's compatibility reference](https://docs.ollama.com/api/openai-compatibility) documents its Chat Completions endpoint, JSON mode and `max_tokens`; support differs across endpoints and features. Start your Ollama server, install/select a model yourself, and replace `replace-with-installed-model` in [the Ollama configuration](../examples/providers/ollama.yaml). Its example uses JSON object mode on port 11434.

[LM Studio's structured-output documentation](https://lmstudio.ai/docs/developer/openai-compat/structured-output) describes the schema request used here and notes that model support varies. Start its local server, load a suitable model and replace `replace-with-loaded-model` in [the LM Studio configuration](../examples/providers/lmstudio.yaml). Its example selects schema mode on port 1234. Set `apiKeyEnv` when that server requires authentication.

Both examples use a [planning workflow with a human gate](../examples/workflows/v1/local-plan.yaml), without an executor or shell command. Run from this repository after building:

```bash
pnpm ve -- workflow validate ../workflows/v1/local-plan.yaml --config examples/providers/ollama.yaml
pnpm ve -- doctor --config examples/providers/ollama.yaml
pnpm ve -- run "Plan a small tested improvement from the supplied context" --config examples/providers/ollama.yaml
```

Substitute `lmstudio.yaml` for the other example. Config-relative workflow paths remain valid. A successful plan pauses at its human gate (exit 3). Inspect the planner's `agent.completed` result in `.veyra/runs/<run-id>/events.jsonl` under the config directory and confirm the pending gate with `ve status` before approving through `ve resume --approve`, using the same config. `ve review` summarizes reviewer and verifier results, which this planning-only workflow does not produce. Model installation, service startup and model quality are user/provider responsibilities; Veyra does not download models automatically.

## Failures and verification

- Connection/TLS/redirect failure: start the server, check the API prefix and configure the final endpoint directly.
- HTTP 401/403: check `apiKeyEnv`, server authentication and model access.
- HTTP 404: check the API prefix and that the selected model is installed/loaded.
- HTTP 400/422: check output mode, model support, context and token limits; change modes explicitly.
- HTTP 429 or 5xx: inspect capacity, server logs and available memory before retrying.
- Timeout: inspect model loading and server health, then adjust `timeoutMs` if appropriate.
- Invalid/incomplete output: inspect model/schema support and token/context limits; no unvalidated result is accepted.

The default tests use deterministic responses and disposable loopback HTTP servers. They cover actual endpoint paths, credential selection, output formats, refusal and error normalization, body limits, cancellation, redirect rejection, and CLI run/approval/resume integration. They require no external network, installed local-model service or credential. These tests verify the adapter contract; they do not claim live Ollama/LM Studio model inference was performed.
