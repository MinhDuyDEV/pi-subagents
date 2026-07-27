import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_LEARNING_EVENTS_V1,
  makeProofVerifiedPayload,
  makeReviewCompletedPayload,
} from "../events.js";
import {
  inspectTaskWorktree,
  mergeTaskWorktree,
  removeTaskWorktree,
} from "../worktree.js";
import { releaseOrphanedLeases, releaseResourceLease } from "./claims.js";
import {
  buildContextPack,
  loadContextPack,
  saveContextPack,
  updateContextHandoff,
  type ContextHandoffPatch,
} from "./context.js";
import { runOrchestrationDoctor } from "./doctor.js";
import { recordEvidenceReceipt } from "./evidence.js";
import { getOrchestrationPaths, type OrchestrationPaths } from "./paths.js";
import { validateEvidenceOnlyProof } from "./proof.js";
import { getFinalTaskResult, getTaskSnapshot } from "./task-query.js";
import {
  getDurableRunByTaskId,
  isTerminalExecutionPhase,
  listDurableRuns,
  patchDurableRun,
} from "./run-store.js";
import {
  appendOrchestrationEvent,
  deriveOrchestrationMetrics,
  readOrchestrationEvents,
  type OrchestrationEvent,
} from "./telemetry.js";

const HandoffSchema = Type.Object(
  {
    decisions: Type.Optional(
      Type.Array(
        Type.Object(
          {
            statement: Type.String({ minLength: 1 }),
            rationale: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    evidence: Type.Optional(
      Type.Array(
        Type.Object(
          {
            description: Type.String({ minLength: 1 }),
            reference: Type.String({ minLength: 1 }),
            recorded_at: Type.Optional(Type.String()),
            claim: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    unknowns: Type.Optional(Type.Array(Type.String())),
    next_step: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const TaskControlParameters = Type.Object(
  {
    action: Type.Union([
      Type.Literal("status"),
      Type.Literal("result"),
      Type.Literal("handoff"),
      Type.Literal("record_evidence"),
      Type.Literal("verify"),
      Type.Literal("metrics"),
      Type.Literal("doctor"),
      Type.Literal("record_review"),
      Type.Literal("release"),
      Type.Literal("reap"),
      Type.Literal("review"),
      Type.Literal("ship"),
      Type.Literal("worktree_status"),
      Type.Literal("worktree_merge"),
      Type.Literal("worktree_remove"),
    ]),
    task_id: Type.Optional(Type.String({ minLength: 1 })),
    lease_id: Type.Optional(Type.String({ minLength: 1 })),
    handoff: Type.Optional(HandoffSchema),
    delegation_prompt: Type.Optional(Type.String()),
    ceremony_steps: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            unique_value: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    stale_after_ms: Type.Optional(Type.Number({ minimum: 1 })),
    review_findings: Type.Optional(Type.Integer({ minimum: 0 })),
    accepted_findings: Type.Optional(Type.Integer({ minimum: 0 })),
    reviewer_task_id: Type.Optional(Type.String({ minLength: 1 })),
    verdict: Type.Optional(Type.String()),
    evidence_kind: Type.Optional(
      Type.Union([
        Type.Literal("file"),
        Type.Literal("test"),
        Type.Literal("command-output"),
        Type.Literal("session"),
        Type.Literal("diff"),
      ]),
    ),
    evidence_description: Type.Optional(Type.String({ minLength: 1 })),
    evidence_reference: Type.Optional(Type.String({ minLength: 1 })),
    evidence_claim: Type.Optional(Type.String({ minLength: 1 })),
    evidence_exit_code: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

type TaskControlInput = Static<typeof TaskControlParameters>;

export function registerTaskControlTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "task_control",
    label: "Task Control",
    description:
      "Query delegated task status/results, append scoped handoffs or evidence, inspect local orchestration health, and perform explicit review or cleanup actions.",
    parameters: TaskControlParameters,
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      return executeHerdrAction(input, ctx.cwd, pi);
    },
  });
}

/** @deprecated Use registerTaskControlTool. */
export const registerHerdrTool = registerTaskControlTool;

async function executeHerdrAction(
  input: TaskControlInput,
  projectDirectory: string,
  pi?: ExtensionAPI,
) {
  const paths = getOrchestrationPaths(projectDirectory);
  switch (input.action) {
    case "status":
      return taskStatusResult(projectDirectory, requireValue(input.task_id, "task_id"));
    case "result":
      return taskFinalResult(projectDirectory, requireValue(input.task_id, "task_id"));
    case "handoff": {
      const taskId = requireValue(input.task_id, "task_id");
      if (!input.handoff) {
        throw new Error("handoff is required for the handoff action");
      }
      await ensureTaskContextPack(paths, projectDirectory, taskId);
      const pack = await updateContextHandoff({
        storeDirectory: paths.contextStore,
        key: taskId,
        patch: normalizeHandoff(input.handoff),
      });
      await appendOrchestrationEvent({
        eventPath: paths.eventLog,
        event: {
          type: "handoff_updated",
          orchestrationId: `handoff-${taskId}`,
          taskId,
        },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated Context Pack ${taskId} to revision ${pack.revision}.`,
          },
        ],
        details: { taskId, revision: pack.revision, status: "updated" },
      };
    }
    case "record_evidence": {
      const taskId = requireValue(input.task_id, "task_id");
      const run = await getDurableRunByTaskId(paths.runStore, taskId);
      if (!run) throw new Error(`Task not found: ${taskId}`);
      await ensureTaskContextPack(paths, projectDirectory, taskId, run);
      const receipt = await recordEvidenceReceipt({
        storeDirectory: paths.evidenceStore,
        projectDirectory: run.executionDirectory,
        taskId,
        producerTaskId: taskId,
        kind: requireValue(input.evidence_kind, "evidence_kind"),
        description: requireValue(
          input.evidence_description,
          "evidence_description",
        ),
        artifactPath: requireValue(input.evidence_reference, "evidence_reference"),
        claim: input.evidence_claim,
        exitCode: input.evidence_exit_code,
      });
      const pack = await updateContextHandoff({
        storeDirectory: paths.contextStore,
        key: taskId,
        patch: {
          evidence: [
            {
              description: receipt.description,
              reference: receipt.artifactPath,
              recordedAt: receipt.observedAt,
              claim: receipt.claim,
              receiptId: receipt.id,
              sha256: receipt.sha256,
              source: "runtime-receipt",
              receiptKind: receipt.kind,
              exitCode: receipt.exitCode,
            },
          ],
        },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Recorded immutable evidence ${receipt.id} for ${taskId}.`,
          },
        ],
        details: { taskId, receipt, contextRevision: pack.revision },
      };
    }
    case "verify": {
      const taskId = requireValue(input.task_id, "task_id");
      const run = await getDurableRunByTaskId(paths.runStore, taskId);
      if (!run) throw new Error(`Task not found: ${taskId}`);
      if (run.executionPhase !== "completed") {
        throw new Error(`Task ${taskId} has not completed execution`);
      }
      const pack = await loadContextPack({
        storeDirectory: paths.contextStore,
        key: taskId,
      });
      const proof = await validateEvidenceOnlyProof({
        projectDirectory: run.executionDirectory,
        allowedProjectDirectories: [projectDirectory],
        evidence: pack?.evidence ?? [],
        claims: pack?.claims,
        learningClaims: pack?.learningClaims,
        maxEvidenceAgeMs: run.proof?.maxEvidenceAgeMs ?? 15 * 60 * 1_000,
      });
      const currentWorktree =
        run.worktree && run.worktreeDisposition === "retained"
          ? inspectTaskWorktree(run.worktree)
          : undefined;
      await patchDurableRun(paths.runStore, run.invocationId, {
        verificationPhase: proof.valid ? "passed" : "failed",
        verificationIssues: proof.issues,
        reviewPhase:
          proof.valid && run.verifier?.required
            ? "awaiting"
            : run.verifier?.required
              ? run.reviewPhase
              : "not-required",
        ...(currentWorktree ? { worktreeResult: currentWorktree } : {}),
      });
      await appendOrchestrationEvent({
        eventPath: paths.eventLog,
        event: {
          type: proof.valid ? "proof_passed" : "proof_failed",
          orchestrationId: run.correlationId ?? run.invocationId,
          taskId,
          verificationPassed: proof.valid,
          ...(proof.issues.length ? { reason: proof.issues.join(" ") } : {}),
        },
      });
      if (proof.valid && run.verifier?.required) {
        await appendOrchestrationEvent({
          eventPath: paths.eventLog,
          event: {
            type: "task_awaiting_review",
            orchestrationId: run.correlationId ?? run.invocationId,
            taskId,
          },
        });
      } else if (proof.valid) {
        await appendOrchestrationEvent({
          eventPath: paths.eventLog,
          event: {
            type: "task_completed",
            orchestrationId: run.correlationId ?? run.invocationId,
            taskId,
            verificationPassed: true,
          },
        });
      }
      // Emit learning event after durable recording (fail-open)
      if (pi?.events) {
        const proofPayload = makeProofVerifiedPayload(
          taskId,
          proof.valid,
          proof.issues,
          (pack?.evidence ?? []).map((e) => e.sha256 ?? "").filter(Boolean),
          run.correlationId ?? run.invocationId,
          run.contextRequestDigest
            ? {
                requestDigest: run.contextRequestDigest,
                ...(run.learningBinding ?? {}),
                supportedClaims: proof.supportedClaims,
              }
            : undefined,
        );
        try {
          await pi.events.emit(SUBAGENT_LEARNING_EVENTS_V1.PROOF_VERIFIED, proofPayload);
        } catch {
          // fail-open: listener error must not block task control
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: proof.valid
              ? `Verification passed for ${taskId}.`
              : `Verification failed for ${taskId}: ${proof.issues.join(" ")}`,
          },
        ],
        details: { taskId, ...proof },
        ...(proof.valid ? {} : { isError: true }),
      };
    }
    case "metrics": {
      const events = await readOrchestrationEvents(paths.eventLog);
      const metrics = deriveOrchestrationMetrics({
        events,
        staleAfterMs: input.stale_after_ms,
      });
      return {
        content: [{ type: "text" as const, text: renderMetrics(metrics) }],
        details: metrics,
      };
    }
    case "doctor": {
      const result = await runOrchestrationDoctor({
        projectDirectory,
        delegationPrompt: input.delegation_prompt,
        ceremonySteps: input.ceremony_steps?.map((step) => ({
          name: step.name,
          uniqueValue: step.unique_value,
        })),
        staleAfterMs: input.stale_after_ms,
      });
      return {
        content: [{ type: "text" as const, text: renderDoctorResult(result) }],
        details: result,
      };
    }
    case "record_review": {
      const taskId = requireValue(input.task_id, "task_id");
      const findings = requireNumber(input.review_findings, "review_findings");
      const accepted = requireNumber(input.accepted_findings, "accepted_findings");
      if (accepted > findings) {
        throw new Error("accepted_findings must not exceed review_findings");
      }
      const reviewedRun = await getDurableRunByTaskId(paths.runStore, taskId);
      await appendOrchestrationEvent({
        eventPath: paths.eventLog,
        event: {
          type: "review_completed",
          orchestrationId: `review-${taskId}`,
          taskId,
          agentType: "reviewer",
          reviewFindings: findings,
          acceptedFindings: accepted,
          reviewStatus: accepted > 0 ? "changes_requested" : "approved",
          ...(reviewedRun?.usageBindings?.length
            ? { usageBindings: reviewedRun.usageBindings }
            : {}),
        },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Recorded review yield for ${taskId}: ${accepted}/${findings}.`,
          },
        ],
        details: { taskId, reviewFindings: findings, acceptedFindings: accepted },
      };
    }
    case "review": {
      const taskId = requireValue(input.task_id, "task_id");
      const reviewerTaskId = requireValue(
        input.reviewer_task_id,
        "reviewer_task_id",
      );
      const verdict = requireValue(input.verdict, "verdict");
      if (reviewerTaskId === taskId) {
        throw new Error("A task cannot independently review itself");
      }
      const subject = await getDurableRunByTaskId(paths.runStore, taskId);
      const reviewer = await getDurableRunByTaskId(paths.runStore, reviewerTaskId);
      if (!subject) throw new Error(`Subject task not found: ${taskId}`);
      if (!reviewer) throw new Error(`Reviewer task not found: ${reviewerTaskId}`);
      assertWorktreeMatchesVerifiedSnapshot(subject, taskId);
      if (subject.executionPhase !== "completed") {
        throw new Error(`Subject task ${taskId} has not completed execution`);
      }
      if (
        subject.verificationPhase !== "passed" &&
        subject.verificationPhase !== "not-required"
      ) {
        throw new Error(`Subject task ${taskId} has not passed verification`);
      }
      if (reviewer.executionPhase !== "completed") {
        throw new Error(`Reviewer task ${reviewerTaskId} has not completed execution`);
      }
      if (
        reviewer.verificationPhase !== "passed" &&
        reviewer.verificationPhase !== "not-required"
      ) {
        throw new Error(`Reviewer task ${reviewerTaskId} has not passed verification`);
      }
      if (
        subject.verifier?.reviewerAgent &&
        reviewer.agentType !== subject.verifier.reviewerAgent
      ) {
        throw new Error(
          `Reviewer task must use agent ${subject.verifier.reviewerAgent}, got ${reviewer.agentType ?? "unknown"}`,
        );
      }
      const subjectDigest = await taskSubjectDigest(projectDirectory, taskId);
      const existingReviews = await readOrchestrationEvents(paths.eventLog);
      const existingReview = existingReviews.find(
        (event) =>
          event.type === "task_reviewed" &&
          event.taskId === taskId &&
          event.reviewerTaskId === reviewerTaskId &&
          event.subjectDigest === subjectDigest,
      );
      if (
        existingReview?.verdict !== undefined &&
        existingReview.verdict.trim().toLowerCase() !== verdict.trim().toLowerCase()
      ) {
        throw new Error(
          `Reviewer ${reviewerTaskId} already recorded an immutable verdict for this subject digest`,
        );
      }
      await appendOrchestrationEvent({
        eventPath: paths.eventLog,
        event: {
          type: "task_reviewed",
          orchestrationId: reviewer.invocationId,
          taskId,
          reviewerTaskId,
          reviewerInvocationId: reviewer.invocationId,
          subjectDigest,
          verdict,
          idempotencyKey: `${reviewer.invocationId}:review:${subject.invocationId}:${subjectDigest}`,
        },
      });
      if (!isAcceptingVerdict(verdict)) {
        await patchDurableRun(paths.runStore, subject.invocationId, {
          reviewPhase: "rejected",
        });
      }
      // Emit learning event after durable recording (fail-open)
      if (pi?.events) {
        const reviewPayload = makeReviewCompletedPayload(
          taskId,
          verdict,
          reviewerTaskId,
          reviewer.invocationId,
          subjectDigest,
          subject.correlationId ?? subject.invocationId,
        );
        try {
          await pi.events.emit(SUBAGENT_LEARNING_EVENTS_V1.REVIEW_COMPLETED, reviewPayload);
        } catch {
          // fail-open: listener error must not block task control
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Recorded review for ${taskId}: ${verdict} by reviewer task ${reviewerTaskId}.`,
          },
        ],
        details: {
          taskId,
          reviewerTaskId,
          verdict,
          reviewerInvocationId: reviewer.invocationId,
          subjectDigest,
        },
      };
    }
    case "ship": {
      const taskId = requireValue(input.task_id, "task_id");
      const subject = await getDurableRunByTaskId(paths.runStore, taskId);
      if (!subject) throw new Error(`Task not found: ${taskId}`);
      if (subject.executionPhase !== "completed") {
        throw new Error(`Task ${taskId} has not completed execution`);
      }
      assertWorktreeMatchesVerifiedSnapshot(subject, taskId);
      if (subject.verificationPhase === "failed") {
        throw new Error(`Task ${taskId} failed verification and cannot ship`);
      }
      if (subject.verificationPhase === "pending") {
        throw new Error(`Task ${taskId} has not completed verification`);
      }
      const minReviews = subject.verifier?.required
        ? subject.verifier.minReviews ?? 1
        : 0;
      const subjectDigest = await taskSubjectDigest(projectDirectory, taskId);
      const events = await readOrchestrationEvents(paths.eventLog);
      const reviewers = new Set(
        events
          .filter(
            (event) =>
              event.type === "task_reviewed" &&
              event.taskId === taskId &&
              event.reviewerTaskId &&
              event.reviewerTaskId !== taskId &&
              event.subjectDigest === subjectDigest &&
              isAcceptingVerdict(event.verdict),
          )
          .map((event) => event.reviewerTaskId as string),
      );
      if (reviewers.size >= minReviews) {
        await appendOrchestrationEvent({
          eventPath: paths.eventLog,
          event: {
            type: "task_shipped",
            orchestrationId: subject.invocationId,
            taskId,
            subjectDigest,
            idempotencyKey: `${subject.invocationId}:ship:${subjectDigest}`,
          },
        });
        await patchDurableRun(paths.runStore, subject.invocationId, {
          reviewPhase: minReviews > 0 ? "accepted" : "not-required",
        });
        if (
          !events.some(
            (event) => event.type === "task_completed" && event.taskId === taskId,
          )
        ) {
          await appendOrchestrationEvent({
            eventPath: paths.eventLog,
            event: {
              type: "task_completed",
              orchestrationId: subject.invocationId,
              taskId,
              verificationPassed: subject.verificationPhase === "passed",
              idempotencyKey: `${subject.invocationId}:execution:verified`,
            },
          });
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Shipped (${reviewers.size} independent review${
                reviewers.size === 1 ? "" : "s"
              }).`,
            },
          ],
          details: { taskId, shipped: true, reviews: reviewers.size, subjectDigest },
        };
      }
      const reason = `Pending independent review (${reviewers.size}/${minReviews})`;
      await appendOrchestrationEvent({
        eventPath: paths.eventLog,
        event: {
          type: "task_ship_blocked",
          orchestrationId: subject.invocationId,
          taskId,
          reason,
        },
      });
      return {
        content: [{ type: "text" as const, text: `${reason}.` }],
        details: {
          taskId,
          shipped: false,
          reviews: reviewers.size,
          required: minReviews,
          subjectDigest,
        },
      };
    }
    case "worktree_status": {
      const taskId = requireValue(input.task_id, "task_id");
      const run = await requireRunWithOwnedWorktree(paths, taskId);
      let current = run.worktreeResult;
      if (run.worktreeDisposition === "retained") {
        current = inspectTaskWorktree(run.worktree!);
        await patchDurableRun(paths.runStore, run.invocationId, {
          worktreeResult: current,
        });
      }
      return {
        content: [
          {
            type: "text" as const,
            text: current
              ? `Worktree ${run.worktreeDisposition ?? (current.retained ? "retained" : "removed")}: ${current.changedPaths.length} changed path(s), ${current.diffDigest}.`
              : `Worktree ${run.worktreeDisposition ?? "allocated"}: ${run.worktree!.path}.`,
          },
        ],
        details: {
          taskId,
          disposition: run.worktreeDisposition,
          worktree: current ?? run.worktree,
        },
      };
    }
    case "worktree_merge": {
      const taskId = requireValue(input.task_id, "task_id");
      const run = await requireRunWithOwnedWorktree(paths, taskId);
      assertRunReadyToMerge(run, taskId);
      const currentDigest = await taskSubjectDigest(projectDirectory, taskId);
      const events = await readOrchestrationEvents(paths.eventLog);
      if (
        !events.some(
          (event) =>
            event.type === "task_shipped" &&
            event.taskId === taskId &&
            event.subjectDigest === currentDigest,
        )
      ) {
        throw new Error(
          `Task ${taskId} must pass task_control ship for its current digest before merge`,
        );
      }
      if (run.worktreeDisposition !== "retained") {
        throw new Error(`Task ${taskId} has no retained worktree to merge`);
      }
      const merged = mergeTaskWorktree(
        run.worktree!,
        `Merge delegated task ${taskId}`,
        run.worktreeResult?.diffDigest,
      );
      await patchDurableRun(paths.runStore, run.invocationId, {
        worktreeResult: merged.result,
        worktreeDisposition: "merged",
        mergeCommitSha: merged.mergeSha,
      });
      await appendOrchestrationEvent({
        eventPath: paths.eventLog,
        event: {
          type: "task_worktree_merged",
          orchestrationId: run.correlationId ?? run.invocationId,
          taskId,
          subjectDigest: merged.result.diffDigest,
        },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Merged task ${taskId} as ${merged.mergeSha}; removed its owned worktree.`,
          },
        ],
        details: { taskId, ...merged, disposition: "merged" },
      };
    }
    case "worktree_remove": {
      const taskId = requireValue(input.task_id, "task_id");
      const run = await requireRunWithOwnedWorktree(paths, taskId);
      if (!isTerminalExecutionPhase(run.executionPhase)) {
        throw new Error(`Task ${taskId} is still active; stop it before removing its worktree`);
      }
      if (run.worktreeDisposition === "merged" || run.worktreeDisposition === "removed") {
        return {
          content: [{ type: "text" as const, text: `Task ${taskId} worktree is already ${run.worktreeDisposition}.` }],
          details: { taskId, disposition: run.worktreeDisposition },
        };
      }
      removeTaskWorktree(run.worktree!, true);
      await patchDurableRun(paths.runStore, run.invocationId, {
        worktreeDisposition: "removed",
        ...(run.worktreeResult
          ? { worktreeResult: { ...run.worktreeResult, retained: false } }
          : {}),
      });
      await appendOrchestrationEvent({
        eventPath: paths.eventLog,
        event: {
          type: "task_worktree_removed",
          orchestrationId: run.correlationId ?? run.invocationId,
          taskId,
        },
      });
      return {
        content: [{ type: "text" as const, text: `Removed retained worktree for ${taskId}.` }],
        details: { taskId, disposition: "removed" },
      };
    }
    case "release": {
      const taskId = requireValue(input.task_id, "task_id");
      const run = await getDurableRunByTaskId(paths.runStore, taskId);
      if (!run?.lease) throw new Error(`Task ${taskId} has no recorded lease`);
      const leaseId = input.lease_id ?? run.lease.id;
      if (leaseId !== run.lease.id) {
        throw new Error(`Lease ${leaseId} is not owned by task ${taskId}`);
      }
      const released = await releaseResourceLease({
        storePath: paths.leaseStore,
        leaseId,
        expectedOwner: run.lease.owner,
      });
      if (!released) {
        return {
          content: [
            { type: "text" as const, text: `Lease ${leaseId} was not active.` },
          ],
          details: { leaseId, released: false },
        };
      }
      await appendOrchestrationEvent({
        eventPath: paths.eventLog,
        event: {
          type: "claim_released",
          orchestrationId: `manual-release-${leaseId}`,
          leaseId,
        },
      });
      return {
        content: [
          { type: "text" as const, text: `Released lease ${leaseId}.` },
        ],
        details: { leaseId, released: true },
      };
    }
    case "reap": {
      const now = Date.now();
      const staleAfterMs = input.stale_after_ms ?? 30 * 60 * 1_000;
      const runs = await listDurableRuns(paths.runStore);
      // Count BOTH ids a run can own a lease under. A lease is acquired under
      // the invocation id and only transferred to the task id once the task has
      // been allocated; a run reaped inside that window is alive but was not in
      // this set, so its live lease was released out from under it.
      const aliveOwnerIds = new Set<string>();
      for (const run of runs) {
        if (isTerminalExecutionPhase(run.executionPhase)) continue;
        if (now - Date.parse(run.heartbeatAt) >= staleAfterMs) continue;
        aliveOwnerIds.add(run.invocationId);
        if (run.taskId) aliveOwnerIds.add(run.taskId);
      }
      const reaped = await releaseOrphanedLeases({
        storePath: paths.leaseStore,
        aliveOwnerIds,
      });
      for (const leaseId of reaped) {
        await appendOrchestrationEvent({
          eventPath: paths.eventLog,
          event: {
            type: "claim_released",
            orchestrationId: `reap-${leaseId}`,
            leaseId,
          },
        });
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              reaped.length > 0
                ? `Reaped ${reaped.length} orphaned lease(s): ${reaped.join(", ")}.`
                : "No orphaned leases to reap.",
          },
        ],
        details: { reaped: reaped.length, leaseIds: reaped },
      };
    }
  }
}

async function taskStatusResult(projectDirectory: string, taskId: string) {
  const snapshot = await getTaskSnapshot(projectDirectory, taskId);
  const paths = getOrchestrationPaths(projectDirectory);
  const run = await getDurableRunByTaskId(paths.runStore, taskId);

  const lines = [
    `Task ID: ${taskId}`,
    `Status: ${snapshot.status}`,
    ...(run
      ? [
          `Execution: ${run.executionPhase}`,
          `Verification: ${run.verificationPhase}`,
          `Review: ${run.reviewPhase}`,
        ]
      : []),
    `Session reference: ${snapshot.sessionName}`,
  ];
  if (snapshot.sessionReference) {
    lines.push(`Session file: ${snapshot.sessionReference}`);
  }
  if (snapshot.description) {
    lines.push(`Description: ${snapshot.description}`);
  }
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { ...snapshot, run },
  };
}

async function taskFinalResult(projectDirectory: string, taskId: string) {
  const snapshot = await getTaskSnapshot(projectDirectory, taskId);
  if (!snapshot.sessionReference) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No canonical session is available for task ${taskId}.`,
        },
      ],
      details: snapshot,
      isError: true,
    };
  }
  const result = await getFinalTaskResult(snapshot);

  // For write/sensitive tasks, do not surface the subagent's
  // raw self-report when evidence-only proof fails. Re-run the evidence-only
  // validation as of task completion and surface a "claim not proven by evidence"
  // message with the proof issues instead. Non-write tasks keep the raw result.
  const paths = getOrchestrationPaths(projectDirectory);
  const proofIssues = await detectWriteTaskProofFailure(
    projectDirectory,
    paths,
    taskId,
  );
  if (proofIssues) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Claim not proven by evidence for task ${taskId}. Issues: ${proofIssues}`,
        },
      ],
      details: snapshot,
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: result ?? `Task ${taskId} has no assistant result yet.`,
      },
    ],
    details: snapshot,
    ...(result ? {} : { isError: true }),
  };
}

async function detectWriteTaskProofFailure(
  projectDirectory: string,
  paths: OrchestrationPaths,
  taskId: string,
): Promise<string | undefined> {
  // Legacy tasks with no durable proof state may return their raw result. Once a
  // task has verification state, corruption/unavailability fails closed instead
  // of surfacing an unverified self-report as success.
  try {
    const durable = await getDurableRunByTaskId(paths.runStore, taskId);
    if (durable?.verificationPhase === "failed") {
      return durable.verificationIssues.join(" ") || "Verification failed.";
    }
    if (durable?.verificationPhase === "passed") {
      return undefined;
    }
    const pack = await loadContextPack({
      storeDirectory: paths.contextStore,
      key: taskId,
    });
    const isWriteAuthorized =
      pack?.authorization === "write-approved" ||
      pack?.authorization === "sensitive-approved";
    if (!isWriteAuthorized) {
      return undefined;
    }
    const events = await readOrchestrationEvents(paths.eventLog);
    // Only re-validate when the completion path actually ran. If it was skipped
    // (PI_SUBAGENTS_NO_PROOF explicit opt-out records no task_completed event),
    // honor the opt-out and return the raw result.
    const completionEvent = findLastTaskEvent(events, taskId, [
      "task_completed",
      "task_failed",
    ]);
    if (!completionEvent) {
      return undefined;
    }
    // Evaluate evidence freshness as of task completion so a delayed `herdr
    // result` query does not falsely stale evidence that was fresh when the
    // task finished.
    const proof = await validateEvidenceOnlyProof({
      projectDirectory: durable?.executionDirectory ?? projectDirectory,
      allowedProjectDirectories: [projectDirectory],
      evidence: pack?.evidence ?? [],
      maxEvidenceAgeMs: 15 * 60 * 1_000,
      ...(completionEvent.timestamp
        ? { now: new Date(completionEvent.timestamp) }
        : {}),
    });
    return proof.valid ? undefined : proof.issues.join(" ");
  } catch (error) {
    return `Verification state unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function findLastTaskEvent(
  events: OrchestrationEvent[],
  taskId: string,
  types: string[],
): OrchestrationEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.taskId === taskId && types.includes(event.type)) {
      return event;
    }
  }
  return undefined;
}

function renderMetrics(metrics: ReturnType<typeof deriveOrchestrationMetrics>): string {
  return [
    `Started tasks: ${metrics.tasksStarted}`,
    `Completed tasks: ${metrics.tasksCompleted}`,
    `Failed tasks: ${metrics.tasksFailed}`,
    `Stale tasks: ${metrics.staleTasks}`,
    `Retries: ${metrics.retries}`,
    `Total tokens: ${metrics.totalTokens}`,
    `Total cost: ${metrics.totalCost}`,
    `Task success rate: ${metrics.taskSuccessRate ?? "n/a"}`,
    `Tokens per completed task: ${metrics.tokensPerCompletedTask ?? "n/a"}`,
    `Cost per completed task: ${metrics.costPerCompletedTask ?? "n/a"}`,
    `Review yield: ${metrics.reviewYield ?? "n/a"}`,
  ].join("\n");
}

function renderDoctorResult(
  result: Awaited<ReturnType<typeof runOrchestrationDoctor>>,
): string {
  if (result.ok) {
    return "Orchestration doctor: healthy.";
  }
  return [
    `Orchestration doctor: ${result.issues.length} issue(s).`,
    ...result.issues.map(
      (issue) =>
        `[${issue.severity}] ${issue.code}: ${issue.message} ${issue.remediation}`,
    ),
  ].join("\n");
}

function normalizeHandoff(
  handoff: NonNullable<TaskControlInput["handoff"]>,
): ContextHandoffPatch {
  return {
    ...(handoff.decisions
      ? { decisions: handoff.decisions.map((decision) => ({ ...decision })) }
      : {}),
    ...(handoff.evidence
      ? {
          evidence: handoff.evidence.map((evidence) => ({
            description: evidence.description,
            reference: evidence.reference,
            ...(evidence.recorded_at
              ? { recordedAt: evidence.recorded_at }
              : {}),
            ...(evidence.claim ? { claim: evidence.claim } : {}),
          })),
        }
      : {}),
    ...(handoff.unknowns ? { unknowns: [...handoff.unknowns] } : {}),
    ...(handoff.next_step ? { nextStep: handoff.next_step } : {}),
  };
}

async function requireRunWithOwnedWorktree(
  paths: OrchestrationPaths,
  taskId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getDurableRunByTaskId>>>> {
  const run = await getDurableRunByTaskId(paths.runStore, taskId);
  if (!run) throw new Error(`Task not found: ${taskId}`);
  const handle = run.worktree;
  if (!handle) throw new Error(`Task ${taskId} has no recorded worktree`);
  const expectedRoot = resolve(
    dirname(handle.repositoryRoot),
    ".pi-subagents-worktrees",
    basename(handle.repositoryRoot),
  );
  const relativePath = relative(expectedRoot, resolve(handle.path));
  if (
    !handle.branch.startsWith("pi-subagents/") ||
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Task ${taskId} has an invalid worktree ownership record`);
  }
  return run;
}

function assertWorktreeMatchesVerifiedSnapshot(
  run: NonNullable<Awaited<ReturnType<typeof getDurableRunByTaskId>>>,
  taskId: string,
): void {
  if (!run.worktree || run.worktreeDisposition !== "retained") return;
  const current = inspectTaskWorktree(run.worktree);
  if (!run.worktreeResult || current.diffDigest !== run.worktreeResult.diffDigest) {
    throw new Error(
      `Task ${taskId} worktree changed after verification; run task_control verify again`,
    );
  }
}

function assertRunReadyToMerge(
  run: NonNullable<Awaited<ReturnType<typeof getDurableRunByTaskId>>>,
  taskId: string,
): void {
  assertWorktreeMatchesVerifiedSnapshot(run, taskId);
  if (run.executionPhase !== "completed") {
    throw new Error(`Task ${taskId} has not completed execution`);
  }
  if (
    run.verificationPhase !== "passed" &&
    run.verificationPhase !== "not-required"
  ) {
    throw new Error(`Task ${taskId} has not passed verification`);
  }
  if (run.reviewPhase !== "accepted" && run.reviewPhase !== "not-required") {
    throw new Error(`Task ${taskId} has not passed independent review`);
  }
}

async function ensureTaskContextPack(
  paths: OrchestrationPaths,
  projectDirectory: string,
  taskId: string,
  knownRun?: Awaited<ReturnType<typeof getDurableRunByTaskId>>,
): Promise<void> {
  const existing = await loadContextPack({
    storeDirectory: paths.contextStore,
    key: taskId,
  });
  if (existing) return;
  const run = knownRun ?? (await getDurableRunByTaskId(paths.runStore, taskId));
  if (!run) throw new Error(`Task not found: ${taskId}`);
  const created = await buildContextPack({
    projectDirectory,
    input: {
      goal: run.description ?? `Continue task ${taskId}`,
      authorization: run.claims.some((claim) => claim.kind === "write")
        ? "write-approved"
        : "read-only",
      nextStep: "Record the next handoff or evidence receipt.",
    },
  });
  await saveContextPack({
    storeDirectory: paths.contextStore,
    key: taskId,
    pack: created,
  });
}

async function taskSubjectDigest(
  projectDirectory: string,
  taskId: string,
): Promise<string> {
  const snapshot = await getTaskSnapshot(projectDirectory, taskId);
  if (!snapshot.sessionReference) {
    throw new Error(`Task ${taskId} has no canonical session to review`);
  }
  const hash = createHash("sha256");
  hash.update(await readFile(snapshot.sessionReference));
  const paths = getOrchestrationPaths(projectDirectory);
  const run = await getDurableRunByTaskId(paths.runStore, taskId);
  if (run?.worktree) {
    const worktreeResult =
      run.worktreeDisposition === "retained"
        ? inspectTaskWorktree(run.worktree)
        : run.worktreeResult;
    if (worktreeResult) {
      hash.update("\0worktree\0");
      hash.update(worktreeResult.diffDigest);
    }
  }
  const pack = await loadContextPack({
    storeDirectory: paths.contextStore,
    key: taskId,
  });
  if (pack) {
    hash.update("\0context\0");
    hash.update(JSON.stringify(pack.evidence));
  }
  return `sha256:${hash.digest("hex")}`;
}

function isAcceptingVerdict(verdict: string | undefined): boolean {
  return verdict !== undefined && /^(approve|approved|accept|accepted|pass|passed)$/iu.test(verdict.trim());
}

function requireValue<T extends string>(value: T | undefined, name: string): T {
  if (!value) {
    throw new Error(`${name} is required for this action`);
  }
  return value;
}

function requireNumber(value: number | undefined, name: string): number {
  if (value === undefined) {
    throw new Error(`${name} is required for this action`);
  }
  return value;
}
