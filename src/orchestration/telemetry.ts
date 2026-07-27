import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { UsageReceiptV1 } from "../learning-contract.js";
import { withFileLock } from "./file-lock.js";

export const ORCHESTRATION_EVENT_VERSION = 1;

/**
 * Every event type, in one place.
 *
 * The union and the runtime type guard used to be written out separately, and
 * the guard rejects anything it does not list — while the writer validates
 * nothing. Adding a type to only one of them therefore produced an event that
 * appended cleanly and then made every subsequent read of the journal throw,
 * which in turn fails the write guard closed and blocks all writes. Deriving
 * both from this array removes the possibility.
 */
export const ORCHESTRATION_EVENT_TYPES = [
  "task_started",
  "task_resumed",
  "task_execution_completed",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "task_timed_out",
  "task_outcome_reported",
  "task_awaiting_decision",
  "decision_requested",
  "decision_responded",
  "task_awaiting_review",
  "claim_acquired",
  "claim_released",
  "claim_lease_lost",
  "claim_store_quarantined",
  "handoff_updated",
  "proof_passed",
  "proof_failed",
  "review_completed",
  "task_reviewed",
  "task_shipped",
  "task_ship_blocked",
  "task_worktree_merged",
  "task_worktree_removed",
] as const;

export type OrchestrationEventType = (typeof ORCHESTRATION_EVENT_TYPES)[number];

/**
 * Rotate the journal once the live segment passes this size. Appending is
 * O(1) regardless, but every reader (metrics, doctor, replay, review dedup)
 * parses whatever is live, so an unbounded file degrades them all.
 */
const MAX_SEGMENT_BYTES = 4 * 1024 * 1024;

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
  reviewerOutputDigest?: string;
  subjectDigest?: string;
  reportedOutcome?: string;
  decisionId?: string;
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

/**
 * Append one event to the journal.
 *
 * The two things an append needs to know — the next sequence number, and
 * whether this idempotency key has been used — used to be answered by reading
 * and parsing the entire journal, inside the lock, on every single append. That
 * is quadratic in the number of events, and the cost is paid while holding a
 * lock other processes wait 5 seconds for. A long-running project eventually
 * crosses the point where they always time out, and since the write guard fails
 * closed on a telemetry error, "the journal got big" turns into "no agent can
 * write to the repository". Both answers now come from a small sidecar index.
 */
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
      const index = await loadJournalIndex(input.eventPath);

      if (eventInput.idempotencyKey) {
        const existing = index.keyed[eventInput.idempotencyKey];
        if (existing) {
          persisted = existing;
          return;
        }
      }

      const event: OrchestrationEvent = {
        ...eventInput,
        version: ORCHESTRATION_EVENT_VERSION,
        id: randomUUID(),
        sequence: index.lastSequence + 1,
        timestamp: eventInput.timestamp ?? new Date().toISOString(),
      };
      const line = `${JSON.stringify(event)}\n`;
      await appendAndSync(input.eventPath, line);

      index.lastSequence = event.sequence;
      index.bytes += Buffer.byteLength(line, "utf8");
      if (eventInput.idempotencyKey) {
        index.keyed[eventInput.idempotencyKey] = event;
      }
      if (index.bytes > MAX_SEGMENT_BYTES) {
        await rotateJournal(input.eventPath, index);
      }
      await writeJournalIndex(input.eventPath, index);
      persisted = event;
    },
  });
  if (!persisted) throw new Error("Orchestration event was not persisted");
  return persisted;
}

/**
 * Sidecar index for the live journal segment.
 *
 * It is a cache, not a source of truth: it is validated against the segment's
 * real size on every load and rebuilt from the segment when it disagrees, so a
 * lost, stale, or hand-edited index costs one scan rather than a wrong sequence
 * number or a duplicated event.
 */
interface JournalIndex {
  version: number;
  /** How many times this journal has rotated. Rotated segments keep their number. */
  generation: number;
  /** Highest sequence issued, across all generations — sequences never restart. */
  lastSequence: number;
  /** Size of the live segment, used to detect an index that missed a write. */
  bytes: number;
  /** Events carrying an idempotency key, for the live segment only. */
  keyed: Record<string, OrchestrationEvent>;
}

const JOURNAL_INDEX_VERSION = 1;

function journalIndexPath(eventPath: string): string {
  return `${eventPath}.index.json`;
}

async function loadJournalIndex(eventPath: string): Promise<JournalIndex> {
  const liveBytes = await fileSize(eventPath);
  try {
    const value: unknown = JSON.parse(await readFile(journalIndexPath(eventPath), "utf8"));
    if (isJournalIndex(value) && value.bytes === liveBytes) {
      return value;
    }
  } catch {
    // Missing, unreadable, or stale — rebuilt below.
  }
  return rebuildJournalIndex(eventPath, liveBytes);
}

/**
 * Rebuild the index by scanning the live segment. Rotated segments are counted
 * for the sequence high-water mark only, so sequences stay monotonic across a
 * rotation without keeping every historical key in memory.
 */
async function rebuildJournalIndex(
  eventPath: string,
  liveBytes: number,
): Promise<JournalIndex> {
  const segments = await listRotatedSegments(eventPath);
  let lastSequence = 0;
  for (const segment of segments) {
    for (const event of await readSegment(segment.path)) {
      lastSequence = Math.max(lastSequence, event.sequence);
    }
  }

  const keyed: Record<string, OrchestrationEvent> = {};
  for (const event of await readSegment(eventPath)) {
    lastSequence = Math.max(lastSequence, event.sequence);
    if (event.idempotencyKey) keyed[event.idempotencyKey] = event;
  }

  return {
    version: JOURNAL_INDEX_VERSION,
    generation: (segments.at(-1)?.generation ?? 0) + 1,
    lastSequence,
    bytes: liveBytes,
    keyed,
  };
}

async function writeJournalIndex(eventPath: string, index: JournalIndex): Promise<void> {
  const path = journalIndexPath(eventPath);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(index)}\n`, "utf8");
  await rename(temporaryPath, path);
}

/**
 * Move the live segment aside and start an empty one.
 *
 * Idempotency keys are dropped with the segment. They are scoped to a single
 * invocation and rotation happens after megabytes of events, so a key that
 * survives long enough to be replayed across a rotation is not a case that
 * arises — and keeping every key forever is the unbounded growth being fixed.
 */
async function rotateJournal(eventPath: string, index: JournalIndex): Promise<void> {
  await rename(eventPath, rotatedSegmentPath(eventPath, index.generation));
  index.generation += 1;
  index.bytes = 0;
  index.keyed = {};
}

function rotatedSegmentPath(eventPath: string, generation: number): string {
  const suffix = extname(eventPath);
  return `${eventPath.slice(0, eventPath.length - suffix.length)}.${generation}${suffix}`;
}

/** Rotated segments for this journal, oldest first. */
async function listRotatedSegments(
  eventPath: string,
): Promise<{ generation: number; path: string }[]> {
  const directory = dirname(eventPath);
  const suffix = extname(eventPath);
  const base = basename(eventPath, suffix);
  const pattern = new RegExp(
    `^${escapeRegExp(base)}\\.(\\d+)${escapeRegExp(suffix)}$`,
    "u",
  );

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  return entries
    .map((name) => {
      const match = pattern.exec(name);
      return match
        ? { generation: Number(match[1]), path: join(directory, name) }
        : undefined;
    })
    .filter((value): value is { generation: number; path: string } => value !== undefined)
    .sort((a, b) => a.generation - b.generation);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return 0;
    throw error;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isJournalIndex(value: unknown): value is JournalIndex {
  return (
    isRecord(value) &&
    value.version === JOURNAL_INDEX_VERSION &&
    typeof value.generation === "number" &&
    typeof value.lastSequence === "number" &&
    typeof value.bytes === "number" &&
    isRecord(value.keyed)
  );
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

/**
 * Repair a journal whose last line was cut short by a crash.
 *
 * Reads only the tail. It used to read the whole file to look at the final
 * line — inside the lock, on every append — which is half of what made appends
 * quadratic.
 */
async function repairJournalTail(path: string): Promise<void> {
  const size = await fileSize(path);
  if (size === 0) return;

  // Read backwards in byte-sized windows until a newline turns up, so the
  // common case costs one small read instead of parsing the whole journal.
  // Offsets are tracked in BYTES throughout — a character offset would truncate
  // at the wrong place the moment an event contains a non-ASCII character.
  let windowBytes = Math.min(size, 64 * 1024);
  let lastNewlineByte = -1;
  let tail = "";

  while (true) {
    const start = size - windowBytes;
    const buffer = Buffer.alloc(windowBytes);
    const handle = await open(path, "r");
    try {
      await handle.read(buffer, 0, windowBytes, start);
    } finally {
      await handle.close();
    }

    if (buffer.at(-1) === 0x0a) return; // Already terminated: nothing to repair.

    const newlineInWindow = buffer.lastIndexOf(0x0a);
    if (newlineInWindow >= 0) {
      lastNewlineByte = start + newlineInWindow;
      tail = buffer.subarray(newlineInWindow + 1).toString("utf8");
      break;
    }
    if (start === 0) {
      // No newline anywhere: the file is a single unterminated line.
      lastNewlineByte = -1;
      tail = buffer.toString("utf8");
      break;
    }
    windowBytes = Math.min(size, windowBytes * 4);
  }

  try {
    const value: unknown = JSON.parse(tail);
    if (!isOrchestrationEvent(value)) throw new Error("invalid event tail");
    await appendAndSync(path, "\n");
  } catch {
    await truncate(path, lastNewlineByte + 1);
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

/**
 * Every event in the journal, oldest first, across rotated segments.
 *
 * Callers depend on seeing the whole history — replay hashes a prefix chain
 * over it, review dedup looks for an earlier verdict, metrics count from the
 * beginning — so rotation must be invisible here.
 */
export async function readOrchestrationEvents(
  eventPath: string,
): Promise<OrchestrationEvent[]> {
  const segments = await listRotatedSegments(eventPath);
  if (segments.length === 0) return readSegment(eventPath);

  const events: OrchestrationEvent[] = [];
  for (const segment of segments) {
    events.push(...(await readSegment(segment.path)));
  }
  events.push(...(await readSegment(eventPath)));
  return events;
}

async function readSegment(
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
  return (ORCHESTRATION_EVENT_TYPES as readonly unknown[]).includes(value);
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
