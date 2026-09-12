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
import {
  checkCodexConversation,
  requireConversationRoot,
  requireIdleConversation,
} from "./conversations.js";

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
          if (rpc.shared)
            requireIdleConversation(record(metadata) ? metadata.thread : undefined, true);
          const response = await rpc.call("thread/resume", {
            threadId: this.selected.id,
            excludeTurns: true,
            ...(!rpc.shared ? { sandbox: "workspace-write", approvalPolicy: "on-request" } : {}),
          });
          await requireConversationRoot(
            record(response) ? response.thread : undefined,
            this.selected,
          );
          if (rpc.shared) requireIdleConversation(record(response) ? response.thread : undefined);
          resumed = true;
          let submitted = false;
          let owned = !rpc.shared;
          let terminal = false;
          let firstUser: string | null | undefined;
          let stopped!: () => void;
          const stopConfirmed = new Promise<void>((resolve) => {
            stopped = resolve;
          });
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
              rpc.shared &&
              (method === "item/started" || method === "item/completed") &&
              params.turnId === turnId &&
              record(params.item) &&
              params.item.type === "userMessage"
            ) {
              if (firstUser === undefined) {
                firstUser = typeof params.item.clientId === "string" ? params.item.clientId : null;
                owned = firstUser === input.runId;
              }
              if (!owned || params.item.clientId !== input.runId) {
                // Another client started or steered this turn. Its execution is not ours to cancel.
                owned = false;
                reject(
                  new Error(
                    "Codex received input from another client. Inspect this task; Veyra will not replay or interrupt it.",
                  ),
                );
                return;
              }
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
            if (!["completed", "failed", "interrupted"].includes(String(params.turn.status))) {
              reject(
                new Error(
                  "Codex did not provide a valid terminal state. Inspect this task before continuing.",
                ),
              );
              return;
            }
            terminal = true;
            stopped();
            if (!owned) {
              reject(
                new Error(
                  "Codex turn ownership was not confirmed. Inspect this task; do not replay.",
                ),
              );
              return;
            }
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
          rpc.onClose?.(async () => {
            if (!submitted || terminal) return;
            if (!turnId || !owned) throw new Error("Codex turn ownership is uncertain.");
            await rpc.call("turn/interrupt", { threadId: this.selected.id, turnId });
            let timer!: ReturnType<typeof setTimeout>;
            try {
              await Promise.race([
                stopConfirmed,
                new Promise<never>((_, fail) => {
                  timer = setTimeout(
                    () => fail(new Error("Codex interruption was not confirmed.")),
                    3000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          });
          if (rpc.shared) {
            // Recheck immediately before sending: never intentionally steer a desktop turn.
            const current = await rpc.call("thread/read", {
              threadId: this.selected.id,
              includeTurns: false,
            });
            await requireConversationRoot(
              record(current) ? current.thread : undefined,
              this.selected,
            );
            requireIdleConversation(record(current) ? current.thread : undefined);
          }
          // No cwd, model, history or alternative thread ID supplied by the planner.
          submitted = true;
          const started = await rpc.call("turn/start", {
            threadId: this.selected.id,
            clientUserMessageId: input.runId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            outputSchema: resultSchema,
            ...(rpc.shared
              ? {
                  approvalPolicy: "on-request",
                  sandboxPolicy: {
                    type: "workspaceWrite",
                    writableRoots: [this.project.root],
                    networkAccess: false,
                    excludeTmpdirEnvVar: true,
                    excludeSlashTmp: true,
                  },
                }
              : {}),
          });
          if (!record(started) || !record(started.turn) || !isSessionId(started.turn.id))
            throw new Error("Codex turn admission was not confirmed; do not replay.");
          turnId = started.turn.id;
          if (rpc.shared && Array.isArray(started.turn.items)) {
            const first = started.turn.items.find(
              (item) => record(item) && item.type === "userMessage",
            );
            if (record(first))
              receive("item/started", { threadId: this.selected.id, turnId, item: first });
          }
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
