import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import type { UsageReceiptV1 } from "../learning-contract.js";
import { withFileLock } from "./file-lock.js";

export const ORCHESTRATION_EVENT_VERSION = 1;

export type OrchestrationEventType =
  | "task_started"
  | "task_resumed"
  | "task_execution_completed"
  | "task_completed"
  | "task_failed"
  | "task_cancelled"
  | "task_timed_out"
  | "task_awaiting_review"
  | "claim_acquired"
  | "claim_released"
  | "claim_lease_lost"
  | "claim_store_quarantined"
  | "handoff_updated"
  | "proof_passed"
  | "proof_failed"
  | "review_completed"
  | "task_reviewed"
  | "task_shipped"
  | "task_ship_blocked"
  | "task_worktree_merged"
  | "task_worktree_removed";

export interface TaskUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  provider?: string;
  model?: string;
}

export interface NewOrchestrationEvent {
  type: OrchestrationEventType;
  orchestrationId: string;
  timestamp?: string;
  taskId?: string;
  agentType?: string;
  leaseId?: string;
  /** Lease generation token; a stale fence is refused by the write guard. */
  fence?: number;
  durationMs?: number;
  retryCount?: number;
  verificationPassed?: boolean;
  evidenceCount?: number;
  reviewFindings?: number;
  acceptedFindings?: number;
  reviewStatus?: "approved" | "changes_requested" | "rejected";
  reviewerAgent?: string;
  usage?: TaskUsageSummary;
  usageBindings?: UsageReceiptV1[];
  reason?: string;
  verdict?: string;
  reviewerTaskId?: string;
  reviewerInvocationId?: string;
  subjectDigest?: string;
  idempotencyKey?: string;
}

export interface OrchestrationEvent extends NewOrchestrationEvent {
  version: number;
  id: string;
  sequence: number;
  timestamp: string;
}

export interface OrchestrationMetrics {
  tasksStarted: number;
  tasksCompleted: number;
  tasksFailed: number;
  staleTasks: number;
  retries: number;
  totalDurationMs: number;
  averageDurationMs: number;
  totalTokens: number;
  totalCost: number;
  verificationPassRate: number | undefined;
  reviewYield: number | undefined;
  taskSuccessRate: number | undefined;
  tokensPerCompletedTask: number | undefined;
  costPerCompletedTask: number | undefined;
}

export async function appendOrchestrationEvent(input: {
  eventPath: string;
  event: NewOrchestrationEvent;
}): Promise<OrchestrationEvent> {
  // The lifecycle journal is correctness state and is always persisted. The
  // telemetry opt-out removes optional usage/performance fields only; it must
  // never disable recovery, leases, proof, review, or ship-gate state.
  const eventInput = process.env.PI_SUBAGENTS_NO_TELEMETRY === "1"
    ? withoutOptionalMetrics(input.event)
    : input.event;
  let persisted: OrchestrationEvent | undefined;
  await mkdir(dirname(input.eventPath), { recursive: true });
  await withFileLock({
    lockPath: `${input.eventPath}.lock`,
    operation: async () => {
      await repairJournalTail(input.eventPath);
      const events = await readOrchestrationEvents(input.eventPath);
      if (eventInput.idempotencyKey) {
        const existing = events.find(
          (candidate) => candidate.idempotencyKey === eventInput.idempotencyKey,
        );
        if (existing) {
          persisted = existing;
          return;
        }
      }
      const event: OrchestrationEvent = {
        ...eventInput,
        version: ORCHESTRATION_EVENT_VERSION,
        id: randomUUID(),
        sequence: nextSequence(events),
        timestamp: eventInput.timestamp ?? new Date().toISOString(),
      };
      await appendAndSync(input.eventPath, `${JSON.stringify(event)}\n`);
      persisted = event;
    },
  });
  if (!persisted) throw new Error("Orchestration event was not persisted");
  return persisted;
}

function nextSequence(events: readonly OrchestrationEvent[]): number {
  return events.reduce((highest, event, index) => {
    const sequence = Number.isInteger(event.sequence) ? event.sequence : index + 1;
    return Math.max(highest, sequence);
  }, 0) + 1;
}

async function appendAndSync(path: string, contents: string): Promise<void> {
  const handle = await open(path, "a");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function repairJournalTail(path: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!content || content.endsWith("\n")) return;

  const lastNewline = content.lastIndexOf("\n");
  const tail = content.slice(lastNewline + 1);
  try {
    const value: unknown = JSON.parse(tail);
    if (!isOrchestrationEvent(value)) throw new Error("invalid event tail");
    await appendAndSync(path, "\n");
  } catch {
    await truncate(path, lastNewline + 1);
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function readOrchestrationEvents(
  eventPath: string,
): Promise<OrchestrationEvent[]> {
  try {
    const content = await readFile(eventPath, "utf8");
    const events: OrchestrationEvent[] = [];
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        const isCrashTail = index === lines.length - 1 && !content.endsWith("\n");
        if (isCrashTail) break;
        throw error;
      }
      if (!isOrchestrationEvent(value)) {
        throw new Error(`Invalid orchestration event in ${eventPath}`);
      }
      events.push(value);
    }
    return events;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function summarizeTaskSessionUsage(
  sessionPath: string,
): Promise<TaskUsageSummary> {
  const content = await readFile(sessionPath, "utf8");
  const summary: TaskUsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  };

  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || value.type !== "message" || !isRecord(value.message)) {
      continue;
    }
    const message = value.message;
    if (message.role !== "assistant" || !isRecord(message.usage)) {
      continue;
    }

    const usage = message.usage;
    summary.inputTokens += numericValue(usage.input);
    summary.outputTokens += numericValue(usage.output);
    summary.cacheReadTokens += numericValue(usage.cacheRead);
    summary.cacheWriteTokens += numericValue(usage.cacheWrite);
    if (isRecord(usage.cost)) {
      summary.cost += numericValue(usage.cost.total);
    }
    if (typeof message.provider === "string") {
      summary.provider = message.provider;
    }
    if (typeof message.model === "string") {
      summary.model = message.model;
    }
  }

  summary.totalTokens =
    summary.inputTokens +
    summary.outputTokens +
    summary.cacheReadTokens +
    summary.cacheWriteTokens;
  summary.cost = Number(summary.cost.toFixed(12));
  return summary;
}

export function deriveOrchestrationMetrics(input: {
  events: readonly OrchestrationEvent[];
  now?: Date;
  staleAfterMs?: number;
}): OrchestrationMetrics {
  const now = input.now ?? new Date();
  const staleAfterMs = input.staleAfterMs ?? 30 * 60 * 1_000;
  const starts = input.events.filter((event) => event.type === "task_started");
  const attempts = input.events.filter(
    (event) => event.type === "task_started" || event.type === "task_resumed",
  );
  const completions = input.events.filter(
    (event) => event.type === "task_completed",
  );
  const executionCompletions = input.events.filter(
    (event) => event.type === "task_execution_completed",
  );
  const failures = input.events.filter(
    (event) =>
      event.type === "task_failed" ||
      event.type === "task_cancelled" ||
      event.type === "task_timed_out" ||
      event.type === "proof_failed",
  );
  const terminalTaskIds = new Set(
    [...executionCompletions, ...completions, ...failures]
      .map((event) => event.taskId)
      .filter((taskId): taskId is string => taskId !== undefined),
  );
  const staleTasks = attempts.filter(
    (event) =>
      event.taskId !== undefined &&
      !terminalTaskIds.has(event.taskId) &&
      now.getTime() - Date.parse(event.timestamp) > staleAfterMs,
  ).length;

  const measuredCompletions =
    executionCompletions.length > 0 ? executionCompletions : completions;
  const totalDurationMs = measuredCompletions.reduce(
    (total, event) => total + (event.durationMs ?? 0),
    0,
  );
  const verificationEvents = measuredCompletions.filter(
    (event) => event.verificationPassed !== undefined,
  );
  const reviewEvents = input.events.filter(
    (event) => event.type === "review_completed" && (event.reviewFindings ?? 0) > 0,
  );
  const reviewFindings = reviewEvents.reduce(
    (total, event) => total + (event.reviewFindings ?? 0),
    0,
  );
  const acceptedFindings = reviewEvents.reduce(
    (total, event) => total + (event.acceptedFindings ?? 0),
    0,
  );
  const totalTokens = input.events.reduce(
    (total, event) => total + (event.usage?.totalTokens ?? 0),
    0,
  );
  const totalCost = Number(
    input.events
      .reduce((total, event) => total + (event.usage?.cost ?? 0), 0)
      .toFixed(12),
  );
  const terminalTasks = completions.length + failures.length;

  return {
    tasksStarted: starts.length,
    tasksCompleted: completions.length,
    tasksFailed: failures.length,
    staleTasks,
    retries: input.events.reduce(
      (total, event) => total + (event.retryCount ?? 0),
      0,
    ),
    totalDurationMs,
    averageDurationMs:
      measuredCompletions.length === 0
        ? 0
        : totalDurationMs / measuredCompletions.length,
    totalTokens,
    totalCost,
    verificationPassRate:
      verificationEvents.length === 0
        ? undefined
        : verificationEvents.filter((event) => event.verificationPassed).length /
          verificationEvents.length,
    reviewYield:
      reviewFindings === 0 ? undefined : acceptedFindings / reviewFindings,
    taskSuccessRate:
      terminalTasks === 0 ? undefined : completions.length / terminalTasks,
    tokensPerCompletedTask:
      completions.length === 0 ? undefined : totalTokens / completions.length,
    costPerCompletedTask:
      completions.length === 0 ? undefined : totalCost / completions.length,
  };
}

function isOrchestrationEvent(value: unknown): value is OrchestrationEvent {
  return (
    isRecord(value) &&
    value.version === ORCHESTRATION_EVENT_VERSION &&
    typeof value.id === "string" &&
    typeof value.timestamp === "string" &&
    isEventType(value.type) &&
    typeof value.orchestrationId === "string"
  );
}

function isEventType(value: unknown): value is OrchestrationEventType {
  return (
    value === "task_started" ||
    value === "task_resumed" ||
    value === "task_execution_completed" ||
    value === "task_completed" ||
    value === "task_failed" ||
    value === "task_cancelled" ||
    value === "task_timed_out" ||
    value === "task_awaiting_review" ||
    value === "claim_acquired" ||
    value === "claim_released" ||
    value === "handoff_updated" ||
    value === "proof_passed" ||
    value === "proof_failed" ||
    value === "review_completed" ||
    value === "task_reviewed" ||
    value === "task_shipped" ||
    value === "task_ship_blocked" ||
    value === "task_worktree_merged" ||
    value === "task_worktree_removed"
  );
}

function withoutOptionalMetrics(
  event: NewOrchestrationEvent,
): NewOrchestrationEvent {
  const correctness = { ...event };
  delete correctness.durationMs;
  delete correctness.retryCount;
  delete correctness.reviewFindings;
  delete correctness.acceptedFindings;
  delete correctness.usage;
  return correctness;
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
