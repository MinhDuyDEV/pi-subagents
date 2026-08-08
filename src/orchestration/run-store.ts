import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isResourceClaim } from "./claims.js";
import type { ResourceClaim, ResourceLease } from "./claims.js";
import type { TaggedSha256V1, UsageReceiptV1 } from "../learning-contract.js";
import {
  normalizeOrchestrationReason,
  type OrchestrationReasonCode,
} from "./reason-codes.js";
import type { ContextPack } from "./context.js";
import type { OrchestrationRequest } from "./contract.js";
import type { WorktreeHandle, WorktreeResult } from "../worktree.js";
import { withFileLock } from "./file-lock.js";

const RUN_STORE_VERSION = 1;

export type TaskExecutionPhase =
  | "allocating"
  | "starting"
  | "working"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export type TaskVerificationPhase =
  | "not-required"
  | "pending"
  /** Runtime receipt integrity passed; semantic claims require independent review. */
  | "receipt-passed"
  | "passed"
  | "failed";

export type TaskReviewPhase =
  | "not-required"
  | "awaiting"
  | "accepted"
  | "rejected";

/**
 * The outcome reported by the child is deliberately independent from the
 * process/execution phase.  A process may exit cleanly while reporting that it
 * is blocked, partial, or waiting for a decision.  Advancement gates must use
 * this axis rather than inferring success from `executionPhase === completed`.
 */
export type TaskReportedOutcome =
  | "unknown"
  | "success"
  | "failure"
  | "blocked"
  | "partial"
  | "reframed"
  | "awaiting-decision";

export interface DurableDecisionOption {
  id: string;
  label: string;
  tradeoff?: string;
}

export interface DurableDecisionResponse {
  optionId?: string;
  response: string;
  respondedAt: string;
  responseDigest: TaggedSha256V1;
  /** Stable correlation used to find a resume that started before a crash. */
  resumeCorrelationId?: string;
  /**
   * Durable outbox state for the non-transactional task-launch boundary.
   * Missing means a response written by an older build and is retriable.
   */
  resumeState?: "dispatching" | "started" | "failed";
  resumeAttemptId?: string;
  /** Runtime instance currently owning this dispatch attempt. */
  resumeDispatcherId?: string;
  resumeDispatchStartedAt?: string;
  resumeError?: string;
  resumedInvocationId?: string;
}

export interface DurableDecisionRequest {
  id: string;
  question: string;
  options: DurableDecisionOption[];
  context?: string;
  requestedAt: string;
  requestDigest: TaggedSha256V1;
  status: "pending" | "resolved";
  response?: DurableDecisionResponse;
}

export interface SemanticAttestationV1 {
  claim: string;
  claimId?: TaggedSha256V1;
  receiptId: string;
  artifactDigest: string;
  reviewerTaskId: string;
  reviewerInvocationId: string;
  reviewerOutputDigest: string;
  subjectDigest: string;
  attestedAt: string;
}

export interface DurableTaskRun {
  version: 1;
  invocationId: string;
  correlationId?: string;
  contextRequestDigest?: TaggedSha256V1;
  learningBinding?: {
    projectId: string;
    trustEpoch: string;
    sessionGeneration: string;
  };
  usageBindings?: UsageReceiptV1[];
  taskId?: string;
  batchId?: string;
  joinMode?: "async" | "group";
  agentType?: string;
  description?: string;
  /** Parent/control root that owns durable orchestration state. */
  projectDirectory: string;
  /** Base repository/directory in which claims and context paths are interpreted. */
  workspaceDirectory: string;
  /** Actual child cwd; differs from workspaceDirectory when worktree-isolated. */
  executionDirectory: string;
  worktree?: WorktreeHandle;
  worktreeResult?: WorktreeResult;
  worktreeDisposition?: "retained" | "merged" | "removed";
  mergeCommitSha?: string;
  startedAt: string;
  updatedAt: string;
  heartbeatAt: string;
  executionPhase: TaskExecutionPhase;
  reportedOutcome: TaskReportedOutcome;
  /** Why the run is `blocked` — e.g. it lost its resource lease. */
  blockedReason?: string;
  blockedReasonCode?: OrchestrationReasonCode;
  verificationPhase: TaskVerificationPhase;
  reviewPhase: TaskReviewPhase;
  verificationIssues: string[];
  claims: ResourceClaim[];
    lease?: ResourceLease;
  leaseTtlMs?: number;
  contextPack?: ContextPack;
  proof?: OrchestrationRequest["proof"];
  /** Immutable, reviewer-owned semantic attestations. */
  semanticAttestations?: SemanticAttestationV1[];
  verifier?: OrchestrationRequest["verifier"];
  sessionReference?: string;
  resultDigest?: TaggedSha256V1;
  decisionRequest?: DurableDecisionRequest;
}

interface RunStoreDocument {
  version: 1;
  runs: DurableTaskRun[];
}

export interface CreateDurableRunInput {
  invocationId?: string;
  correlationId?: string;
  contextRequestDigest?: TaggedSha256V1;
  learningBinding?: {
    projectId: string;
    trustEpoch: string;
    sessionGeneration: string;
  };
  usageBindings?: UsageReceiptV1[];
  batchId?: string;
  joinMode?: "async" | "group";
  agentType?: string;
  description?: string;
  projectDirectory: string;
  workspaceDirectory?: string;
  executionDirectory?: string;
  startedAt?: string;
  claims?: readonly ResourceClaim[];
  lease?: ResourceLease;
  leaseTtlMs?: number;
  contextPack?: ContextPack;
  proof?: OrchestrationRequest["proof"];
  verifier?: OrchestrationRequest["verifier"];
}

export function createDurableRun(input: CreateDurableRunInput): DurableTaskRun {
  const now = input.startedAt ?? new Date().toISOString();
  return {
    version: RUN_STORE_VERSION,
    invocationId: input.invocationId ?? randomUUID(),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.contextRequestDigest
      ? { contextRequestDigest: input.contextRequestDigest }
      : {}),
    ...(input.learningBinding ? { learningBinding: { ...input.learningBinding } } : {}),
    ...(input.usageBindings ? { usageBindings: [...input.usageBindings] } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.joinMode ? { joinMode: input.joinMode } : {}),
    ...(input.agentType ? { agentType: input.agentType } : {}),
    ...(input.description ? { description: input.description } : {}),
    projectDirectory: input.projectDirectory,
    workspaceDirectory: input.workspaceDirectory ?? input.projectDirectory,
    executionDirectory:
      input.executionDirectory ?? input.workspaceDirectory ?? input.projectDirectory,
    startedAt: now,
    updatedAt: now,
    heartbeatAt: now,
    executionPhase: "allocating",
    reportedOutcome: "unknown",
    verificationPhase: input.proof ? "pending" : "not-required",
    reviewPhase: input.verifier?.required ? "awaiting" : "not-required",
    verificationIssues: [],
    claims: (input.claims ?? []).map((claim) => ({ ...claim })),
    ...(input.lease ? { lease: cloneLease(input.lease) } : {}),
    ...(input.leaseTtlMs ? { leaseTtlMs: input.leaseTtlMs } : {}),
    ...(input.contextPack ? { contextPack: structuredClone(input.contextPack) } : {}),
    ...(input.proof ? { proof: structuredClone(input.proof) } : {}),
    ...(input.verifier ? { verifier: structuredClone(input.verifier) } : {}),
  };
}

export async function putDurableRun(
  storePath: string,
  run: DurableTaskRun,
): Promise<DurableTaskRun> {
  return withRunStore(storePath, async (document) => {
    const index = document.runs.findIndex(
      (candidate) => candidate.invocationId === run.invocationId,
    );
    const persisted = structuredClone(run);
    if (
      persisted.correlationId?.startsWith("decision-resume:") &&
      document.runs.some(
        (candidate) =>
          candidate.invocationId !== persisted.invocationId &&
          candidate.correlationId === persisted.correlationId,
      )
    ) {
      throw new Error(
        `Decision resume correlation ${persisted.correlationId} already has a durable invocation`,
      );
    }
    if (index === -1) {
      document.runs.push(persisted);
    } else {
      const current = document.runs[index]!;
      if (isTerminalExecutionPhase(current.executionPhase)) {
        if (persisted.resultDigest === current.resultDigest && persisted.resultDigest) {
          return structuredClone(current);
        }
        throw new Error(`Cannot overwrite terminal durable run ${run.invocationId}`);
      }
      document.runs[index] = persisted;
    }
    return structuredClone(persisted);
  });
}

/**
 * Atomically claim a run's terminal result. Replaying the exact digest is
 * idempotent; a competing terminal observation with different bytes fails.
 */
export async function completeDurableRun(
  storePath: string,
  invocationId: string,
  resultDigest: TaggedSha256V1,
  patch: Partial<DurableTaskRun> & { executionPhase: TaskExecutionPhase },
): Promise<DurableTaskRun | undefined> {
  if (!isTaggedSha256(resultDigest)) {
    throw new Error("Terminal result digest must be a tagged SHA-256 digest");
  }
  if (!isTerminalExecutionPhase(patch.executionPhase)) {
    throw new Error(`Terminal completion requires a terminal execution phase`);
  }
  return withRunStore(storePath, async (document) => {
    const index = document.runs.findIndex(
      (candidate) => candidate.invocationId === invocationId,
    );
    if (index === -1) return undefined;
    const current = document.runs[index]!;
    if (isTerminalExecutionPhase(current.executionPhase)) {
      if (current.resultDigest === resultDigest) return structuredClone(current);
      throw new Error(
        `Conflicting terminal result for ${invocationId}: ` +
          `${current.resultDigest ?? "legacy-unbound"} != ${resultDigest}`,
      );
    }
    if (!canTransitionExecution(current.executionPhase, patch.executionPhase)) {
      throw new Error(
        `Invalid task execution transition: ${current.executionPhase} -> ${patch.executionPhase}`,
      );
    }
    const updated: DurableTaskRun = {
      ...current,
      ...structuredClone(patch),
      version: RUN_STORE_VERSION,
      invocationId: current.invocationId,
      resultDigest,
      updatedAt: new Date().toISOString(),
    };
    document.runs[index] = updated;
    return structuredClone(updated);
  });
}

export async function patchDurableRun(
  storePath: string,
  invocationId: string,
  patch:
    | Partial<DurableTaskRun>
    | ((current: DurableTaskRun) => Partial<DurableTaskRun>),
): Promise<DurableTaskRun | undefined> {
  return withRunStore(storePath, async (document) => {
    const index = document.runs.findIndex(
      (candidate) => candidate.invocationId === invocationId,
    );
    if (index === -1) return undefined;
    const current = document.runs[index];
    const changes = typeof patch === "function" ? patch(structuredClone(current)) : patch;
    if (
      changes.executionPhase !== undefined &&
      !canTransitionExecution(current.executionPhase, changes.executionPhase)
    ) {
      throw new Error(
        `Invalid task execution transition: ${current.executionPhase} -> ${changes.executionPhase}`,
      );
    }
    const normalizedChanges = changes.blockedReason === undefined
      ? changes
      : { ...changes, blockedReason: normalizeOrchestrationReason(changes.blockedReason) };
    const updated: DurableTaskRun = {
      ...current,
      ...structuredClone(normalizedChanges),
      version: RUN_STORE_VERSION,
      invocationId: current.invocationId,
      updatedAt: new Date().toISOString(),
    };
    document.runs[index] = updated;
    return structuredClone(updated);
  });
}

export async function getDurableRunByTaskId(
  storePath: string,
  taskId: string,
): Promise<DurableTaskRun | undefined> {
  const document = await readRunStore(storePath);
  const run = document.runs
    .filter((candidate) => candidate.taskId === taskId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  return run ? structuredClone(run) : undefined;
}

/** Find the attempt that owns a durable decision, even after a later resume. */
export async function getDurableRunByDecisionId(
  storePath: string,
  taskId: string,
  decisionId: string,
): Promise<DurableTaskRun | undefined> {
  const document = await readRunStore(storePath);
  const run = document.runs
    .filter(
      (candidate) =>
        candidate.taskId === taskId &&
        candidate.decisionRequest?.id === decisionId,
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  return run ? structuredClone(run) : undefined;
}

export async function getDurableRunByInvocationId(
  storePath: string,
  invocationId: string,
): Promise<DurableTaskRun | undefined> {
  const document = await readRunStore(storePath);
  const run = document.runs.find(
    (candidate) => candidate.invocationId === invocationId,
  );
  return run ? structuredClone(run) : undefined;
}

export async function listDurableRuns(
  storePath: string,
): Promise<DurableTaskRun[]> {
  return (await readRunStore(storePath)).runs.map((run) => structuredClone(run));
}

export function canTransitionExecution(
  current: TaskExecutionPhase,
  next: TaskExecutionPhase,
): boolean {
  if (current === next) return true;
  const allowed: Record<TaskExecutionPhase, readonly TaskExecutionPhase[]> = {
    allocating: ["starting", "working", "blocked", "completed", "failed", "cancelled", "timeout"],
    starting: ["working", "blocked", "failed", "cancelled", "timeout"],
    working: ["blocked", "completed", "failed", "cancelled", "timeout"],
    blocked: ["working", "completed", "failed", "cancelled", "timeout"],
    completed: [],
    failed: [],
    cancelled: [],
    timeout: [],
  };
  return allowed[current].includes(next);
}

export function isTerminalExecutionPhase(phase: TaskExecutionPhase): boolean {
  return (
    phase === "completed" ||
    phase === "failed" ||
    phase === "cancelled" ||
    phase === "timeout"
  );
}

async function withRunStore<T>(
  storePath: string,
  operation: (document: RunStoreDocument) => Promise<T> | T,
): Promise<T> {
  return withFileLock({
    lockPath: `${storePath}.lock`,
    operation: async () => {
      const document = await readRunStore(storePath);
      const result = await operation(document);
      await writeRunStore(storePath, document);
      return result;
    },
  });
}

/** Reporter for a run store that had to be quarantined; wired by the runtime. */
export type RunStoreQuarantineReporter = (info: {
  storePath: string;
  quarantinePath: string;
  reason: string;
}) => void;

let reportRunStoreQuarantine: RunStoreQuarantineReporter = () => undefined;

export function setRunStoreQuarantineReporter(
  reporter: RunStoreQuarantineReporter,
): void {
  reportRunStoreQuarantine = reporter;
}

/**
 * Read the run store, quarantining one that cannot be understood.
 *
 * Same rationale as the lease store: throwing forever on a bad file is a
 * denial of service on recovery and on every tool that lists runs, and a store
 * written by an older build can now contain claims the stricter validation
 * rejects. The bad file is moved aside as evidence and the system continues —
 * runs are re-established from panes and session history by recovery.
 */
async function readRunStore(storePath: string): Promise<RunStoreDocument> {
  let raw: string;
  try {
    raw = await readFile(storePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: RUN_STORE_VERSION, runs: [] };
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return quarantineRunStore(storePath, `unparseable JSON: ${(error as Error).message}`);
  }
  if (!isRunStoreDocument(value)) {
    return quarantineRunStore(storePath, "store failed schema validation");
  }
  return {
    version: RUN_STORE_VERSION,
    runs: value.runs.map(normalizePersistedRun),
  };
}

async function quarantineRunStore(
  storePath: string,
  reason: string,
): Promise<RunStoreDocument> {
  const quarantinePath = `${storePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    await rename(storePath, quarantinePath);
  } catch {
    // If it cannot be moved we still continue; the next write replaces it.
  }
  try {
    reportRunStoreQuarantine({ storePath, quarantinePath, reason });
  } catch {
    // A reporter must never be able to break the store.
  }
  return { version: RUN_STORE_VERSION, runs: [] };
}

async function writeRunStore(
  storePath: string,
  document: RunStoreDocument,
): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await rename(temporaryPath, storePath);
}

function cloneLease(lease: ResourceLease): ResourceLease {
  return { ...lease, claims: lease.claims.map((claim) => ({ ...claim })) };
}

type PersistedDurableTaskRun = Omit<
  DurableTaskRun,
  "reportedOutcome" | "workspaceDirectory"
> & {
  /** Missing in version-1 stores written before the semantic outcome axis. */
  reportedOutcome?: TaskReportedOutcome;
  /** Missing in version-1 stores written before multi-repo execution. */
  workspaceDirectory?: string;
};

interface PersistedRunStoreDocument {
  version: 1;
  runs: PersistedDurableTaskRun[];
}

function isRunStoreDocument(value: unknown): value is PersistedRunStoreDocument {
  return (
    isRecord(value) &&
    value.version === RUN_STORE_VERSION &&
    Array.isArray(value.runs) &&
    value.runs.every(isDurableTaskRun)
  );
}

function isDurableTaskRun(value: unknown): value is PersistedDurableTaskRun {
  return (
    isRecord(value) &&
    value.version === RUN_STORE_VERSION &&
    typeof value.invocationId === "string" &&
    typeof value.projectDirectory === "string" &&
    (value.workspaceDirectory === undefined ||
      typeof value.workspaceDirectory === "string") &&
    typeof value.executionDirectory === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.heartbeatAt === "string" &&
    isExecutionPhase(value.executionPhase) &&
    (value.reportedOutcome === undefined || isReportedOutcome(value.reportedOutcome)) &&
    isVerificationPhase(value.verificationPhase) &&
    isReviewPhase(value.reviewPhase) &&
    Array.isArray(value.verificationIssues) &&
    value.verificationIssues.every((issue) => typeof issue === "string") &&
    // Validate the ELEMENTS, not just the array. A run whose claims were never
    // checked is re-acquired verbatim on recovery, so a malformed claim that
    // never passed through the tool boundary still reached the lease store.
    Array.isArray(value.claims) &&
    value.claims.every(isResourceClaim) &&
    (value.semanticAttestations === undefined ||
      (Array.isArray(value.semanticAttestations) &&
        value.semanticAttestations.length <= 20 &&
        value.semanticAttestations.every(isSemanticAttestation))) &&
    (value.resultDigest === undefined || isTaggedSha256(value.resultDigest)) &&
    (value.decisionRequest === undefined || isDecisionRequest(value.decisionRequest))
  );
}

function normalizePersistedRun(run: PersistedDurableTaskRun): DurableTaskRun {
  const { semanticBindingKey: _legacySemanticBindingKey, ...withoutLegacySecret } =
    structuredClone(run) as DurableTaskRun & { semanticBindingKey?: string };
  return {
    ...withoutLegacySecret,
    workspaceDirectory: run.workspaceDirectory ?? run.projectDirectory,
    // A legacy `completed` phase does not establish semantic success.  The
    // fail-closed migration keeps it unknown until a fresh child result is
    // parsed and durably recorded.
    reportedOutcome: run.reportedOutcome ?? "unknown",
  };
}

function isSemanticAttestation(value: unknown): value is SemanticAttestationV1 {
  return (
    isRecord(value) &&
    typeof value.claim === "string" &&
    value.claim.length > 0 &&
    value.claim.length <= 1_000 &&
    (value.claimId === undefined || isTaggedSha256(value.claimId)) &&
    typeof value.receiptId === "string" &&
    value.receiptId.length > 0 &&
    value.receiptId.length <= 256 &&
    typeof value.artifactDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.artifactDigest) &&
    typeof value.reviewerTaskId === "string" &&
    typeof value.reviewerInvocationId === "string" &&
    typeof value.reviewerOutputDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.reviewerOutputDigest) &&
    typeof value.subjectDigest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.subjectDigest) &&
    typeof value.attestedAt === "string"
  );
}

function isReportedOutcome(value: unknown): value is TaskReportedOutcome {
  return [
    "unknown",
    "success",
    "failure",
    "blocked",
    "partial",
    "reframed",
    "awaiting-decision",
  ].includes(String(value));
}

function isDecisionRequest(value: unknown): value is DurableDecisionRequest {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.question !== "string" ||
    typeof value.requestedAt !== "string" ||
    !isTaggedSha256(value.requestDigest) ||
    !["pending", "resolved"].includes(String(value.status)) ||
    !Array.isArray(value.options) ||
    !value.options.every(
      (option) =>
        isRecord(option) &&
        typeof option.id === "string" &&
        typeof option.label === "string" &&
        (option.tradeoff === undefined || typeof option.tradeoff === "string"),
    )
  ) {
    return false;
  }
  if (value.context !== undefined && typeof value.context !== "string") return false;
  if (value.response === undefined) return value.status === "pending";
  return (
    value.status === "resolved" &&
    isRecord(value.response) &&
    (value.response.optionId === undefined || typeof value.response.optionId === "string") &&
    typeof value.response.response === "string" &&
    typeof value.response.respondedAt === "string" &&
    isTaggedSha256(value.response.responseDigest) &&
    (value.response.resumeCorrelationId === undefined ||
      typeof value.response.resumeCorrelationId === "string") &&
    (value.response.resumeState === undefined ||
      ["dispatching", "started", "failed"].includes(
        String(value.response.resumeState),
      )) &&
    (value.response.resumeAttemptId === undefined ||
      typeof value.response.resumeAttemptId === "string") &&
    (value.response.resumeDispatcherId === undefined ||
      typeof value.response.resumeDispatcherId === "string") &&
    (value.response.resumeDispatchStartedAt === undefined ||
      typeof value.response.resumeDispatchStartedAt === "string") &&
    (value.response.resumeError === undefined ||
      typeof value.response.resumeError === "string") &&
    (value.response.resumedInvocationId === undefined ||
      typeof value.response.resumedInvocationId === "string")
  );
}

function isTaggedSha256(value: unknown): value is TaggedSha256V1 {
  return typeof value === "string" && /^sha256:v1:[a-f0-9]{64}$/u.test(value);
}

function isExecutionPhase(value: unknown): value is TaskExecutionPhase {
  return [
    "allocating",
    "starting",
    "working",
    "blocked",
    "completed",
    "failed",
    "cancelled",
    "timeout",
  ].includes(String(value));
}

function isVerificationPhase(value: unknown): value is TaskVerificationPhase {
  return [
    "not-required",
    "pending",
    "receipt-passed",
    "passed",
    "failed",
  ].includes(String(value));
}

function isReviewPhase(value: unknown): value is TaskReviewPhase {
  return ["not-required", "awaiting", "accepted", "rejected"].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
