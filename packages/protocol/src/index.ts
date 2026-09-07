export type AgentRole =
  | "planner"
  | "researcher"
  | "executor"
  | "reviewer"
  | "judge"
  | (string & {});

export interface AgentInput {
  runId: string;
  stepId: string;
  role: AgentRole;
  goal: string;
  instructions?: string;
  context?: Record<string, unknown>;
  artifacts?: ArtifactRef[];
}

export interface ArtifactRef {
  id: string;
  kind: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentResult {
  status: "success" | "failure" | "needs_input";
  summary: string;
  outcome?: string;
  artifacts?: ArtifactRef[];
  data?: Record<string, unknown>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly provider: string;
  run(input: AgentInput): Promise<AgentResult>;
}

export interface VerificationResult {
  success: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type VeyraEvent =
  | { type: "run.started"; runId: string; goal: string; at: string }
  | { type: "run.completed"; runId: string; at: string }
  | { type: "run.failed"; runId: string; message: string; at: string }
  | { type: "step.started"; runId: string; stepId: string; at: string }
  | { type: "step.completed"; runId: string; stepId: string; at: string }
  | { type: "step.failed"; runId: string; stepId: string; message: string; at: string }
  | { type: "approval.required"; runId: string; stepId: string; message: string; at: string };

export type EventSink = (event: VeyraEvent) => void | Promise<void>;
