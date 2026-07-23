import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

const ORCHESTRATION_EVENT_VERSION = 1;

export type OrchestrationEventType =
  | "task_started"
  | "task_resumed"
  | "task_completed"
  | "task_failed"
  | "claim_acquired"
  | "claim_released"
  | "handoff_updated"
  | "proof_passed"
  | "proof_failed"
  | "review_completed";

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
  durationMs?: number;
  retryCount?: number;
  verificationPassed?: boolean;
  evidenceCount?: number;
  reviewFindings?: number;
  acceptedFindings?: number;
  usage?: TaskUsageSummary;
  reason?: string;
}

export interface OrchestrationEvent extends NewOrchestrationEvent {
  version: number;
  id: string;
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
  if (process.env.PI_SUBAGENTS_NO_TELEMETRY === "1") {
    return {
      ...input.event,
      version: ORCHESTRATION_EVENT_VERSION,
      id: randomUUID(),
      timestamp: input.event.timestamp ?? new Date().toISOString(),
    } as OrchestrationEvent;
  }
  const event: OrchestrationEvent = {
    ...input.event,
    version: ORCHESTRATION_EVENT_VERSION,
    id: randomUUID(),
    timestamp: input.event.timestamp ?? new Date().toISOString(),
  };
  await mkdir(dirname(input.eventPath), { recursive: true });
  await appendFile(input.eventPath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function readOrchestrationEvents(
  eventPath: string,
): Promise<OrchestrationEvent[]> {
  try {
    const content = await readFile(eventPath, "utf8");
    const events: OrchestrationEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const value: unknown = JSON.parse(line);
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
  const failures = input.events.filter((event) => event.type === "task_failed");
  const terminalTaskIds = new Set(
    [...completions, ...failures]
      .map((event) => event.taskId)
      .filter((taskId): taskId is string => taskId !== undefined),
  );
  const staleTasks = attempts.filter(
    (event) =>
      event.taskId !== undefined &&
      !terminalTaskIds.has(event.taskId) &&
      now.getTime() - Date.parse(event.timestamp) > staleAfterMs,
  ).length;

  const totalDurationMs = completions.reduce(
    (total, event) => total + (event.durationMs ?? 0),
    0,
  );
  const verificationEvents = completions.filter(
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
      completions.length === 0 ? 0 : totalDurationMs / completions.length,
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
    value === "task_completed" ||
    value === "task_failed" ||
    value === "claim_acquired" ||
    value === "claim_released" ||
    value === "handoff_updated" ||
    value === "proof_passed" ||
    value === "proof_failed" ||
    value === "review_completed"
  );
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
