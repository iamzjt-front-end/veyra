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
    | (StepEventMetadata & { type: "step.completed"; outcome?: string; artifacts?: ArtifactRef[] })
    | (StepEventMetadata & { type: "step.failed"; message: string; error?: SerializedError })
    | (AgentEventMetadata & { type: "agent.started" })
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
