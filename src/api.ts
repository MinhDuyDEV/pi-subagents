export {
  TASK_RPC_PROTOCOL_VERSION,
  registerTaskRpc,
  type TaskRpcDependencies,
  type TaskRpcHandle,
} from "./orchestration/rpc.js";
export {
  canTransitionExecution,
  createDurableRun,
  getDurableRunByInvocationId,
  getDurableRunByTaskId,
  isTerminalExecutionPhase,
  listDurableRuns,
  type DurableTaskRun,
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

export const TASK_LIFECYCLE_PROTOCOL_VERSION = 1;
export const TASK_LIFECYCLE_EVENTS = [
  "pi-subagents:task-started",
  "pi-subagents:task-settled",
  "pi-subagents:batch-settled",
] as const;

export interface TaskStartedEventV1 {
  protocolVersion: 1;
  taskId: string;
  invocationId: string;
  batchId?: string;
  agentType?: string;
  description?: string;
  backend?: string;
  timestamp: string;
}

export interface TaskSettledEventV1 {
  protocolVersion: 1;
  taskId: string;
  executionPhase?: "completed" | "failed" | "cancelled" | "timeout";
  verificationPassed?: boolean;
  awaitingReview: boolean;
  issues: string[];
  timestamp: string;
}

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
