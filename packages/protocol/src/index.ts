export type AgentRole =
  "planner" | "researcher" | "executor" | "reviewer" | "judge" | (string & {});

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ExecutionMetadata {
  runId: string;
  stepId: string;
  attemptId?: string;
  attempt?: number;
  parentStepId?: string;
}

export interface ExecutionTiming {
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

export interface UsageMetadata {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  cost?: {
    amount: number;
    currency: string;
  };
}

/** Persist a normalized failure, never a native Error or a raw provider response. */
export interface SerializedError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonObject;
}

export interface AgentInput extends ExecutionMetadata {
  role: AgentRole;
  goal: string;
  instructions?: string;
  context?: JsonObject;
  artifacts?: ArtifactRef[];
}

export interface ArtifactRef {
  id: string;
  kind: string;
  path?: string;
  mediaType?: string;
  sizeBytes?: number;
  createdAt?: string;
  producer?: ExecutionMetadata;
  metadata?: JsonObject;
}

export interface AgentResult {
  status: "success" | "failure" | "needs_input";
  summary: string;
  outcome?: string;
  artifacts?: ArtifactRef[];
  data?: JsonObject;
  execution?: ExecutionMetadata;
  timing?: ExecutionTiming;
  usage?: UsageMetadata;
  error?: SerializedError;
}

/** Ephemeral execution controls; these never belong in persisted AgentInput or events. */
export interface AgentRunOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AgentAdapter {
  readonly id: string;
  readonly provider: string;
  run(input: AgentInput, options?: AgentRunOptions): Promise<AgentResult>;
}

export interface VerificationResult {
  success: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  durationMs: number;
  execution?: ExecutionMetadata;
  signal?: string;
  error?: SerializedError;
  artifacts?: ArtifactRef[];
}

/** Latest persisted output of one step; artifact paths are references, never file contents. */
export type StepOutput =
  | {
      type: "agent";
      outcome: string;
      summary: string;
      data?: JsonObject;
      artifacts?: ArtifactRef[];
    }
  | {
      type: "command";
      outcome: "success" | "failure";
      results: VerificationResult[];
      artifacts?: ArtifactRef[];
    }
  | { type: "human"; outcome: ApprovalDecision; comment?: string }
  | { type: "router"; outcome: string; target: string; selection: "static" | "input" }
  | {
      type: "subworkflow";
      outcome: "success" | "failure";
      outputs?: JsonObject;
      error?: SerializedError;
    }
  | { type: "parallel"; outcome: "success" | "failure"; results: ParallelChildResult[] };

export interface ParallelChildResult {
  stepId: string;
  status: "pending" | "success" | "failure" | "needs_input" | "cancelled" | "skipped";
  attemptId?: string;
  attempt?: number;
  outcome?: string;
  /** References the persisted result/failure event in this run; avoids duplicating large output. */
  outputEventId?: string;
  error?: SerializedError;
}

export interface EventMetadata {
  runId: string;
  at: string;
  eventId?: string;
  sequence?: number;
}

interface StepEventMetadata {
  stepId: string;
  attemptId?: string;
  attempt?: number;
  parentStepId?: string;
}

interface AgentEventMetadata extends StepEventMetadata {
  agentId: string;
  provider?: string;
  role?: AgentRole;
}

export type ApprovalDecision = "approved" | "rejected";

export type VeyraEvent = EventMetadata &
  (
    | { type: "run.started"; goal: string; workflowName?: string }
    | { type: "run.completed"; timing?: ExecutionTiming; usage?: UsageMetadata }
    | { type: "run.failed"; message: string; error?: SerializedError }
    | { type: "run.paused"; stepId?: string; reason?: string }
    | { type: "run.resumed"; stepId?: string }
    | (StepEventMetadata & { type: "step.started" })
    | (StepEventMetadata & { type: "step.retrying"; retryCount: number; maxRetries: number })
    | (StepEventMetadata & { type: "step.completed"; outcome?: string; artifacts?: ArtifactRef[] })
    | (StepEventMetadata & { type: "step.failed"; message: string; error?: SerializedError })
    | (StepEventMetadata & {
        type: "router.selected";
        route: string;
        target: string;
        selection: "static" | "input";
        source?: { stepId: string; path: string };
      })
    | (StepEventMetadata & {
        type: "subworkflow.started";
        workflowName: string;
        childStepId: string;
        inputs: JsonObject;
      })
    | (StepEventMetadata & {
        type: "subworkflow.completed";
        success: boolean;
        outputs?: JsonObject;
        error?: SerializedError;
      })
    | (StepEventMetadata & { type: "subworkflow.paused"; childStepId: string; reason: string })
    | (StepEventMetadata & {
        type: "parallel.started";
        children: string[];
        concurrency: number;
        failurePolicy: "wait-all" | "fail-fast";
      })
    | (StepEventMetadata & {
        type: "parallel.child.completed";
        parentStepId: string;
        result: ParallelChildResult;
      })
    | (StepEventMetadata & {
        type: "parallel.completed";
        success: boolean;
        results: ParallelChildResult[];
      })
    | (StepEventMetadata & { type: "parallel.paused"; results: ParallelChildResult[] })
    | (AgentEventMetadata & { type: "agent.started" })
    | (AgentEventMetadata & { type: "agent.input"; input: AgentInput })
    | (AgentEventMetadata & { type: "agent.completed"; result: AgentResult })
    | (AgentEventMetadata & { type: "agent.failed"; error: SerializedError })
    | (StepEventMetadata & { type: "verification.started"; commands: string[] })
    | (StepEventMetadata & {
        type: "verification.completed";
        success: boolean;
        results: VerificationResult[];
      })
    | (StepEventMetadata & {
        type: "approval.required";
        message: string;
        approvalId?: string;
        context?: JsonObject;
      })
    | (StepEventMetadata & {
        type: "approval.resolved";
        decision: ApprovalDecision;
        approvalId?: string;
        comment?: string;
      })
    | (StepEventMetadata & {
        type: "process.output";
        stream: "stdout" | "stderr";
        artifact: ArtifactRef;
        preview?: string;
      })
  );

export type EventSink = (event: VeyraEvent) => void | Promise<void>;
export { isJsonValue } from "./json.js";
