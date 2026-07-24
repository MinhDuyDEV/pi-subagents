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
