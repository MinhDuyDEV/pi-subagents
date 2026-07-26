/**
 * The task registry and session history — the records `restoreActiveBackgroundTasks`
 * reads to find panes, processes, and worktrees left behind by a previous run.
 *
 * Both files are also written by `orchestration/task-state.ts`. Neither module
 * used to lock, and this one wrote in place with a bare `writeFileSync`, so a
 * write interrupted at the wrong moment truncated the file and a concurrent
 * read-modify-write silently dropped whichever update lost the race. A parse
 * failure then returned an empty array, which is indistinguishable from "no
 * tasks" — so restore found nothing to restore and every pane, agent process,
 * and worktree from the previous session was orphaned with nothing reaped and
 * nothing reported.
 *
 * Writes are now atomic (temp + rename) and every read-modify-write runs under
 * the same lock `task-state.ts` takes. A file that cannot be parsed is
 * quarantined and reported rather than silently read as empty.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { withFileLockSync } from "./orchestration/file-lock-sync.js";
import { isTerminalHandle, type TerminalHandle } from "./subagent/terminalBackend.js";
import type { RegistryEntry, TaskSessionHistoryEntry } from "./types.js";

const ARTIFACTS_DIR = "artifacts";
const TASK_SESSIONS_REGISTRY = "task-sessions.json";
const TASK_REGISTRY = "task-registry.json";
const TASK_SESSION_HISTORY = "task-session-history.json";

export interface TaskSessionRegistryEntry {
  task_id: string;
  updated_at: string;
}

/**
 * Reporter for a registry file that had to be quarantined. Wired to the Pi
 * event bus by the extension; losing the registry means orphaned panes and
 * processes, which an operator has to know about to clean up.
 */
export type RegistryQuarantineReporter = (info: {
  file: string;
  quarantinePath: string;
  reason: string;
}) => void;

let reportQuarantine: RegistryQuarantineReporter = () => undefined;

export function setRegistryQuarantineReporter(
  reporter: RegistryQuarantineReporter,
): void {
  reportQuarantine = reporter;
}

/** The lock guarding a registry file. Must match `task-state.ts`. */
export function registryLockPath(file: string): string {
  return `${file}.lock`;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function readJsonFile<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    quarantineRegistryFile(file, `unparseable JSON: ${(error as Error).message}`);
    return fallback;
  }
}

/**
 * Move a corrupt registry aside and say so. Returning the fallback keeps the
 * extension alive, but silence here is what turned a truncated file into
 * orphaned processes nobody knew to clean up.
 */
function quarantineRegistryFile(file: string, reason: string): void {
  const quarantinePath = `${file}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    renameSync(file, quarantinePath);
  } catch {
    // If it cannot be moved we still report; the next write replaces it.
  }
  try {
    reportQuarantine({ file, quarantinePath, reason });
  } catch {
    // A reporter must never be able to break the registry.
  }
}

function writeJsonFile(file: string, value: unknown): void {
  ensureDir(dirname(file));
  // Temp + rename: a reader either sees the whole previous file or the whole
  // new one. A bare `writeFileSync` truncates first, so a reader arriving mid
  // write — or a crash — saw a partial file that parsed as nothing.
  const temporaryPath = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(temporaryPath, file);
}

/** Read, mutate, and write a registry file as one atomic, locked operation. */
function updateJsonFile<T>(
  file: string,
  fallback: T,
  mutate: (current: T) => T,
): void {
  ensureDir(dirname(file));
  withFileLockSync({
    lockPath: registryLockPath(file),
    operation: () => {
      writeJsonFile(file, mutate(readJsonFile<T>(file, fallback)));
    },
  });
}

export function normalizeConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
  return normalized.length > 0 ? normalized : undefined;
}

function getArtifactDir(piDir: string): string {
  return join(piDir, ARTIFACTS_DIR);
}

function getTaskSessionsRegistryPath(piDir: string): string {
  return join(getArtifactDir(piDir), TASK_SESSIONS_REGISTRY);
}

export function readTaskSessionsRegistry(
  piDir: string,
): Record<string, TaskSessionRegistryEntry> {
  const raw = readJsonFile<Record<string, unknown>>(
    getTaskSessionsRegistryPath(piDir),
    {},
  );
  const out: Record<string, TaskSessionRegistryEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (typeof record.task_id !== "string") continue;
    out[key] = {
      task_id: record.task_id,
      updated_at:
        typeof record.updated_at === "string"
          ? record.updated_at
          : new Date(0).toISOString(),
    };
  }
  return out;
}

export function writeTaskSessionsRegistry(
  piDir: string,
  registry: Record<string, TaskSessionRegistryEntry>,
): void {
  const file = getTaskSessionsRegistryPath(piDir);
  ensureDir(dirname(file));
  withFileLockSync({
    lockPath: registryLockPath(file),
    operation: () => writeJsonFile(file, registry),
  });
}

function getRegistryPath(piDir: string): string {
  return join(piDir, TASK_REGISTRY);
}

export function migrateRegistryEntry(entry: Record<string, unknown> | RegistryEntry): RegistryEntry {
  const migrated: Record<string, unknown> = { ...(entry as unknown as Record<string, unknown>) };
  const legacyPaneId = migrated.paneId;
  const existingHandle = migrated.handle;

  if (!isTerminalHandle(existingHandle)) {
    if (typeof legacyPaneId === "string" && legacyPaneId.length > 0) {
      migrated.handle = { backend: "tmux", resourceId: legacyPaneId } satisfies TerminalHandle;
    } else {
      delete migrated.handle;
    }
  }

  if (isTerminalHandle(migrated.handle)) {
    migrated.backend = migrated.handle.backend;
  }
  delete migrated.paneId;
  return migrated as unknown as RegistryEntry;
}

export function readRegistry(piDir: string): RegistryEntry[] {
  const parsed = readJsonFile<unknown>(getRegistryPath(piDir), []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => migrateRegistryEntry(entry));
}

export function writeRegistry(piDir: string, entries: RegistryEntry[]): void {
  const file = getRegistryPath(piDir);
  ensureDir(dirname(file));
  withFileLockSync({
    lockPath: registryLockPath(file),
    operation: () =>
      writeJsonFile(file, entries.map((entry) => migrateRegistryEntry(entry))),
  });
}

function getTaskSessionHistoryPath(piDir: string): string {
  return join(piDir, TASK_SESSION_HISTORY);
}

export function readTaskSessionHistory(piDir: string): TaskSessionHistoryEntry[] {
  const parsed = readJsonFile<unknown>(getTaskSessionHistoryPath(piDir), []);
  return Array.isArray(parsed) ? (parsed as TaskSessionHistoryEntry[]) : [];
}

/**
 * Merge one entry into the history.
 *
 * The read and the write are one locked operation. Interleaved as separate
 * steps, two concurrent upserts each read the same array and the second write
 * erased the first entry — the update was lost with no error anywhere.
 */
export function upsertTaskSessionHistory(
  piDir: string,
  entry: TaskSessionHistoryEntry,
): void {
  updateJsonFile<unknown>(getTaskSessionHistoryPath(piDir), [], (current) => {
    const entries = Array.isArray(current)
      ? (current as TaskSessionHistoryEntry[])
      : [];
    const idx = entries.findIndex((existing) => existing.id === entry.id);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], ...entry };
    } else {
      entries.push(entry);
    }
    return entries;
  });
}

export function findTaskSessionHistory(
  piDir: string,
  taskId: string,
): TaskSessionHistoryEntry | undefined {
  return readTaskSessionHistory(piDir).find((entry) => entry.id === taskId);
}


function sessionFileMatches(file: string, sessionName: string): boolean {
  try {
    const content = readFileSync(file, "utf-8");
    return (
      content.includes(`\"name\":\"${sessionName}\"`) ||
      content.includes(`\"name\": \"${sessionName}\"`)
    );
  } catch {
    return false;
  }
}

export function findJsonlSessionByName(
  piDir: string,
  idOrSessionName: string,
  agentType?: string,
): TaskSessionHistoryEntry | null {
  const sessionsRoot = join(getArtifactDir(piDir), "sessions");
  if (!existsSync(sessionsRoot)) return null;
  const history = readTaskSessionHistory(piDir);

  for (const dirent of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const taskId = dirent.name;
    const taskDir = join(sessionsRoot, taskId);
    const historyEntry = history.find((entry) => entry.id === taskId);
    if (!historyEntry) continue;
    const sessionName = historyEntry.sessionName;
    if (taskId !== idOrSessionName && sessionName !== idOrSessionName) continue;
    if (agentType && historyEntry.agentType !== agentType) continue;

    const sessionRef = readdirSync(taskDir)
      .filter((entry) => entry.endsWith(".jsonl"))
      .map((entry) => join(taskDir, entry))
      .find((file) => sessionFileMatches(file, sessionName));
    if (!sessionRef) continue;

    return {
      ...historyEntry,
      sessionRef,
      dir: taskDir,
    };
  }
  return null;
}
