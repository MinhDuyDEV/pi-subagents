import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { taggedDigest, type TaggedSha256V1 } from "./learning-contract.js";
import { getOrchestrationPaths } from "./orchestration/paths.js";
import { listDurableRuns, type DurableTaskRun } from "./orchestration/run-store.js";
import {
  ORCHESTRATION_EVENT_VERSION,
  readOrchestrationEvents,
  type OrchestrationEvent,
  type OrchestrationEventType,
} from "./orchestration/telemetry.js";

export {
  ORCHESTRATION_EVENT_VERSION,
  readOrchestrationEvents,
  type OrchestrationEvent,
  type OrchestrationEventType,
};

export interface OrchestrationReplayCursorV1 {
  version: 1;
  producer: "pi-subagents";
  streamId: "orchestration-events";
  streamGeneration: TaggedSha256V1;
  sequence: number;
  eventId: string;
  prefixHash: TaggedSha256V1;
  payloadDigest: TaggedSha256V1;
}

export interface OrchestrationReplayPort {
  replay(
    after?: OrchestrationReplayCursorV1,
    limit?: number,
  ): Promise<{
    events: OrchestrationEvent[];
    next?: OrchestrationReplayCursorV1;
  }>;
}

export interface TaskProvenanceEntryV1 {
  version: 1;
  producer: "pi-subagents";
  taskId?: string;
  invocationId: string;
  agentType?: string;
  description?: string;
  executionPhase: DurableTaskRun["executionPhase"];
  reportedOutcome: DurableTaskRun["reportedOutcome"];
  verificationPhase: DurableTaskRun["verificationPhase"];
  reviewPhase: DurableTaskRun["reviewPhase"];
  startedAt: string;
  updatedAt: string;
  resultDigest?: TaggedSha256V1;
}

export interface TaskProvenanceQuery {
  projectDirectory: string;
  limit?: number;
}

const MAX_TASK_PROVENANCE_ENTRIES = 200;
const MAX_TASK_DESCRIPTION_LENGTH = 1_000;
const MAX_TASK_IDENTITY_LENGTH = 256;

function boundedText(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

async function belongsToProject(run: DurableTaskRun, canonicalProjectDirectory: string): Promise<boolean> {
  try {
    return await realpath(run.projectDirectory) === canonicalProjectDirectory;
  } catch {
    return false;
  }
}

/**
 * Returns a deliberately small, path-free view of durable task history for
 * recall consumers. Transcript references, claims, proof payloads, worktree
 * paths, and verification issue text stay behind the orchestration boundary.
 */
export async function listTaskProvenance(
  query: TaskProvenanceQuery,
): Promise<TaskProvenanceEntryV1[]> {
  const limit = query.limit ?? MAX_TASK_PROVENANCE_ENTRIES;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASK_PROVENANCE_ENTRIES) {
    throw new Error(`Task provenance limit must be within bounds 1..${MAX_TASK_PROVENANCE_ENTRIES}`);
  }
  const canonicalProjectDirectory = await realpath(query.projectDirectory);
  const runs = await listDurableRuns(getOrchestrationPaths(canonicalProjectDirectory).runStore);
  const owned: DurableTaskRun[] = [];
  for (const run of runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    if (await belongsToProject(run, canonicalProjectDirectory)) owned.push(run);
    if (owned.length === limit) break;
  }

  return owned.map((run) => {
    const taskId = boundedText(run.taskId, MAX_TASK_IDENTITY_LENGTH);
    const agentType = boundedText(run.agentType, MAX_TASK_IDENTITY_LENGTH);
    const description = boundedText(run.description, MAX_TASK_DESCRIPTION_LENGTH);
    return {
      version: 1,
      producer: "pi-subagents",
      ...(taskId ? { taskId } : {}),
      invocationId: boundedText(run.invocationId, MAX_TASK_IDENTITY_LENGTH) ?? "unknown",
      ...(agentType ? { agentType } : {}),
      ...(description ? { description } : {}),
      executionPhase: run.executionPhase,
      reportedOutcome: run.reportedOutcome,
      verificationPhase: run.verificationPhase,
      reviewPhase: run.reviewPhase,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      ...(run.resultDigest ? { resultDigest: run.resultDigest } : {}),
    };
  });
}

interface CursorEvent {
  event: OrchestrationEvent;
  cursor: OrchestrationReplayCursorV1;
}

function eventSequence(event: OrchestrationEvent, index: number): number {
  const sequence = Number.isInteger(event.sequence) ? event.sequence : index + 1;
  if (sequence < 1) throw new Error(`Invalid orchestration sequence for ${event.id}`);
  return sequence;
}

function cursorEvents(events: readonly OrchestrationEvent[]): CursorEvent[] {
  const generation = taggedDigest({
    producer: "pi-subagents",
    streamId: "orchestration-events",
    firstEventId: events[0]?.id ?? "empty",
  });
  let prefixHash = taggedDigest({
    producer: "pi-subagents",
    streamId: "orchestration-events",
    generation,
  });
  let previousSequence = 0;
  return events.map((event, index) => {
    const sequence = eventSequence(event, index);
    if (sequence <= previousSequence) {
      throw new Error(`Orchestration sequence rewind at ${event.id}`);
    }
    previousSequence = sequence;
    const payloadDigest = taggedDigest(event);
    prefixHash = taggedDigest({ prefixHash, payloadDigest, eventId: event.id, sequence });
    return {
      event,
      cursor: {
        version: 1,
        producer: "pi-subagents",
        streamId: "orchestration-events",
        streamGeneration: generation,
        sequence,
        eventId: event.id,
        prefixHash,
        payloadDigest,
      },
    };
  });
}

function validateCursor(
  entries: readonly CursorEvent[],
  cursor: OrchestrationReplayCursorV1,
): number {
  if (
    cursor.version !== 1 ||
    cursor.producer !== "pi-subagents" ||
    cursor.streamId !== "orchestration-events"
  ) {
    throw new Error("Orchestration replay cursor belongs to a different producer stream");
  }
  const generation = entries[0]?.cursor.streamGeneration
    ?? taggedDigest({
      producer: "pi-subagents",
      streamId: "orchestration-events",
      firstEventId: "empty",
    });
  if (cursor.streamGeneration !== generation) {
    throw new Error("Orchestration journal generation changed");
  }
  const index = entries.findIndex((entry) => entry.cursor.sequence === cursor.sequence);
  if (index < 0) throw new Error("Orchestration journal was truncated or rewound");
  const actual = entries[index]!.cursor;
  if (
    actual.eventId !== cursor.eventId ||
    actual.prefixHash !== cursor.prefixHash ||
    actual.payloadDigest !== cursor.payloadDigest
  ) {
    throw new Error("Orchestration replay cursor prefix or payload mismatch");
  }
  return index + 1;
}

export function createOrchestrationReplayPort(input: {
  projectDirectory: string;
}): OrchestrationReplayPort {
  const eventPath = resolve(
    input.projectDirectory,
    ".pi",
    "artifacts",
    "tasks",
    "orchestration",
    "events.jsonl",
  );
  return {
    async replay(after, limit = 64) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("Orchestration replay limit is out of bounds");
      }
      const entries = cursorEvents(await readOrchestrationEvents(eventPath));
      const start = after ? validateCursor(entries, after) : 0;
      const batch = entries.slice(start, start + limit);
      return {
        events: batch.map((entry) => entry.event),
        ...(batch.length > 0 ? { next: batch.at(-1)!.cursor } : {}),
      };
    },
  };
}
