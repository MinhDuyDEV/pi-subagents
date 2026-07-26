import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorktreeResult } from "../worktree.js";
import {
  releaseResourceLease,
  type ResourceLease,
} from "./claims.js";
import type { ContextEvidence, ContextPack } from "./context.js";
import { resolveTaskSessionReference } from "./lifecycle.js";
import { getOrchestrationPaths, type OrchestrationPaths } from "./paths.js";
import {
  validateEvidenceOnlyProof,
  type EvidenceProofResult,
} from "./proof.js";
import {
  getDurableRunByTaskId,
  patchDurableRun,
} from "./run-store.js";
import { persistTaskHistoryReference } from "./task-state.js";
import {
  appendOrchestrationEvent,
  readOrchestrationEvents,
  summarizeTaskSessionUsage,
} from "./telemetry.js";
import type { OrchestrationRequest } from "./contract.js";

export interface ActiveRun {
  invocationId?: string;
  orchestrationId: string;
  taskId: string;
  agentType?: string;
  startedAt: string;
  lease?: ResourceLease;
  leaseTtlMs?: number;
  lastHeartbeatAt?: number;
  /**
   * Monotonic timestamp of the last successful lease renewal, used to detect
   * that the process was suspended long enough for the lease to lapse. The wall
   * clock cannot tell a 30-minute sleep from a 30-minute pause.
   */
  lastRenewMonotonicMs?: number;
  /** Set when the run lost its lease; the write guard refuses it from then on. */
  leaseLost?: boolean;
  contextPack?: ContextPack;
  proof?: OrchestrationRequest["proof"];
  verifier?: OrchestrationRequest["verifier"];
  projectDirectory: string;
  executionDirectory?: string;
  batchId?: string;
  joinMode?: "async" | "group";
}

export interface BackgroundCompletionResult {
  handled: boolean;
  taskId?: string;
  executionPhase?: "completed" | "failed" | "cancelled" | "timeout";
  proof?: EvidenceProofResult;
  awaitingReview?: boolean;
  issues: string[];
}

export async function recordForegroundCompletion(
  run: ActiveRun,
  paths: OrchestrationPaths,
  upstreamResult?: { details?: unknown; isError?: boolean },
): Promise<EvidenceProofResult | undefined> {
  const details = isRecord(upstreamResult?.details) ? upstreamResult.details : undefined;
  const worktreeResult = parseWorktreeResult(details?.worktree);
  const executionPhase = normalizeExecutionPhase(details, upstreamResult?.isError === true);
  const resolvedSessionReference =
    sessionReferenceFromDetails(details) ??
    (await resolveTaskSessionReference({
      projectDirectory: run.projectDirectory,
      taskId: run.taskId,
      sessionName: `task-${run.taskId}`,
    }));
  const evidence = mergeEvidence(
    run.contextPack?.evidence ?? [],
    normalizeCompletionEvidence(details?.evidence, resolvedSessionReference),
  );

  if (executionPhase !== "completed") {
    await recordExecutionFailure(run, paths, executionPhase, stringValue(details?.error));
    if (run.lease) await releaseLeaseAndRecord(paths, run.orchestrationId, run.lease);
    await patchRunAfterCompletion(
      paths,
      run,
      executionPhase,
      undefined,
      false,
      resolvedSessionReference,
      worktreeResult,
    );
    return undefined;
  }

  let proof = run.proof
    ? await validateEvidenceOnlyProof({
        projectDirectory: run.executionDirectory ?? run.projectDirectory,
        allowedProjectDirectories: [run.projectDirectory],
        evidence,
        maxEvidenceAgeMs: run.proof.maxEvidenceAgeMs ?? 15 * 60 * 1_000,
        claims: run.contextPack?.claims,
        learningClaims: run.contextPack?.learningClaims,
      })
    : undefined;

  const changedPaths = changedPathsFromDetails(details);
  if (run.lease && changedPaths.length > 0) {
    const uncovered = changedPaths.filter(
      (path) => !leaseCoversChangedPath(run.lease!, path),
    );
    if (uncovered.length > 0) {
      proof = {
        valid: false,
        issues: [
          ...(proof?.issues ?? []),
          ...uncovered.map((path) => `Write outside declared claims: ${path}`),
        ],
        supportedClaims: proof?.supportedClaims ?? [],
      };
    }
  }

  const awaitingReview = await recordExecutionAndReviewState(run, paths, proof, evidence.length);
  if (run.lease) await releaseLeaseAndRecord(paths, run.orchestrationId, run.lease);
  await patchRunAfterCompletion(
    paths,
    run,
    "completed",
    proof,
    awaitingReview,
    resolvedSessionReference,
    worktreeResult,
  );
  return proof;
}

export async function recordBackgroundCompletion(
  _pi: ExtensionAPI,
  activeRuns: Map<string, ActiveRun>,
  message: Record<string, unknown>,
): Promise<BackgroundCompletionResult> {
  const details = isRecord(message.details) ? message.details : undefined;
  const worktreeResult = parseWorktreeResult(details?.worktree);
  const taskId = stringValue(details?.task_id) ?? stringValue(details?.taskId);
  if (!taskId) return { handled: false, issues: [] };

  let run = activeRuns.get(taskId);
  if (!run) {
    const projectDirectory = stringValue(details?.project_directory);
    if (!projectDirectory) return { handled: false, taskId, issues: [] };
    const paths = getOrchestrationPaths(projectDirectory);
    const stored = await getDurableRunByTaskId(paths.runStore, taskId);
    if (stored) {
      run = {
        invocationId: stored.invocationId,
        orchestrationId: stored.correlationId ?? stored.invocationId,
        taskId,
        agentType: stored.agentType,
        startedAt: stored.startedAt,
        lease: stored.lease,
        leaseTtlMs: stored.leaseTtlMs,
        lastHeartbeatAt: Date.parse(stored.heartbeatAt),
        contextPack: stored.contextPack,
        proof: stored.proof,
        verifier: stored.verifier,
        projectDirectory: stored.projectDirectory,
        executionDirectory: stored.executionDirectory,
        batchId: stored.batchId,
        joinMode: stored.joinMode,
      };
    }
  }
  if (!run) return { handled: false, taskId, issues: [] };

  const paths = getOrchestrationPaths(run.projectDirectory);
  const executionPhase = normalizeExecutionPhase(details, false);
  if (executionPhase !== "completed") {
    activeRuns.delete(taskId);
    await recordExecutionFailure(run, paths, executionPhase, stringValue(details?.summary));
    if (run.lease) await releaseLeaseAndRecord(paths, run.orchestrationId, run.lease);
    await patchRunAfterCompletion(
      paths,
      run,
      executionPhase,
      undefined,
      false,
      undefined,
      worktreeResult,
    );
    return { handled: true, taskId, executionPhase, issues: [] };
  }

  const sessionName = `task-${taskId}`;
  const sessionReference = await resolveTaskSessionReference({
    projectDirectory: run.projectDirectory,
    taskId,
    sessionName,
  });
  if (sessionReference) {
    await persistTaskHistoryReference(
      run.projectDirectory,
      taskId,
      sessionName,
      sessionReference,
    );
  }
  const usage = sessionReference
    ? await summarizeTaskSessionUsage(sessionReference)
    : undefined;
  const evidence = mergeEvidence(
    run.contextPack?.evidence ?? [],
    normalizeCompletionEvidence(details?.evidence, sessionReference),
  );
  let proof = run.proof
    ? await validateEvidenceOnlyProof({
        projectDirectory: run.executionDirectory ?? run.projectDirectory,
        allowedProjectDirectories: [run.projectDirectory],
        evidence,
        maxEvidenceAgeMs: run.proof.maxEvidenceAgeMs ?? 15 * 60 * 1_000,
        claims: run.contextPack?.claims,
        learningClaims: run.contextPack?.learningClaims,
      })
    : undefined;

  const changedPaths = changedPathsFromDetails(details);
  if (run.lease && changedPaths.length > 0) {
    const uncovered = changedPaths.filter(
      (path) => !leaseCoversChangedPath(run.lease!, path),
    );
    if (uncovered.length > 0) {
      proof = {
        valid: false,
        issues: [
          ...(proof?.issues ?? []),
          ...uncovered.map((path) => `Write outside declared claims: ${path}`),
        ],
        supportedClaims: proof?.supportedClaims ?? [],
      };
    }
  }

  const awaitingReview = await recordExecutionAndReviewState(
    run,
    paths,
    proof,
    evidence.length,
    {
      durationMs: numericValue(details?.duration_ms),
      retryCount: numericValue(details?.retry_count),
      usage,
    },
  );
  if (run.lease) await releaseLeaseAndRecord(paths, run.orchestrationId, run.lease);
  activeRuns.delete(taskId);
  await patchRunAfterCompletion(
    paths,
    run,
    "completed",
    proof,
    awaitingReview,
    sessionReference,
    worktreeResult,
  );

  return {
    handled: true,
    taskId,
    executionPhase,
    proof,
    awaitingReview,
    issues: proof?.issues ?? [],
  };
}

export async function releaseLeaseAndRecord(
  paths: OrchestrationPaths,
  orchestrationId: string,
  lease: ResourceLease,
): Promise<void> {
  await releaseResourceLease({ storePath: paths.leaseStore, leaseId: lease.id });
  await appendOrchestrationEvent({
    eventPath: paths.eventLog,
    event: {
      type: "claim_released",
      orchestrationId,
      leaseId: lease.id,
      idempotencyKey: `lease:${lease.id}:released`,
    },
  });
}

async function recordExecutionAndReviewState(
  run: ActiveRun,
  paths: OrchestrationPaths,
  proof: EvidenceProofResult | undefined,
  evidenceCount: number,
  metrics: {
    durationMs?: number;
    retryCount?: number;
    usage?: Awaited<ReturnType<typeof summarizeTaskSessionUsage>>;
  } = {},
): Promise<boolean> {
  await appendOrchestrationEvent({
    eventPath: paths.eventLog,
    event: {
      type: "task_execution_completed",
      orchestrationId: run.orchestrationId,
      idempotencyKey: `${run.invocationId}:execution:completed`,
      taskId: run.taskId,
      ...(run.agentType ? { agentType: run.agentType } : {}),
      durationMs: metrics.durationMs ?? Date.now() - Date.parse(run.startedAt),
      ...(metrics.retryCount === undefined ? {} : { retryCount: metrics.retryCount }),
      evidenceCount,
      ...(proof ? { verificationPassed: proof.valid } : {}),
      ...(metrics.usage ? { usage: metrics.usage } : {}),
    },
  });

  if (proof) {
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: proof.valid ? "proof_passed" : "proof_failed",
        orchestrationId: run.orchestrationId,
        idempotencyKey: `${run.invocationId}:proof:${proof.valid ? "passed" : "failed"}`,
        taskId: run.taskId,
        ...(run.agentType ? { agentType: run.agentType } : {}),
        ...(proof.issues.length ? { reason: proof.issues.join(" ") } : {}),
      },
    });
  }
  if (proof && !proof.valid) return false;

  const awaitingReview = await needsIndependentReview(run, paths);
  if (awaitingReview) {
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: "task_awaiting_review",
        orchestrationId: run.orchestrationId,
        idempotencyKey: `${run.invocationId}:review:awaiting`,
        taskId: run.taskId,
        reason: awaitingReview,
      },
    });
    return true;
  }

  await appendOrchestrationEvent({
    eventPath: paths.eventLog,
    event: {
      type: "task_completed",
      orchestrationId: run.orchestrationId,
      idempotencyKey: `${run.invocationId}:execution:verified`,
      taskId: run.taskId,
      ...(run.agentType ? { agentType: run.agentType } : {}),
      verificationPassed: proof?.valid,
    },
  });
  return false;
}

async function needsIndependentReview(
  run: ActiveRun,
  paths: OrchestrationPaths,
): Promise<string | undefined> {
  if (!run.verifier?.required) return undefined;
  const minReviews = run.verifier.minReviews ?? 1;
  const events = await readOrchestrationEvents(paths.eventLog);
  const reviewerTaskIds = new Set<string>();
  for (const event of events) {
    if (
      event.type === "task_reviewed" &&
      event.taskId === run.taskId &&
      event.reviewerTaskId &&
      event.reviewerTaskId !== run.taskId &&
      event.subjectDigest &&
      typeof event.verdict === "string" &&
      /^(approve|approved|accept|accepted|pass|passed)$/iu.test(event.verdict.trim())
    ) {
      reviewerTaskIds.add(event.reviewerTaskId);
    }
  }
  return reviewerTaskIds.size >= minReviews
    ? undefined
    : `Pending independent review (${reviewerTaskIds.size}/${minReviews})`;
}

async function recordExecutionFailure(
  run: ActiveRun,
  paths: OrchestrationPaths,
  phase: "failed" | "cancelled" | "timeout",
  reason?: string,
): Promise<void> {
  const type =
    phase === "cancelled"
      ? "task_cancelled"
      : phase === "timeout"
        ? "task_timed_out"
        : "task_failed";
  await appendOrchestrationEvent({
    eventPath: paths.eventLog,
    event: {
      type,
      orchestrationId: run.orchestrationId,
      idempotencyKey: `${run.invocationId}:execution:${phase}`,
      taskId: run.taskId,
      ...(run.agentType ? { agentType: run.agentType } : {}),
      ...(reason ? { reason } : {}),
    },
  });
}

async function patchRunAfterCompletion(
  paths: OrchestrationPaths,
  run: ActiveRun,
  phase: "completed" | "failed" | "cancelled" | "timeout",
  proof: EvidenceProofResult | undefined,
  awaitingReview: boolean,
  sessionReference?: string,
  worktreeResult?: WorktreeResult,
): Promise<void> {
  if (!run.invocationId) return;
  await patchDurableRun(paths.runStore, run.invocationId, {
    executionPhase: phase,
    verificationPhase: proof
      ? proof.valid
        ? "passed"
        : "failed"
      : "not-required",
    reviewPhase: awaitingReview
      ? "awaiting"
      : run.verifier?.required
        ? "accepted"
        : "not-required",
    verificationIssues: proof?.issues ?? [],
    ...(sessionReference ? { sessionReference } : {}),
    ...(worktreeResult
      ? {
          worktree: worktreeResult,
          worktreeResult,
          worktreeDisposition: worktreeResult.retained ? ("retained" as const) : ("removed" as const),
          executionDirectory: worktreeResult.path,
        }
      : {}),
  });
}

function normalizeExecutionPhase(
  details: Record<string, unknown> | undefined,
  isError: boolean,
): "completed" | "failed" | "cancelled" | "timeout" {
  if (isError) return "failed";
  const raw = String(details?.execution_phase ?? details?.phase ?? "done").toLowerCase();
  if (raw === "cancelled" || raw === "canceled" || raw === "aborted") return "cancelled";
  if (raw === "timeout" || raw === "timed_out") return "timeout";
  if (raw === "failed" || raw === "error") return "failed";
  return "completed";
}

function normalizeCompletionEvidence(
  value: unknown,
  sessionReference: string | undefined,
): ContextEvidence[] {
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items)) return [];
  const now = new Date().toISOString();
  return items.flatMap((item): ContextEvidence[] => {
    if (typeof item === "string" && item.trim()) {
      return [{
        description: item.trim(),
        reference: sessionReference
          ? `session:${sessionReference}`
          : `command:${item.trim()}`,
        recordedAt: now,
        source: sessionReference ? "runtime-session" : "declared",
      }];
    }
    if (
      isRecord(item) &&
      typeof item.description === "string" &&
      typeof item.reference === "string"
    ) {
      return [{
        description: item.description,
        reference: sessionReference
          ? `session:${sessionReference}`
          : item.reference,
        recordedAt: now,
        source: sessionReference ? "runtime-session" : "declared",
        ...(typeof item.claim === "string" ? { claim: item.claim } : {}),
      }];
    }
    return [];
  });
}

function mergeEvidence(
  left: readonly ContextEvidence[],
  right: readonly ContextEvidence[],
): ContextEvidence[] {
  const seen = new Set<string>();
  return [...left, ...right].filter((item) => {
    const key = `${item.reference}\0${item.claim ?? ""}\0${item.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sessionReferenceFromDetails(
  details: Record<string, unknown> | undefined,
): string | undefined {
  return stringValue(details?.session_path) ?? stringValue(details?.sessionReference);
}

function parseWorktreeResult(value: unknown): WorktreeResult | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.repositoryRoot !== "string" ||
    typeof value.path !== "string" ||
    typeof value.branch !== "string" ||
    typeof value.baseSha !== "string" ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.changedPaths) ||
    !value.changedPaths.every((path) => typeof path === "string") ||
    typeof value.diffDigest !== "string" ||
    typeof value.retained !== "boolean"
  ) {
    return undefined;
  }
  return value as unknown as WorktreeResult;
}

function changedPathsFromDetails(details: Record<string, unknown> | undefined): string[] {
  const worktree = isRecord(details?.worktree) ? details.worktree : undefined;
  const paths = worktree?.changedPaths ?? worktree?.changed_paths ?? details?.changed_paths;
  return Array.isArray(paths)
    ? paths.filter((path): path is string => typeof path === "string")
    : [];
}

function leaseCoversChangedPath(lease: ResourceLease, path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return lease.claims.some((claim) => {
    if (claim.kind !== "write") return false;
    const resource = claim.resource.replaceAll("\\", "/").replace(/\/$/u, "");
    return normalized === resource || normalized.startsWith(`${resource}/`);
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
