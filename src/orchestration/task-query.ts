import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readFinalAssistantText,
  resolveTaskSessionReference,
} from "./lifecycle.js";

export interface TaskSnapshot {
  taskId: string;
  status: string;
  description?: string;
  sessionName: string;
  sessionReference?: string;
}

export async function getTaskSnapshot(
  projectDirectory: string,
  taskId: string,
): Promise<TaskSnapshot> {
  const piDirectory = join(projectDirectory, ".pi");
  const registry = await readJsonArray(join(piDirectory, "task-registry.json"));
  const history = await readJsonArray(
    join(piDirectory, "task-session-history.json"),
  );
  const registryEntry = findTaskRecord(registry, taskId);
  const historyEntry = findTaskRecord(history, taskId);
  const record = registryEntry ?? historyEntry;
  const sessionName = stringValue(record?.sessionName) ?? `task-${taskId}`;
  const description =
    stringValue(registryEntry?.description) ??
    stringValue(historyEntry?.description);
  const sessionReference = await resolveTaskSessionReference({
    projectDirectory,
    taskId,
    sessionName,
    recordedSessionReference: stringValue(record?.sessionRef),
  });
  return {
    taskId,
    status:
      stringValue(registryEntry?.phase) ??
      stringValue(registryEntry?.status) ??
      stringValue(historyEntry?.status) ??
      "unknown",
    ...(description ? { description } : {}),
    sessionName,
    ...(sessionReference ? { sessionReference } : {}),
  };
}

export async function getFinalTaskResult(
  snapshot: TaskSnapshot,
): Promise<string | undefined> {
  return snapshot.sessionReference
    ? readFinalAssistantText(snapshot.sessionReference)
    : undefined;
}

function findTaskRecord(
  records: readonly Record<string, unknown>[],
  taskId: string,
): Record<string, unknown> | undefined {
  return records.find(
    (record) =>
      stringValue(record.id) === taskId || stringValue(record.taskId) === taskId,
  );
}

async function readJsonArray(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(value) ? value.filter(isRecord) : [];
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
