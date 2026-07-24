import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResourceClaim, ResourceLease } from "./claims.js";
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
  | "passed"
  | "failed";

export type TaskReviewPhase =
  | "not-required"
  | "awaiting"
  | "accepted"
  | "rejected";

export interface DurableTaskRun {
  version: 1;
  invocationId: string;
  correlationId?: string;
  taskId?: string;
  batchId?: string;
  joinMode?: "async" | "group";
  agentType?: string;
  description?: string;
  projectDirectory: string;
  executionDirectory: string;
  worktree?: WorktreeHandle;
  worktreeResult?: WorktreeResult;
  worktreeDisposition?: "retained" | "merged" | "removed";
  mergeCommitSha?: string;
  startedAt: string;
  updatedAt: string;
  heartbeatAt: string;
  executionPhase: TaskExecutionPhase;
  verificationPhase: TaskVerificationPhase;
  reviewPhase: TaskReviewPhase;
  verificationIssues: string[];
  claims: ResourceClaim[];
    lease?: ResourceLease;
  leaseTtlMs?: number;
  contextPack?: ContextPack;
  proof?: OrchestrationRequest["proof"];
  verifier?: OrchestrationRequest["verifier"];
  sessionReference?: string;
  resultDigest?: string;
}

interface RunStoreDocument {
  version: 1;
  runs: DurableTaskRun[];
}

export interface CreateDurableRunInput {
  invocationId?: string;
  correlationId?: string;
  batchId?: string;
  joinMode?: "async" | "group";
  agentType?: string;
  description?: string;
  projectDirectory: string;
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
    ...(input.batchId ? { batchId: input.batchId } : {}),
    ...(input.joinMode ? { joinMode: input.joinMode } : {}),
    ...(input.agentType ? { agentType: input.agentType } : {}),
    ...(input.description ? { description: input.description } : {}),
    projectDirectory: input.projectDirectory,
    executionDirectory: input.executionDirectory ?? input.projectDirectory,
    startedAt: now,
    updatedAt: now,
    heartbeatAt: now,
    executionPhase: "allocating",
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
    if (index === -1) document.runs.push(persisted);
    else document.runs[index] = persisted;
    return structuredClone(persisted);
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
    const updated: DurableTaskRun = {
      ...current,
      ...structuredClone(changes),
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

async function readRunStore(storePath: string): Promise<RunStoreDocument> {
  try {
    const value: unknown = JSON.parse(await readFile(storePath, "utf8"));
    if (!isRunStoreDocument(value)) {
      throw new Error(`Invalid task run store: ${storePath}`);
    }
    return value;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: RUN_STORE_VERSION, runs: [] };
    }
    throw error;
  }
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

function isRunStoreDocument(value: unknown): value is RunStoreDocument {
  return (
    isRecord(value) &&
    value.version === RUN_STORE_VERSION &&
    Array.isArray(value.runs) &&
    value.runs.every(isDurableTaskRun)
  );
}

function isDurableTaskRun(value: unknown): value is DurableTaskRun {
  return (
    isRecord(value) &&
    value.version === RUN_STORE_VERSION &&
    typeof value.invocationId === "string" &&
    typeof value.projectDirectory === "string" &&
    typeof value.executionDirectory === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.heartbeatAt === "string" &&
    isExecutionPhase(value.executionPhase) &&
    isVerificationPhase(value.verificationPhase) &&
    isReviewPhase(value.reviewPhase) &&
    Array.isArray(value.verificationIssues) &&
    value.verificationIssues.every((issue) => typeof issue === "string") &&
    Array.isArray(value.claims)
  );
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
  return ["not-required", "pending", "passed", "failed"].includes(String(value));
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
