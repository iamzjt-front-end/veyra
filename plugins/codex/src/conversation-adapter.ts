import { realpath } from "node:fs/promises";
import {
  isSessionId,
  type AgentAdapter,
  type AgentInput,
  type AgentResult,
  type AgentRunOptions,
  type NativeConversation,
  type ProjectDescriptor,
  type JsonObject,
} from "@veyraoss/protocol";
import { createSecretRedactor, type ProcessRunner } from "@veyraoss/runtime";
import { CodexAdapter, buildPrompt } from "./index.js";
import { CodexOutput, resultSchema } from "./output.js";
import { NativeApprovalRequired, record, withAppServer } from "./app-server.js";
import { checkCodexConversation, requireConversationRoot } from "./conversations.js";

/** Append exactly one turn to the explicitly selected task. Never creates a thread or forks. */
export class CodexConversationAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly provider = "codex";
  constructor(
    private readonly selected: NativeConversation,
    private readonly project: ProjectDescriptor,
    private readonly executable: string,
    private readonly dependencies: { env: NodeJS.ProcessEnv; runProcess?: ProcessRunner },
  ) {}
  describe() {
    return new CodexAdapter({ executable: this.executable }).describe();
  }
  async checkReadiness(options: AgentRunOptions = {}) {
    const readiness = await new CodexAdapter(
      { executable: this.executable },
      this.dependencies,
    ).checkReadiness(options);
    if (readiness.status !== "ready") return readiness;
    try {
      await checkCodexConversation(
        {
          executable: this.executable,
          cwd: this.project.root,
          env: this.dependencies.env,
          runner: this.dependencies.runProcess,
          signal: options.signal,
        },
        this.selected,
      );
      return readiness;
    } catch (error) {
      return {
        status: "unavailable" as const,
        scope: "local" as const,
        message: createSecretRedactor({ env: this.dependencies.env }).text(String(error)),
      };
    }
  }
  async run(input: AgentInput, options: AgentRunOptions = {}): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const redactor = createSecretRedactor({ env: this.dependencies.env });
    let resumed = false;
    let turnId: string | undefined;
    let result: AgentResult;
    try {
      if (
        !isSessionId(input.runId) ||
        !isSessionId(this.selected.id) ||
        (await realpath(options.cwd ?? this.project.root)) !==
          (await realpath(this.project.root)) ||
        (await realpath(this.selected.root)) !== (await realpath(this.project.root))
      )
        throw new Error("Codex task does not match the bound Project directory.");
      const prompt = buildPrompt(input, this.dependencies.env);
      if (Buffer.byteLength(prompt) > 256 * 1024)
        throw new Error("Codex task input exceeds 256 KiB.");
      result = await withAppServer(
        {
          executable: this.executable,
          cwd: this.project.root,
          env: this.dependencies.env,
          runner: this.dependencies.runProcess,
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? 15 * 60_000,
        },
        async (rpc, subscribe) => {
          const metadata = await rpc.call("thread/read", {
            threadId: this.selected.id,
            includeTurns: false,
          });
          await requireConversationRoot(
            record(metadata) ? metadata.thread : undefined,
            this.selected,
          );
          const response = await rpc.call("thread/resume", {
            threadId: this.selected.id,
            excludeTurns: true,
            sandbox: "workspace-write",
            approvalPolicy: "on-request",
          });
          await requireConversationRoot(
            record(response) ? response.thread : undefined,
            this.selected,
          );
          resumed = true;
          let settle!: (result: AgentResult) => void;
          let reject!: (error: Error) => void;
          const completion = new Promise<AgentResult>((resolve, fail) => {
            settle = resolve;
            reject = fail;
          });
          void completion.catch(() => {});
          const output = new CodexOutput();
          const notifications: { method: string; params: unknown }[] = [];
          const receive = (method: string, params: unknown) => {
            if (!record(params) || params.threadId !== this.selected.id) return;
            if (!turnId) {
              if (notifications.length >= 256)
                throw new Error("Codex sent too many uncorrelated events.");
              notifications.push({ method, params });
              return;
            }
            if (
              method === "item/completed" &&
              params.turnId === turnId &&
              record(params.item) &&
              params.item.type === "agentMessage"
            )
              output.feed(
                `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: params.item.text } })}\n`,
              );
            if (method !== "turn/completed" || !record(params.turn) || params.turn.id !== turnId)
              return;
            if (params.turn.status !== "completed") {
              reject(
                new Error(
                  "The selected Codex turn did not complete. Inspect it before sending another task.",
                ),
              );
              return;
            }
            output.feed('{"type":"turn.completed"}\n');
            const parsed = output.finish();
            if (!parsed)
              reject(
                new Error("Codex completed without a valid structured result; do not replay."),
              );
            else settle(parsed);
          };
          subscribe(receive);
          // No cwd, model, history or alternative thread ID supplied by the planner.
          const started = await rpc.call("turn/start", {
            threadId: this.selected.id,
            clientUserMessageId: input.runId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            outputSchema: resultSchema,
          });
          if (!record(started) || !record(started.turn) || typeof started.turn.id !== "string")
            throw new Error("Codex turn admission was not confirmed; do not replay.");
          turnId = started.turn.id;
          for (const event of notifications) receive(event.method, event.params);
          return completion;
        },
      );
    } catch (error) {
      const message = redactor.text(
        error instanceof Error ? error.message : "Codex task continuation failed.",
      );
      result =
        error instanceof NativeApprovalRequired
          ? { status: "needs_input", summary: message }
          : {
              status: "failure",
              summary: message,
              error: { code: "codex_conversation_failed", message },
            };
    }
    return {
      ...result,
      summary: redactor.text(result.summary),
      ...(result.data ? { data: redactor.json(result.data) as JsonObject } : {}),
      ...(resumed
        ? {
            session: {
              version: 1,
              kind: "session",
              provider: "codex",
              id: this.selected.id,
              projectId: this.project.id,
              runId: input.runId,
              createdAt: startedAt,
            } as const,
          }
        : {}),
      execution: {
        runId: input.runId,
        stepId: input.stepId,
        ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      },
      timing: {
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: performance.now() - start,
      },
    };
  }
}
