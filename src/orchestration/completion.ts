import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { WorktreeResult } from "../worktree.js";
import {
  releaseResourceLease,
  type ResourceLease,
} from "./claims.js";
import type { ContextEvidence, ContextPack } from "./context.js";
import { captureSessionCommandReceipts } from "./evidence.js";
import { resolveTaskSessionReference } from "./lifecycle.js";
import { getOrchestrationPaths, type OrchestrationPaths } from "./paths.js";
import {
  validateEvidenceOnlyProof,
  type EvidenceProofResult,
} from "./proof.js";
import {
  completeDurableRun,
  getDurableRunByTaskId,
  listDurableRuns,
  patchDurableRun,
  type DurableTaskRun,
  type TaskReportedOutcome,
} from "./run-store.js";
import { taggedDigest } from "../learning-contract.js";
import {
  isAcceptingReviewerVerdict,
  isReviewerEventBound,
  taskSubjectDigest,
} from "./review.js";
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
  /** Prevent overlapping interval callbacks from racing lease transfer/renewal. */
  heartbeatInFlight?: boolean;
  contextPack?: ContextPack;
  proof?: OrchestrationRequest["proof"];
  verifier?: OrchestrationRequest["verifier"];
  projectDirectory: string;
  workspaceDirectory?: string;
  executionDirectory?: string;
  batchId?: string;
  joinMode?: "async" | "group";
  reportedOutcome?: TaskReportedOutcome;
  semanticAttestations?: import("./run-store.js").SemanticAttestationV1[];
}

export interface BackgroundCompletionResult {
  handled: boolean;
  taskId?: string;
  executionPhase?: "completed" | "failed" | "cancelled" | "timeout";
  reportedOutcome?: TaskReportedOutcome;
  decisionRequest?: Record<string, unknown>;
  decisionId?: string;
  proof?: EvidenceProofResult;
  awaitingReview?: boolean;
  issues: string[];
}

export async function recordForegroundCompletion(
  run: ActiveRun,
  paths: OrchestrationPaths,
  upstreamResult?: { details?: unknown; isError?: boolean },
  pi?: ExtensionAPI,
): Promise<EvidenceProofResult | undefined> {
  const details = isRecord(upstreamResult?.details) ? upstreamResult.details : undefined;
  const worktreeResult = parseWorktreeResult(details?.worktree);
  const executionPhase = normalizeExecutionPhase(details, upstreamResult?.isError === true);
  const reportedOutcome = normalizeReportedOutcome(
    details,
    upstreamResult?.isError === true,
  );
  const resolvedSessionReference =
    sessionReferenceFromDetails(details) ??
    (await resolveTaskSessionReference({
      projectDirectory: run.projectDirectory,
      taskId: run.taskId,
      sessionName: `task-${run.taskId}`,
    }));
  const runtimeEvidence = await captureRuntimeEvidence(
    run,
    resolvedSessionReference,
  );
  const evidence = mergeEvidence(
    run.contextPack?.evidence ?? [],
    runtimeEvidence,
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
      reportedOutcome,
      evidence,
    );
    return undefined;
  }

  // A clean process exit is not semantic success.  Do not let proof/review
  // gates run for a child that reported blocked, partial, reframed, or an
  // unparseable result.
  if (reportedOutcome !== "success") {
    await recordSemanticOutcome(
      run,
      paths,
      reportedOutcome,
      details,
      pi,
    );
    if (run.lease) await releaseLeaseAndRecord(paths, run.orchestrationId, run.lease);
    await patchRunAfterCompletion(
      paths,
      run,
      "completed",
      undefined,
      false,
      resolvedSessionReference,
      worktreeResult,
      reportedOutcome,
      evidence,
    );
    return undefined;
  }

  let proof = run.proof
    ? await validateEvidenceOnlyProof({
        projectDirectory: run.executionDirectory ?? run.projectDirectory,
        allowedProjectDirectories: [run.workspaceDirectory ?? run.projectDirectory],
        evidence,
        maxEvidenceAgeMs: run.proof.maxEvidenceAgeMs ?? 15 * 60 * 1_000,
        claims: run.contextPack?.claims,
        learningClaims: run.contextPack?.learningClaims,
        semanticAttestations: run.semanticAttestations,
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
        receiptIntegrityValid: false,
        semanticProofValid: proof?.semanticProofValid ?? false,
        supportedClaims: proof?.supportedClaims ?? [],
      };
    }
  }

  const awaitingReview = await recordExecutionAndReviewState(
    run,
    paths,
    proof,
    evidence.length,
    { reportedOutcome },
  );
  if (run.lease) await releaseLeaseAndRecord(paths, run.orchestrationId, run.lease);
  await patchRunAfterCompletion(
    paths,
    run,
    "completed",
    proof,
    awaitingReview,
    resolvedSessionReference,
    worktreeResult,
    reportedOutcome,
    evidence,
  );
  return proof;
}

export async function recordBackgroundCompletion(
  pi: ExtensionAPI,
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
        semanticAttestations: stored.semanticAttestations,
        verifier: stored.verifier,
        projectDirectory: stored.projectDirectory,
        workspaceDirectory: stored.workspaceDirectory ?? stored.projectDirectory,
        executionDirectory: stored.executionDirectory,
        batchId: stored.batchId,
        joinMode: stored.joinMode,
        reportedOutcome: stored.reportedOutcome,
      };
    }
  }
  if (!run) return { handled: false, taskId, issues: [] };

  const paths = getOrchestrationPaths(run.projectDirectory);
  const executionPhase = normalizeExecutionPhase(details, false);
  const reportedOutcome = normalizeReportedOutcome(details, false);
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
      reportedOutcome,
    );
    return { handled: true, taskId, executionPhase, reportedOutcome, issues: [] };
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
  const runtimeEvidence = await captureRuntimeEvidence(run, sessionReference);
  const evidence = mergeEvidence(
    run.contextPack?.evidence ?? [],
    runtimeEvidence,
  );
  if (reportedOutcome !== "success") {
    activeRuns.delete(taskId);
    const decisionId = await recordSemanticOutcome(
      run,
      paths,
      reportedOutcome,
      details,
      pi,
    );
    if (run.lease) await releaseLeaseAndRecord(paths, run.orchestrationId, run.lease);
    await patchRunAfterCompletion(
      paths,
      run,
      "completed",
      undefined,
      false,
      sessionReference,
      worktreeResult,
      reportedOutcome,
      evidence,
    );
    return {
      handled: true,
      taskId,
      executionPhase,
      reportedOutcome,
      decisionRequest: decisionRequestFromDetails(details),
      ...(decisionId ? { decisionId } : {}),
      issues: [],
    };
  }
  let proof = run.proof
    ? await validateEvidenceOnlyProof({
        projectDirectory: run.executionDirectory ?? run.projectDirectory,
        allowedProjectDirectories: [run.workspaceDirectory ?? run.projectDirectory],
        evidence,
        maxEvidenceAgeMs: run.proof.maxEvidenceAgeMs ?? 15 * 60 * 1_000,
        claims: run.contextPack?.claims,
        learningClaims: run.contextPack?.learningClaims,
        semanticAttestations: run.semanticAttestations,
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
        receiptIntegrityValid: false,
        semanticProofValid: proof?.semanticProofValid ?? false,
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
      reportedOutcome,
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
    reportedOutcome,
    evidence,
  );

  return {
    handled: true,
    taskId,
    executionPhase,
    proof,
    awaitingReview,
    reportedOutcome,
    issues: proof?.issues ?? [],
  };
}

export async function releaseLeaseAndRecord(
  paths: OrchestrationPaths,
  orchestrationId: string,
  lease: ResourceLease,
): Promise<void> {
  await releaseResourceLease({
    storePath: paths.leaseStore,
    leaseId: lease.id,
    // The owner recorded on the lease we are holding. A mismatch means the
    // lease was re-issued to someone else and must NOT be dropped from here.
    expectedOwner: lease.owner,
    expectedFence: lease.fence,
  });
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
    reportedOutcome?: TaskReportedOutcome;
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
      reportedOutcome: metrics.reportedOutcome ?? "success",
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
  if (
    proof &&
    !proof.valid &&
    !(proof.receiptIntegrityValid && run.verifier?.required)
  ) {
    return false;
  }

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
  const subject = await getDurableRunByTaskId(paths.runStore, run.taskId);
  if (!subject) {
    return `Pending independent review (0/${minReviews}; subject run unavailable)`;
  }
  let subjectDigest: string;
  try {
    subjectDigest = await taskSubjectDigest(run.projectDirectory, run.taskId);
  } catch {
    return `Pending independent review (0/${minReviews}; subject digest unavailable)`;
  }
  const runs = await listDurableRuns(paths.runStore);
  const reviewerTaskIds = new Set<string>();
  for (const event of events) {
    if (
      isAcceptingReviewerVerdict(event.verdict) &&
      (await isReviewerEventBound({
        event,
        subject,
        subjectDigest,
        projectDirectory: run.projectDirectory,
        runs,
      }))
    ) {
      reviewerTaskIds.add(event.reviewerTaskId!);
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
  reportedOutcome: TaskReportedOutcome = "unknown",
  evidence?: readonly ContextEvidence[],
): Promise<void> {
  if (!run.invocationId) return;
  const terminalPatch: Partial<DurableTaskRun> & {
    executionPhase: "completed" | "failed" | "cancelled" | "timeout";
  } = {
    executionPhase: phase,
    reportedOutcome,
    verificationPhase: proof
      ? proof.valid
        ? "passed"
        : proof.receiptIntegrityValid && run.verifier?.required
          ? "receipt-passed"
          : "failed"
      : reportedOutcome === "success"
        ? "not-required"
        : "failed",
    reviewPhase:
      reportedOutcome !== "success"
        ? "rejected"
        : awaitingReview
          ? "awaiting"
          : run.verifier?.required
            ? "accepted"
            : "not-required",
    verificationIssues:
      proof?.issues ??
      (reportedOutcome === "success"
        ? []
        : [`Child reported non-success outcome: ${reportedOutcome}`]),
    ...(run.contextPack && evidence
      ? {
          contextPack: {
            ...run.contextPack,
            evidence: evidence.map((item) => ({ ...item })),
          },
        }
      : {}),
    ...(sessionReference ? { sessionReference } : {}),
    ...(worktreeResult
      ? {
          worktree: worktreeResult,
          worktreeResult,
          worktreeDisposition: worktreeResult.retained ? ("retained" as const) : ("removed" as const),
          executionDirectory: worktreeResult.path,
        }
      : {}),
  };
  const resultDigest = taggedDigest({
    invocationId: run.invocationId,
    terminal: terminalPatch,
  });
  await completeDurableRun(
    paths.runStore,
    run.invocationId,
    resultDigest,
    terminalPatch,
  );
}

function normalizeReportedOutcome(
  details: Record<string, unknown> | undefined,
  isError: boolean,
): TaskReportedOutcome {
  if (isError) return "failure";
  const execution = normalizeExecutionPhase(details, false);
  if (execution === "failed") return "failure";
  if (execution === "cancelled" || execution === "timeout") return "unknown";
  if (decisionRequestFromDetails(details)) return "awaiting-decision";
  const raw = String(
    details?.reported_status ?? details?.reportedOutcome ?? details?.status ?? "",
  )
    .trim()
    .toLowerCase();
  if (
    raw === "success" ||
    raw === "failure" ||
    raw === "blocked" ||
    raw === "partial" ||
    raw === "reframed"
  ) {
    return raw;
  }
  return "unknown";
}

function decisionRequestFromDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const value = details?.decision_request ?? details?.decisionRequest;
  if (!isRecord(value)) return undefined;
  if (
    typeof value.question !== "string" ||
    !value.question.trim() ||
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > 8
  ) {
    return undefined;
  }
  const options = value.options.flatMap((option) => {
    if (
      !isRecord(option) ||
      typeof option.id !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/u.test(option.id) ||
      typeof option.label !== "string" ||
      !option.label.trim()
    ) {
      return [];
    }
    return [
      {
        id: option.id,
        label: option.label.trim(),
        ...(typeof option.tradeoff === "string" && option.tradeoff.trim()
          ? { tradeoff: option.tradeoff.trim() }
          : {}),
      },
    ];
  });
  if (options.length !== value.options.length) return undefined;
  return {
    question: value.question.trim(),
    options,
    ...(typeof value.context === "string" && value.context.trim()
      ? { context: value.context.trim() }
      : {}),
  };
}

async function recordSemanticOutcome(
  run: ActiveRun,
  paths: OrchestrationPaths,
  reportedOutcome: TaskReportedOutcome,
  details: Record<string, unknown> | undefined,
  pi?: ExtensionAPI,
): Promise<string | undefined> {
  const decision = decisionRequestFromDetails(details);
  let decisionId: string | undefined;
  if (reportedOutcome === "awaiting-decision" && decision && run.invocationId) {
    const canonical = JSON.stringify(decision);
    const hex = createHash("sha256").update(canonical).digest("hex");
    decisionId = `decision-${hex.slice(0, 24)}`;
    await patchDurableRun(paths.runStore, run.invocationId, {
      reportedOutcome,
      decisionRequest: {
        id: decisionId,
        question: String(decision.question),
        options: (decision.options as Array<Record<string, unknown>>).map(
          (option) => ({
            id: String(option.id),
            label: String(option.label),
            ...(typeof option.tradeoff === "string"
              ? { tradeoff: option.tradeoff }
              : {}),
          }),
        ),
        ...(typeof decision.context === "string"
          ? { context: decision.context }
          : {}),
        requestedAt: new Date().toISOString(),
        requestDigest: `sha256:v1:${hex}`,
        status: "pending",
      },
    });
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: "decision_requested",
        orchestrationId: run.orchestrationId,
        taskId: run.taskId,
        reportedOutcome,
        decisionId,
        idempotencyKey: `${run.invocationId}:decision:${decisionId}`,
      },
    });
    try {
      await pi?.events.emit("herdr:blocked", {
        active: true,
        blockerId: decisionId,
        taskId: run.taskId,
        label: String(decision.question),
      });
    } catch {
      // Herdr is a wake-up/UI projection. The durable decision remains the
      // authority and must settle even when that optional listener fails.
    }
  }
  await appendOrchestrationEvent({
    eventPath: paths.eventLog,
    event: {
      type:
        reportedOutcome === "awaiting-decision"
          ? "task_awaiting_decision"
          : "task_outcome_reported",
      orchestrationId: run.orchestrationId,
      taskId: run.taskId,
      ...(run.agentType ? { agentType: run.agentType } : {}),
      reportedOutcome,
      ...(decisionId ? { decisionId } : {}),
      idempotencyKey: `${run.invocationId}:outcome:${reportedOutcome}`,
    },
  });
  return decisionId;
}

async function captureRuntimeEvidence(
  run: ActiveRun,
  sessionReference: string | undefined,
): Promise<ContextEvidence[]> {
  if (!sessionReference) return [];
  const paths = getOrchestrationPaths(run.projectDirectory);
  try {
    const receipts = await captureSessionCommandReceipts({
      storeDirectory: paths.evidenceStore,
      projectDirectory: run.projectDirectory,
      taskId: run.taskId,
      producerTaskId: run.taskId,
      sessionPath: sessionReference,
      notBefore: run.startedAt,
    });
    return receipts.map((receipt) => ({
      description: receipt.description,
      reference: receipt.artifactPath,
      recordedAt: receipt.observedAt,
      receiptId: receipt.id,
      sha256: receipt.sha256,
      source: "runtime-receipt",
      receiptKind: receipt.kind,
      ...(receipt.exitCode === undefined ? {} : { exitCode: receipt.exitCode }),
      ...(receipt.command ? { command: receipt.command } : {}),
      ...(receipt.cwd ? { cwd: receipt.cwd } : {}),
      ...(receipt.toolCallId ? { toolCallId: receipt.toolCallId } : {}),
      ...(receipt.sessionDigest
        ? { sessionDigest: receipt.sessionDigest }
        : {}),
    }));
  } catch {
    return [];
  }
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
