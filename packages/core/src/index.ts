import type { AgentAdapter, EventSink } from "@veyra/protocol";
import { assertWorkflow, resolveNextStep, type StepOutcome, type WorkflowDefinition } from "@veyra/workflow";

export interface RunRequest {
  goal: string;
  workflow: WorkflowDefinition;
  agents: Record<string, AgentAdapter>;
}

export interface RunResult {
  runId: string;
  status: "completed" | "failed" | "paused";
  lastStep?: string;
}

export interface VeyraEngineOptions {
  emit?: EventSink;
}

export class VeyraEngine {
  readonly #emit: EventSink;

  constructor(options: VeyraEngineOptions = {}) {
    this.#emit = options.emit ?? (() => undefined);
  }

  async run(request: RunRequest): Promise<RunResult> {
    assertWorkflow(request.workflow);

    const runId = crypto.randomUUID();
    await this.#emit({ type: "run.started", runId, goal: request.goal, at: now() });

    let stepId: string | undefined = request.workflow.start;

    try {
      while (stepId) {
        const currentStepId = stepId;
        const step = request.workflow.steps[currentStepId];
        if (!step) throw new Error(`Missing step '${currentStepId}'.`);

        await this.#emit({ type: "step.started", runId, stepId: currentStepId, at: now() });

        if (step.type === "end") {
          await this.#emit({ type: "step.completed", runId, stepId: currentStepId, at: now() });
          await this.#emit({ type: "run.completed", runId, at: now() });
          return { runId, status: "completed", lastStep: currentStepId };
        }

        if (step.type === "human") {
          await this.#emit({
            type: "approval.required",
            runId,
            stepId: currentStepId,
            message: step.message ?? "Human approval required.",
            at: now(),
          });
          return { runId, status: "paused", lastStep: currentStepId };
        }

        let outcome: StepOutcome;

        if (step.type === "agent") {
          if (!step.agent) throw new Error(`Agent step '${currentStepId}' has no agent key.`);
          const adapter = request.agents[step.agent];
          if (!adapter) throw new Error(`Agent '${step.agent}' is not registered.`);

          const result = await adapter.run({
            runId,
            stepId: currentStepId,
            role: step.agent,
            goal: request.goal,
          });

          outcome = {
            status: result.outcome ?? result.status,
            data: result.data,
          };
        } else {
          throw new Error(`Step type '${step.type}' is defined but not implemented in v0.1 scaffold.`);
        }

        await this.#emit({ type: "step.completed", runId, stepId: currentStepId, at: now() });
        stepId = resolveNextStep(step, outcome);

        if (!stepId) {
          await this.#emit({ type: "run.completed", runId, at: now() });
          return { runId, status: "completed", lastStep: currentStepId };
        }
      }

      await this.#emit({ type: "run.completed", runId, at: now() });
      return { runId, status: "completed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({ type: "run.failed", runId, message, at: now() });
      return { runId, status: "failed", lastStep: stepId };
    }
  }
}

function now(): string {
  return new Date().toISOString();
}
