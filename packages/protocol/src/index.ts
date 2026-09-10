import type { WorkspaceInfo } from "./workspace.js";
import type { InstructionSource, ContextProvenance } from "./provenance.js";
export {
  PROMPT_SAFETY_GUIDANCE,
  isProjectInstructions,
  isInstructionSources,
  isEvidenceReference,
  isContextProvenance,
  type ProjectInstruction,
  type InstructionSource,
  type EvidenceReference,
  type ContextProvenance,
} from "./provenance.js";
export type AgentRole =
  "planner" | "researcher" | "executor" | "reviewer" | "judge" | (string & {});

import type { AgentRoleProfile } from "./profiles.js";
import type { AgentRoutingDecision } from "./routing.js";
export {
  isAgentRoutingPolicy,
  isAgentRoutingBinding,
  isAgentRoutingDecision,
  routingFailureCategory,
  type AgentRoutingPolicy,
  type AgentRoutingDecision,
  type AgentRoutingAttempt,
  type AgentRoutingReason,
  type AgentFallbackReason,
} from "./routing.js";
export {
  getAgentRoleProfile,
  listAgentRoleProfiles,
  isAgentRoleProfile,
  type AgentRoleProfile,
  type StandardAgentRole,
  type RoleContextPath,
} from "./profiles.js";

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

/** Optional declared ceilings; accounting/reservation is supplied by an application budget hook. */
export interface BudgetLimits {
  maxTokens?: number;
  maxCost?: { amount: number; currency: string };
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
  instructionSources?: InstructionSource[];
  projectInstructionState?: "captured" | "absent" | "legacy-unavailable";
  context?: JsonObject;
  artifacts?: ArtifactRef[];
  /** Exact provider-neutral role guidance used for this invocation; optional for legacy/custom roles. */
  profile?: AgentRoleProfile;
}

/** Run-level evidence may omit a step; step-produced artifacts retain its attempt identity. */
export interface ArtifactProducer {
  runId: string;
  stepId?: string;
  attemptId?: string;
  attempt?: number;
  parentStepId?: string;
}

export interface ArtifactRef {
  id: string;
  kind: string;
  path?: string;
  mediaType?: string;
  sizeBytes?: number;
  createdAt?: string;
  producer?: ArtifactProducer;
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
  /** Optional safe locator. Native credentials/history remain owned by the native client. */
  session?: import("./session.js").NativeSessionReference;
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
  /** Synchronous, side-effect-free metadata for this configured adapter. */
  describe?(): AgentDescriptor;
  /** Opt-in readiness probe; never return credentials or raw authentication output. */
  checkReadiness?(options?: AgentRunOptions): Promise<AgentReadiness>;
  run(input: AgentInput, options?: AgentRunOptions): Promise<AgentResult>;
}

export type AgentCapability =
  | "reasoning"
  | "code-execution"
  | "vision"
  | "web-research"
  | "structured-output"
  | "tool-use"
  | "local-cli"
  | (string & {});

export interface AgentRequirements {
  role?: AgentRole;
  capabilities?: AgentCapability[];
}

export interface AgentDescriptor {
  schemaVersion: 1;
  id: string;
  provider: string;
  adapterVersion: string;
  model?: string;
  roles: AgentRole[];
  capabilities: AgentCapability[];
  /** Declared invocation controls; this does not inspect the provider's complete native policy. */
  permissions?: AgentPermissions;
}

export interface AgentPermissions {
  mode: string;
  source: "adapter-argument" | "native-configuration";
  sandbox?: string;
  /** Number of explicitly configured native allow rules, not their potentially sensitive text. */
  toolAllowRules?: number;
}

/** Provider responses are data and are never accepted as verifier command requests. */
export type VerificationCommandSource = "workflow" | "caller";

export interface AgentReadiness {
  status: "ready" | "unavailable" | "unknown";
  /** Configuration presence, local CLI checks, or a real remote-service probe. */
  scope: "configuration" | "local" | "remote";
  message: string;
  version?: string;
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
      type: "consensus";
      outcome: "pass" | "fail";
      mode: "all-pass" | "quorum" | "judge";
      quorum?: number;
      reviews: ReviewVote[];
      judge?: ReviewVote;
      verification: VerificationEvidence[];
      reason?: string;
    }
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

/** A vote references a separately persisted agent result; summaries/data remain in that event. */
export interface ReviewVote {
  stepId: string;
  verdict: "pass" | "fail" | "error";
  outputEventId?: string;
  attemptId?: string;
  attempt?: number;
  error?: SerializedError;
}

export interface VerificationEvidence {
  stepId: string;
  success: boolean;
  outputEventId?: string;
}

export interface EventMetadata {
  runId: string;
  at: string;
  eventId?: string;
  sequence?: number;
  /** Store-owned reference to a complete payload; absent on ordinary inline events. */
  payload?: ArtifactRef;
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

/** The durable event whose completed scheduling boundary was reconciled after a crash. */
export interface RecoveryBoundary {
  eventId: string;
  sequence: number;
}

export type VeyraEvent = EventMetadata &
  (
    | {
        /** Bounded persisted/output representation; Core resolves the referenced event for execution. */
        type: "event.stored";
        eventType: string;
        artifact: ArtifactRef;
        preview: string;
      }
    | { type: "run.started"; goal: string; workflowName?: string; workspace?: WorkspaceInfo }
    | { type: "workspace.removed"; workspace: WorkspaceInfo }
    | {
        type: "run.completed";
        timing?: ExecutionTiming;
        usage?: UsageMetadata;
        recovery?: RecoveryBoundary;
      }
    | { type: "run.failed"; message: string; error?: SerializedError }
    | { type: "run.paused"; stepId?: string; reason?: string; recovery?: RecoveryBoundary }
    | { type: "run.resumed"; stepId?: string }
    | (StepEventMetadata & { type: "step.started" })
    | (StepEventMetadata & {
        type: "step.retrying";
        retryCount: number;
        maxRetries: number;
        delayMs?: number;
      })
    | (StepEventMetadata & {
        type: "budget.checked";
        phase: "before" | "after";
        allowed: boolean;
        reason?: string;
      })
    | (StepEventMetadata & { type: "step.completed"; outcome?: string; artifacts?: ArtifactRef[] })
    | (StepEventMetadata & { type: "step.failed"; message: string; error?: SerializedError })
    | (StepEventMetadata & {
        type: "router.selected";
        route: string;
        target: string;
        selection: "static" | "input";
        source?: { stepId: string; path: string; outputEventId?: string; sequence?: number };
      })
    | (StepEventMetadata & {
        type: "subworkflow.started";
        workflowName: string;
        childStepId: string;
        inputs: JsonObject;
        provenance?: ContextProvenance;
      })
    | (StepEventMetadata & {
        type: "subworkflow.completed";
        success: boolean;
        outputs?: JsonObject;
        error?: SerializedError;
      })
    | (StepEventMetadata & { type: "subworkflow.paused"; childStepId: string; reason: string })
    | (StepEventMetadata & {
        type: "consensus.started";
        reviewers: string[];
        mode: "all-pass" | "quorum" | "judge";
        quorum?: number;
        judge?: string;
        verification: VerificationEvidence[];
      })
    | (StepEventMetadata & {
        type: "consensus.completed";
        outcome: "pass" | "fail";
        mode: "all-pass" | "quorum" | "judge";
        quorum?: number;
        reviews: ReviewVote[];
        judge?: ReviewVote;
        verification: VerificationEvidence[];
        reason?: string;
      })
    | (StepEventMetadata & { type: "consensus.paused"; phase: "reviewers" | "judge" })
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
    | (StepEventMetadata & { type: "agent.routed"; decision: AgentRoutingDecision })
    | (AgentEventMetadata & {
        type: "agent.selected";
        binding: string;
        requirements: AgentRequirements;
        descriptor?: AgentDescriptor;
      })
    | (AgentEventMetadata & { type: "agent.started" })
    | (AgentEventMetadata & { type: "agent.input"; input: AgentInput })
    | (AgentEventMetadata & { type: "agent.completed"; result: AgentResult; inputEventId?: string })
    | (AgentEventMetadata & { type: "agent.failed"; error: SerializedError; inputEventId?: string })
    | (StepEventMetadata & {
        type: "verification.started";
        commands: string[];
        commandSource?: VerificationCommandSource;
      })
    | (StepEventMetadata & {
        type: "verification.completed";
        commandSource?: VerificationCommandSource;
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
export { isWorkspaceInfo, type WorkspaceInfo } from "./workspace.js";
export { isJsonValue } from "./json.js";
export {
  serializeProjectEnvelope,
  parseProjectEnvelope,
  ProjectEnvelopeError,
  type ProjectInterchange,
} from "./handoff.js";
export {
  isProjectBindings,
  isProjectRoleBinding,
  type ProjectBindings,
  type ProjectRoleBinding,
} from "./bindings.js";
export {
  isSessionId,
  isNativeSessionReference,
  isNativeSessionRequest,
  type NativeSessionReference,
  type NativeSessionRequest,
} from "./session.js";
export {
  MAX_DAEMON_REQUEST_BYTES,
  MAX_DAEMON_RESPONSE_BYTES,
  isDaemonRequest,
  isDaemonResponse,
  isDaemonRunView,
  isRegisteredProject,
  type RegisteredProject,
  type DaemonInfo,
  type DaemonRunView,
  type DaemonRunSummary,
  isDaemonRunSummary,
  type ProjectRunLocator,
  type DaemonOperations,
  type DaemonMethod,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon.js";
export {
  MAX_PROJECT_STATE_BYTES,
  MAX_PROJECT_ENVELOPE_BYTES,
  isProjectSharedState,
  isProjectHandoff,
  isProjectExecutionResult,
  isProjectResultForHandoff,
  isProjectReview,
  isProjectReviewForResult,
  isProjectExecutionStatus,
  type ProjectExecutionStatus,
  type ProjectProvenance,
  type ProjectDecision,
  type ProjectPlan,
  type ProjectContext,
  type ProjectHandoff,
  type ProjectInputReference,
  type ProjectVerificationRequest,
  type ProjectExecutionResult,
  type ProjectReview,
  type ProjectArtifactReference,
  type ProjectSharedState,
  type ProjectStateUpdate,
} from "./project-state.js";
export {
  isProjectId,
  isProjectDescriptor,
  type ProjectId,
  type ProjectDescriptor,
} from "./project.js";
export { isAgentDescriptor, isAgentReadiness, isAgentRequirements } from "./capabilities.js";
