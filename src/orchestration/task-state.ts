import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { registryLockPath } from "../conversation.js";
import { withFileLock } from "./file-lock.js";
import { resolveTaskSessionReference } from "./lifecycle.js";

export async function seedResumeRegistry(
  projectDirectory: string,
  taskId: string,
): Promise<void> {
  const piDirectory = join(projectDirectory, ".pi");
  const historyPath = join(piDirectory, "task-session-history.json");
  const registryPath = join(piDirectory, "task-registry.json");
  const history = await readJsonArray(historyPath);
  const historyEntry = history.find(
    (entry) => stringValue(entry.id) === taskId || stringValue(entry.taskId) === taskId,
  );
  const sessionName = stringValue(historyEntry?.sessionName) ?? `task-${taskId}`;
  const sessionReference = await resolveTaskSessionReference({
    projectDirectory,
    taskId,
    sessionName,
    recordedSessionReference: stringValue(historyEntry?.sessionRef),
  });
  if (!sessionReference) {
    return;
  }

  const entry = {
    ...historyEntry,
    id: taskId,
    taskId,
    sessionName,
    sessionRef: sessionReference,
    phase: stringValue(historyEntry?.phase) ?? "completed",
    status: stringValue(historyEntry?.status) ?? "completed",
  };

  // Each file is re-read inside its own lock rather than reusing the read from
  // above: `resolveTaskSessionReference` touches the filesystem, so anything
  // read before it is already a stale observation by the time we write. The
  // locks are taken one at a time, never nested, so two callers cannot deadlock
  // by taking them in opposite orders.
  await withRegistryLock(historyPath, async () => {
    const current = await readJsonArray(historyPath);
    await writeJsonAtomic(historyPath, [...withoutTask(current, taskId), entry]);
  });
  await withRegistryLock(registryPath, async () => {
    const current = await readJsonArray(registryPath);
    await writeJsonAtomic(registryPath, [...withoutTask(current, taskId), entry]);
  });
}

export async function persistTaskHistoryReference(
  projectDirectory: string,
  taskId: string,
  sessionName: string,
  sessionReference: string,
): Promise<void> {
  const historyPath = join(
    projectDirectory,
    ".pi",
    "task-session-history.json",
  );
  await withRegistryLock(historyPath, async () => {
    const history = await readJsonArray(historyPath);
    const current = history.find(
      (entry) => stringValue(entry.id) === taskId || stringValue(entry.taskId) === taskId,
    );
    await writeJsonAtomic(historyPath, [
      ...withoutTask(history, taskId),
      {
        ...current,
        id: taskId,
        taskId,
        sessionName: stringValue(current?.sessionName) ?? sessionName,
        sessionRef: sessionReference,
        status: stringValue(current?.status) ?? "completed",
      },
    ]);
  });
}

/**
 * Guard a registry file with the lock `conversation.ts` uses for the same path.
 *
 * These two files have two writers — this module and `conversation.ts` — and
 * before this they shared no lock at all, so an async atomic rename here could
 * land on top of a synchronous read-modify-write there and drop it.
 */
function withRegistryLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  return withFileLock({ lockPath: registryLockPath(file), operation });
}

function withoutTask(
  records: readonly Record<string, unknown>[],
  taskId: string,
): Array<Record<string, unknown>> {
  return records.filter(
    (entry) => stringValue(entry.id) !== taskId && stringValue(entry.taskId) !== taskId,
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

async function writeJsonAtomic(
  path: string,
  value: readonly Record<string, unknown>[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
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
