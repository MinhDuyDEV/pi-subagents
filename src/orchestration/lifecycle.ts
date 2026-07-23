import { existsSync } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SESSION_SCAN_LIMIT = 1_000;
const SESSION_HEADER_BYTE_LIMIT = 64 * 1024;

export interface ResolveTaskSessionReferenceInput {
  projectDirectory: string;
  taskId: string;
  sessionName: string;
  recordedSessionReference?: string;
  additionalSessionRoots?: readonly string[];
}

export interface BackgroundReceiptInput {
  taskId: string;
  sessionName: string;
  sessionReference?: string;
}

export async function resolveTaskSessionReference(
  input: ResolveTaskSessionReferenceInput,
): Promise<string | undefined> {
  if (
    input.recordedSessionReference &&
    existsSync(input.recordedSessionReference)
  ) {
    return input.recordedSessionReference;
  }

  const roots = [
    join(input.projectDirectory, ".pi", "artifacts", "tasks", "sessions"),
    join(input.projectDirectory, ".pi", "artifacts", "sessions"),
    ...(input.additionalSessionRoots ?? []),
  ];

  let scannedFiles = 0;
  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }

    const taskDirectorySession = await newestJsonlInTaskDirectory(
      root,
      input.taskId,
    );
    if (taskDirectorySession) {
      return taskDirectorySession;
    }

    const pendingDirectories = [root];
    while (pendingDirectories.length > 0 && scannedFiles < SESSION_SCAN_LIMIT) {
      const directory = pendingDirectories.shift();
      if (!directory) {
        break;
      }

      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          pendingDirectories.push(path);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          continue;
        }

        scannedFiles += 1;
        if (
          entry.name === `${input.sessionName}.jsonl` ||
          (await sessionFileMatches(path, input.sessionName, input.taskId))
        ) {
          return path;
        }
        if (scannedFiles >= SESSION_SCAN_LIMIT) {
          break;
        }
      }
    }
  }

  return undefined;
}

export function renderBackgroundReceipt(input: BackgroundReceiptInput): string {
  const lines = [`Task ID: ${input.taskId}`];
  if (input.sessionReference && existsSync(input.sessionReference)) {
    lines.push(`Session file: ${input.sessionReference}`);
  } else {
    lines.push(`Session reference: ${input.sessionName}`);
  }
  return lines.join("\n");
}

export async function readFinalAssistantText(
  sessionPath: string,
  maxCharacters = 50_000,
): Promise<string | undefined> {
  const content = await readFile(sessionPath, "utf8");
  let finalText: string | undefined;

  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || value.type !== "message" || !isRecord(value.message)) {
      continue;
    }
    const message = value.message;
    if (message.role !== "assistant") {
      continue;
    }
    const text = assistantText(message.content);
    if (text) {
      finalText = text;
    }
  }

  if (!finalText) {
    return undefined;
  }
  return finalText.length <= maxCharacters
    ? finalText
    : finalText.slice(finalText.length - maxCharacters);
}

async function newestJsonlInTaskDirectory(
  sessionRoot: string,
  taskId: string,
): Promise<string | undefined> {
  if (!/^[A-Za-z0-9_-]+$/u.test(taskId)) {
    return undefined;
  }
  const taskDirectory = join(sessionRoot, taskId);
  try {
    const entries = await readdir(taskDirectory, { withFileTypes: true });
    const newest = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .sort((left, right) => right.name.localeCompare(left.name))[0];
    return newest ? join(taskDirectory, newest.name) : undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function sessionFileMatches(
  sessionPath: string,
  sessionName: string,
  taskId: string,
): Promise<boolean> {
  const file = await open(sessionPath, "r");
  let header: string;
  try {
    const buffer = Buffer.alloc(SESSION_HEADER_BYTE_LIMIT);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    header = buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }

  return (
    header.includes(`"name":"${sessionName}"`) ||
    header.includes(`"taskId":"${taskId}"`) ||
    header.includes(`"task_id":"${taskId}"`)
  );
}

function assistantText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .flatMap((part): string[] => {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        return [part.text];
      }
      return [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
