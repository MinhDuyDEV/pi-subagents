import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { withFileLock } from "./file-lock.js";

const EVIDENCE_STORE_VERSION = 1;

export type EvidenceReceiptKind =
  | "file"
  | "test"
  | "command-output"
  | "session"
  | "diff";

export interface EvidenceReceipt {
  version: 1;
  id: string;
  taskId: string;
  producerTaskId: string;
  kind: EvidenceReceiptKind;
  description: string;
  claim?: string;
  artifactPath: string;
  sha256: string;
  observedAt: string;
  exitCode?: number;
  /** Only runtime-observation receipts may satisfy the proof gate. */
  authority?: "manual-artifact" | "runtime-observation";
  command?: string;
  commandDigest?: string;
  cwd?: string;
  toolCallId?: string;
  sessionDigest?: string;
}

interface EvidenceDocument {
  version: 1;
  receipts: EvidenceReceipt[];
}

export async function recordEvidenceReceipt(input: {
  storeDirectory: string;
  projectDirectory: string;
  taskId: string;
  producerTaskId: string;
  kind: EvidenceReceiptKind;
  description: string;
  claim?: string;
  artifactPath: string;
  exitCode?: number;
  now?: Date;
}): Promise<EvidenceReceipt> {
  const projectRoot = realpathSync(resolve(input.projectDirectory));
  const absolutePath = isAbsolute(input.artifactPath)
    ? resolve(input.artifactPath)
    : resolve(projectRoot, input.artifactPath);
  const projectRelative = relative(projectRoot, absolutePath);
  if (
    projectRelative === ".." ||
    projectRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(projectRelative)
  ) {
    throw new Error(`Evidence artifact is outside the project: ${input.artifactPath}`);
  }
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`Evidence artifact does not exist as a file: ${input.artifactPath}`);
  }
  const realPath = realpathSync(absolutePath);
  const realRelative = relative(projectRoot, realPath);
  if (
    realRelative === ".." ||
    realRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(realRelative)
  ) {
    throw new Error(`Evidence artifact resolves outside the project: ${input.artifactPath}`);
  }
  const receipt: EvidenceReceipt = {
    version: EVIDENCE_STORE_VERSION,
    id: randomUUID(),
    taskId: input.taskId,
    producerTaskId: input.producerTaskId,
    kind: input.kind,
    description: input.description,
    ...(input.claim ? { claim: input.claim } : {}),
    artifactPath: projectRelative.replaceAll("\\", "/"),
    sha256: `sha256:${createHash("sha256").update(readFileSync(absolutePath)).digest("hex")}`,
    observedAt: (input.now ?? new Date()).toISOString(),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    authority: "manual-artifact",
  };
  const path = evidencePath(input.storeDirectory, input.taskId);
  await withFileLock({
    lockPath: `${path}.lock`,
    operation: async () => {
      const document = await readEvidenceDocument(path);
      document.receipts.push(receipt);
      await writeEvidenceDocument(path, document);
    },
  });
  return receipt;
}

/**
 * Capture shell observations from the runtime-owned session transcript.  The
 * child cannot choose the receipt fields: command, cwd, exit status, output,
 * timestamp and transcript digest are taken from matched toolCall/toolResult
 * entries and written as one immutable canonical artifact.
 */
export async function captureSessionCommandReceipts(input: {
  storeDirectory: string;
  projectDirectory: string;
  taskId: string;
  producerTaskId: string;
  sessionPath: string;
  notBefore?: string;
}): Promise<EvidenceReceipt[]> {
  const sessionBytes = await readFile(input.sessionPath);
  const sessionDigest = taggedDigest(sessionBytes);
  const calls = new Map<
    string,
    { name: string; command: string; cwd: string; callTimestamp?: string }
  >();
  const observations: Array<{
    toolCallId: string;
    command: string;
    cwd: string;
    output: string;
    exitCode: number;
    observedAt: string;
  }> = [];
  const notBefore = input.notBefore ? Date.parse(input.notBefore) : undefined;

  for (const line of sessionBytes.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    const message = isRecord(entry.message) ? entry.message : entry;
    const timestamp = stringField(entry.timestamp) ?? stringField(message.timestamp);
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        const name = stringField(block.name) ?? "";
        if (!isShellToolName(name)) continue;
        const args = isRecord(block.arguments)
          ? block.arguments
          : isRecord(block.input)
            ? block.input
            : undefined;
        const command =
          stringField(args?.command) ?? stringField(args?.cmd) ?? "";
        const id = stringField(block.id);
        if (!id || !command.trim()) continue;
        calls.set(id, {
          name,
          command,
          cwd: stringField(args?.cwd) ?? input.projectDirectory,
          ...(timestamp ? { callTimestamp: timestamp } : {}),
        });
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const toolCallId = stringField(message.toolCallId);
    if (!toolCallId) continue;
    const call = calls.get(toolCallId);
    if (!call) continue;
    const observedAt = timestamp ?? call.callTimestamp ?? new Date().toISOString();
    if (
      notBefore !== undefined &&
      Number.isFinite(notBefore) &&
      Date.parse(observedAt) < notBefore
    ) {
      continue;
    }
    const details = isRecord(message.details) ? message.details : undefined;
    const explicitExitCode = numberField(details?.exitCode) ?? numberField(details?.exit_code);
    const exitCode = explicitExitCode ?? (message.isError === true ? 1 : 0);
    observations.push({
      toolCallId,
      command: call.command,
      cwd: call.cwd,
      output: contentText(message.content),
      exitCode,
      observedAt,
    });
    calls.delete(toolCallId);
  }

  const outputDirectory = resolve(
    input.storeDirectory,
    "runtime",
    safeKey(input.taskId),
  );
  await mkdir(outputDirectory, { recursive: true });
  const receipts: EvidenceReceipt[] = [];
  for (const observation of observations) {
    const observationKey = createHash("sha256")
      .update(sessionDigest)
      .update("\0")
      .update(observation.toolCallId)
      .digest("hex");
    const artifactPath = resolve(outputDirectory, `${observationKey}.json`);
    const artifact = {
      version: 1,
      taskId: input.taskId,
      producerTaskId: input.producerTaskId,
      sessionDigest,
      toolCallId: observation.toolCallId,
      command: observation.command,
      commandDigest: taggedDigest(observation.command),
      cwd: observation.cwd,
      exitCode: observation.exitCode,
      observedAt: observation.observedAt,
      output: observation.output,
    };
    await writeCanonicalArtifact(artifactPath, artifact);
    const artifactRelative = projectRelativeFile(
      input.projectDirectory,
      artifactPath,
    );
    const receipt: EvidenceReceipt = {
      version: EVIDENCE_STORE_VERSION,
      id: `observation-${observationKey}`,
      taskId: input.taskId,
      producerTaskId: input.producerTaskId,
      kind: looksLikeTestCommand(observation.command) ? "test" : "command-output",
      description: `Runtime-observed command: ${observation.command}`,
      artifactPath: artifactRelative,
      sha256: taggedDigest(await readFile(artifactPath)),
      observedAt: observation.observedAt,
      exitCode: observation.exitCode,
      authority: "runtime-observation",
      command: observation.command,
      commandDigest: taggedDigest(observation.command),
      cwd: observation.cwd,
      toolCallId: observation.toolCallId,
      sessionDigest,
    };
    receipts.push(receipt);
  }

  if (receipts.length > 0) {
    const path = evidencePath(input.storeDirectory, input.taskId);
    await withFileLock({
      lockPath: `${path}.lock`,
      operation: async () => {
        const document = await readEvidenceDocument(path);
        const byId = new Map(document.receipts.map((receipt) => [receipt.id, receipt]));
        for (const receipt of receipts) byId.set(receipt.id, receipt);
        document.receipts = [...byId.values()];
        await writeEvidenceDocument(path, document);
      },
    });
  }
  return receipts;
}

export async function listEvidenceReceipts(
  storeDirectory: string,
  taskId: string,
): Promise<EvidenceReceipt[]> {
  return (await readEvidenceDocument(evidencePath(storeDirectory, taskId))).receipts.map(
    (receipt) => ({ ...receipt }),
  );
}

export function verifyEvidenceReceipt(
  receipt: EvidenceReceipt,
  projectDirectory: string,
): boolean {
  const projectRoot = realpathSync(resolve(projectDirectory));
  const path = resolve(projectRoot, receipt.artifactPath);
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return false;
    const realPath = realpathSync(path);
    const realRelative = relative(projectRoot, realPath);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(realRelative)
    ) {
      return false;
    }
    const digest = `sha256:${createHash("sha256").update(readFileSync(realPath)).digest("hex")}`;
    return digest === receipt.sha256;
  } catch {
    return false;
  }
}

function evidencePath(storeDirectory: string, taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(taskId)) {
    throw new Error(`Invalid evidence task key: ${taskId}`);
  }
  return resolve(storeDirectory, `${taskId}.json`);
}

function safeKey(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error(`Invalid evidence task key: ${value}`);
  }
  return value;
}

function projectRelativeFile(projectDirectory: string, filePath: string): string {
  const projectRoot = realpathSync(resolve(projectDirectory));
  const realPath = realpathSync(filePath);
  const relativePath = relative(projectRoot, realPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Runtime evidence artifact is outside the project: ${filePath}`);
  }
  return relativePath.replaceAll("\\", "/");
}

async function writeCanonicalArtifact(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function taggedDigest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isShellToolName(name: string): boolean {
  return ["bash", "shell", "exec_command"].includes(name);
}

function looksLikeTestCommand(command: string): boolean {
  return /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:^|\s)(?:pytest|vitest|jest|cargo\s+test|go\s+test)\b/u.test(
    command,
  );
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((item) => {
      if (typeof item === "string") return [item];
      if (isRecord(item) && typeof item.text === "string") return [item.text];
      return [];
    })
    .join("\n");
}

async function readEvidenceDocument(path: string): Promise<EvidenceDocument> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value) || value.version !== EVIDENCE_STORE_VERSION || !Array.isArray(value.receipts)) {
      throw new Error(`Invalid evidence receipt store: ${path}`);
    }
    return value as unknown as EvidenceDocument;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { version: EVIDENCE_STORE_VERSION, receipts: [] };
    }
    throw error;
  }
}

async function writeEvidenceDocument(path: string, document: EvidenceDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
