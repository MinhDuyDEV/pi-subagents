export {
  TASK_RPC_PROTOCOL_VERSION,
  registerTaskRpc,
  type TaskRpcDependencies,
  type TaskRpcHandle,
} from "./orchestration/rpc.js";
export {
  canTransitionExecution,
  completeDurableRun,
  createDurableRun,
  getDurableRunByDecisionId,
  getDurableRunByInvocationId,
  getDurableRunByTaskId,
  isTerminalExecutionPhase,
  listDurableRuns,
  type DurableTaskRun,
  type SemanticAttestationV1,
  type TaskExecutionPhase,
  type TaskReviewPhase,
  type TaskVerificationPhase,
} from "./orchestration/run-store.js";
export {
  listEvidenceReceipts,
  recordEvidenceReceipt,
  verifyEvidenceReceipt,
  type EvidenceReceipt,
  type EvidenceReceiptKind,
} from "./orchestration/evidence.js";
export {
  HerdrClient,
  HerdrCommandError,
  isTransientHerdrCode,
  type HerdrAgentInfo,
  type HerdrAgentStatus,
  type HerdrPaneInfo,
} from "./subagent/herdrClient.js";
export {
  createTaskWorktree,
  finalizeTaskWorktree,
  inspectTaskWorktree,
  mergeTaskWorktree,
  removeTaskWorktree,
  type WorktreeHandle,
  type WorktreeResult,
} from "./worktree.js";
export {
  TaskScheduler,
  type CreateTaskScheduleInput,
  type TaskSchedule,
} from "./orchestration/scheduler.js";

import {
  SUBAGENT_LEARNING_EVENTS_V1,
  SUBAGENT_LEARNING_EVENTS_V2,
  validateLearningContext,
  mergeLearningFacts,
  type LearningContextV1,
  type LearningFactV1,
  type LearningPatternV1,
  type LearningMetricsV1,
  type ContextRequestPayloadV1,
  type ContextRequestPayloadV2,
  type ProofVerifiedPayloadV1,
  type ReviewCompletedPayloadV1,
} from "./events.js";
import {
  TASK_LIFECYCLE_EVENTS_V1,
  type TaskSettledEventV1,
  type TaskStartedEventV1,
} from "@minhduydev/pi-core/task-lifecycle";

export {
  SUBAGENT_LEARNING_EVENTS_V1,
  SUBAGENT_LEARNING_EVENTS_V2,
  validateLearningContext,
  mergeLearningFacts,
  type LearningContextV1,
  type LearningFactV1,
  type LearningPatternV1,
  type LearningMetricsV1,
  type ContextRequestPayloadV1,
  type ContextRequestPayloadV2,
  type ProofVerifiedPayloadV1,
  type ReviewCompletedPayloadV1,
};

export const TASK_LIFECYCLE_PROTOCOL_VERSION = 1;
export const TASK_LIFECYCLE_EVENTS = [
  TASK_LIFECYCLE_EVENTS_V1.STARTED,
  TASK_LIFECYCLE_EVENTS_V1.SETTLED,
  "pi-subagents:batch-settled",
  ...Object.values(SUBAGENT_LEARNING_EVENTS_V1),
  ...Object.values(SUBAGENT_LEARNING_EVENTS_V2),
] as const;

export {
  TASK_LIFECYCLE_EVENTS_V1,
  type TaskSettledEventV1,
  type TaskStartedEventV1,
} from "@minhduydev/pi-core/task-lifecycle";

export interface BatchSettledEventV1 {
  protocolVersion: 1;
  batchId: string;
  count: number;
  timestamp: string;
}

export interface TaskLifecycleEventMapV1 {
  "pi-subagents:task-started": TaskStartedEventV1;
  "pi-subagents:task-settled": TaskSettledEventV1;
  "pi-subagents:batch-settled": BatchSettledEventV1;
}
