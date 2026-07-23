import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  releaseResourceLease,
  type ResourceLease,
} from "./claims.js";
import type { ContextEvidence, ContextPack } from "./context.js";
import {
  resolveTaskSessionReference,
} from "./lifecycle.js";
import { getOrchestrationPaths, type OrchestrationPaths } from "./paths.js";
import {
  validateEvidenceOnlyProof,
  type EvidenceProofResult,
} from "./proof.js";
import { persistTaskHistoryReference } from "./task-state.js";
import {
  appendOrchestrationEvent,
  summarizeTaskSessionUsage,
} from "./telemetry.js";
import type { OrchestrationRequest } from "./contract.js";

export interface ActiveRun {
  orchestrationId: string;
  taskId: string;
  agentType?: string;
  startedAt: string;
  lease?: ResourceLease;
  contextPack?: ContextPack;
  proof?: OrchestrationRequest["proof"];
  projectDirectory: string;
}

export async function recordForegroundCompletion(
  run: ActiveRun,
  paths: OrchestrationPaths,
): Promise<EvidenceProofResult | undefined> {
  const evidence = run.contextPack?.evidence ?? [];
  const proof = run.proof
    ? await validateEvidenceOnlyProof({
        projectDirectory: run.projectDirectory,
        evidence,
        maxEvidenceAgeMs: run.proof.maxEvidenceAgeMs ?? 15 * 60 * 1_000,
      })
    : undefined;
  await appendOrchestrationEvent({
    eventPath: paths.eventLog,
    event: {
      type: proof && !proof.valid ? "task_failed" : "task_completed",
      orchestrationId: run.orchestrationId,
      taskId: run.taskId,
      ...(run.agentType ? { agentType: run.agentType } : {}),
      durationMs: Date.now() - Date.parse(run.startedAt),
      evidenceCount: evidence.length,
      ...(proof ? { verificationPassed: proof.valid } : {}),
      ...(proof && !proof.valid ? { reason: proof.issues.join(" ") } : {}),
    },
  });
  if (proof) {
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: proof.valid ? "proof_passed" : "proof_failed",
        orchestrationId: run.orchestrationId,
        taskId: run.taskId,
        ...(run.agentType ? { agentType: run.agentType } : {}),
        ...(proof.issues.length ? { reason: proof.issues.join(" ") } : {}),
      },
    });
  }
  if (run.lease) {
    await releaseLeaseAndRecord(paths, run.orchestrationId, run.lease);
  }
  return proof;
}

export async function recordBackgroundCompletion(
  pi: ExtensionAPI,
  activeRuns: Map<string, ActiveRun>,
  message: Record<string, unknown>,
): Promise<void> {
  const details = isRecord(message.details) ? message.details : undefined;
  const taskId = stringValue(details?.task_id) ?? stringValue(details?.taskId);
  if (!taskId) {
    return;
  }
  const run = activeRuns.get(taskId);
  if (!run) {
    return;
  }
  activeRuns.delete(taskId);
  const paths = getOrchestrationPaths(run.projectDirectory);
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
  const evidence = normalizeCompletionEvidence(
    details?.evidence,
    sessionReference,
  );
  const proof = run.proof
    ? await validateEvidenceOnlyProof({
        projectDirectory: run.projectDirectory,
        evidence,
        maxEvidenceAgeMs: run.proof.maxEvidenceAgeMs ?? 15 * 60 * 1_000,
      })
    : undefined;
  const durationMs = numericValue(details?.duration_ms);
  const retryCount = numericValue(details?.retry_count);

  await appendOrchestrationEvent({
    eventPath: paths.eventLog,
    event: {
      type: proof && !proof.valid ? "task_failed" : "task_completed",
      orchestrationId: run.orchestrationId,
      taskId,
      ...(run.agentType ? { agentType: run.agentType } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(retryCount === undefined ? {} : { retryCount }),
      evidenceCount: evidence.length,
      ...(proof ? { verificationPassed: proof.valid } : {}),
      ...(proof && !proof.valid ? { reason: proof.issues.join(" ") } : {}),
      ...(usage ? { usage } : {}),
    },
  });
  if (run.proof) {
    await appendOrchestrationEvent({
      eventPath: paths.eventLog,
      event: {
        type: proof?.valid ? "proof_passed" : "proof_failed",
        orchestrationId: run.orchestrationId,
        taskId,
        ...(run.agentType ? { agentType: run.agentType } : {}),
        ...(proof?.issues.length
          ? { reason: proof.issues.join(" ") }
          : {}),
      },
    });
    if (!proof?.valid) {
      pi.sendMessage(
        {
          customType: "orchestration-proof-failed",
          content: `Evidence-only review failed for ${taskId}: ${proof?.issues.join(" ")}`,
          display: true,
          details: { taskId, issues: proof?.issues ?? [] },
        },
        { triggerTurn: false },
      );
    }
  }
  if (run.lease) {
    await releaseLeaseAndRecord(paths, run.orchestrationId, run.lease);
  }
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
    },
  });
}

function normalizeCompletionEvidence(
  value: unknown,
  sessionReference: string | undefined,
): ContextEvidence[] {
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items)) {
    return [];
  }
  const now = new Date().toISOString();
  return items.flatMap((item): ContextEvidence[] => {
    if (typeof item === "string" && item.trim()) {
      return [
        {
          description: item.trim(),
          reference: sessionReference
            ? `session:${sessionReference}`
            : `command:${item.trim()}`,
          recordedAt: now,
        },
      ];
    }
    if (
      isRecord(item) &&
      typeof item.description === "string" &&
      typeof item.reference === "string"
    ) {
      return [
        {
          description: item.description,
          reference: item.reference,
          recordedAt:
            typeof item.recordedAt === "string" ? item.recordedAt : now,
        },
      ];
    }
    return [];
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
