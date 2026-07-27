import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseLearningClaims, type LearningClaimV1 } from "../learning-contract.js";
import { withFileLock } from "./file-lock.js";

const CONTEXT_PACK_VERSION = 1;
const SAFE_CONTEXT_KEY = /^[A-Za-z0-9._-]+$/u;
const REDACTED = "[REDACTED]";

export type ContextProvenance =
  | "user"
  | "repository"
  | "delegated"
  | "external"
  /** Non-authoritative facts imported from the learning store. */
  | "learning";
export type ContextAuthorization =
  | "read-only"
  | "write-approved"
  | "sensitive-approved";

export interface ContextFact {
  statement: string;
  source: ContextProvenance;
  reference?: string;
}

export interface ContextDecision {
  statement: string;
  rationale?: string;
  /** Observable evidence that would justify revisiting this locked decision. */
  unlockCondition?: string;
}

export interface ContextEvidence {
  description: string;
  reference: string;
  recordedAt?: string;
  claim?: string;
  receiptId?: string;
  sha256?: string;
  source?: "declared" | "runtime-receipt" | "runtime-session";
  receiptKind?: "file" | "test" | "command-output" | "session" | "diff";
  exitCode?: number;
}

export interface ContextReferenceInput {
  path: string;
}

export interface ContextReference {
  path: string;
  digest: string;
}

export type ContextDisclosure = "open" | "blind-first";

export interface ContextPackInput {
  goal: string;
  authorization: ContextAuthorization;
  knownFacts?: readonly ContextFact[];
  unknowns?: readonly string[];
  decisions?: readonly ContextDecision[];
  references?: readonly ContextReferenceInput[];
  evidence?: readonly ContextEvidence[];
  claims?: readonly string[];
  learningClaims?: readonly LearningClaimV1[];
  nextStep: string;
  /**
   * Render-time option, not persisted in the Context Pack. "blind-first" seals
   * the parent's facts and decisions behind a block the agent is told to open
   * only after forming its own read of the problem. Default: "open".
   */
  disclosure?: ContextDisclosure;
}

export interface ContextPack {
  version: number;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  goal: string;
  authorization: ContextAuthorization;
  knownFacts: ContextFact[];
  unknowns: string[];
  decisions: ContextDecision[];
  references: ContextReference[];
  evidence: ContextEvidence[];
  claims: string[];
  learningClaims: LearningClaimV1[];
  nextStep: string;
}

export interface ContextHandoffPatch {
  decisions?: readonly ContextDecision[];
  evidence?: readonly ContextEvidence[];
  unknowns?: readonly string[];
  nextStep?: string;
}

export async function buildContextPack(input: {
  projectDirectory: string;
  input: ContextPackInput;
  now?: Date;
}): Promise<ContextPack> {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();

  return {
    version: CONTEXT_PACK_VERSION,
    id: randomUUID(),
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    goal: redactSensitiveText(input.input.goal),
    authorization: input.input.authorization,
    knownFacts: (input.input.knownFacts ?? []).map(redactFact),
    unknowns: (input.input.unknowns ?? []).map(redactSensitiveText),
    decisions: (input.input.decisions ?? []).map(redactDecision),
    references: await buildReferences(
      input.projectDirectory,
      input.input.references ?? [],
    ),
    evidence: (input.input.evidence ?? []).map(redactEvidence),
    claims: (input.input.claims ?? []).map(redactSensitiveText),
    learningClaims: parseLearningClaims(input.input.learningClaims),
    nextStep: redactSensitiveText(input.input.nextStep),
  };
}

export interface RenderContextPackOptions {
  /** See {@link ContextPackInput.disclosure}. Default: "open". */
  disclosure?: ContextDisclosure;
}

/**
 * Render a Context Pack into the child prompt.
 *
 * `pack.claims` is deliberately NOT rendered: the acceptance claims stay in the
 * data model and are enforced verifier-side by the proof gate. Handing the
 * child the exact strings it will be graded against invites Goodharting —
 * writing to the rubric instead of solving the problem.
 */
export function renderContextPackForPrompt(
  pack: ContextPack,
  options: RenderContextPackOptions = {},
): string {
  const blindFirst = options.disclosure === "blind-first";
  const lines = [
    "## Context Pack",
    `Goal: ${pack.goal}`,
    `Authorization: ${pack.authorization}`,
  ];

  const factLines = pack.knownFacts.map((fact) => {
    const reference = fact.reference ? ` (${fact.reference})` : "";
    return `Fact: [${fact.source}] ${fact.statement}${reference}`;
  });
  const decisionLines = pack.decisions.map((decision) => {
    const rationale = decision.rationale ? ` — ${decision.rationale}` : "";
    const unlock = decision.unlockCondition
      ? ` (unlock if: ${decision.unlockCondition})`
      : "";
    return `Decision: ${decision.statement}${rationale}${unlock}`;
  });

  if (!blindFirst) lines.push(...factLines);
  for (const unknown of pack.unknowns) {
    lines.push(`Unknown: ${unknown}`);
  }
  if (!blindFirst) lines.push(...decisionLines);
  for (const reference of pack.references) {
    lines.push(`Reference: ${reference.path} (${reference.digest})`);
  }
  for (const evidence of pack.evidence) {
    const recordedAt = evidence.recordedAt ? ` @ ${evidence.recordedAt}` : "";
    const claimTag = evidence.claim ? ` [claim: ${evidence.claim}]` : "";
    lines.push(
      `Evidence: ${evidence.description} (${evidence.reference}${recordedAt})${claimTag}`,
    );
  }
  if (pack.learningClaims.length > 0) {
    lines.push("Explicit learning claims to prove:");
    for (const claim of pack.learningClaims) {
      lines.push(`- [${claim.claimId}] ${claim.statement}`);
    }
  }
  lines.push(`Suggested entry point (optional, non-binding): ${pack.nextStep}`);

  if (blindFirst && (factLines.length > 0 || decisionLines.length > 0)) {
    lines.push(
      "",
      "### Sealed context — open AFTER you have written your own 5-line read of the problem",
      ...factLines,
      ...decisionLines,
    );
  }

  return lines.join("\n");
}

export async function saveContextPack(input: {
  storeDirectory: string;
  key: string;
  pack: ContextPack;
}): Promise<void> {
  const path = contextPackPath(input.storeDirectory, input.key);
  await withFileLock({
    lockPath: `${path}.lock`,
    operation: () => writeContextPack(path, input.pack),
  });
}

export async function loadContextPack(input: {
  storeDirectory: string;
  key: string;
}): Promise<ContextPack | undefined> {
  const path = contextPackPath(input.storeDirectory, input.key);
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isContextPack(value)) {
      throw new Error(`Invalid Context Pack: ${path}`);
    }
    return value;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function updateContextHandoff(input: {
  storeDirectory: string;
  key: string;
  patch: ContextHandoffPatch;
  now?: Date;
}): Promise<ContextPack> {
  const path = contextPackPath(input.storeDirectory, input.key);
  return withFileLock({
    lockPath: `${path}.lock`,
    operation: async () => {
      const current = await loadContextPack(input);
      if (!current) {
        throw new Error(`Context Pack not found: ${input.key}`);
      }

      const updated: ContextPack = {
        ...current,
        revision: current.revision + 1,
        updatedAt: (input.now ?? new Date()).toISOString(),
        unknowns: [
          ...current.unknowns,
          ...(input.patch.unknowns ?? []).map(redactSensitiveText),
        ],
        decisions: [
          ...current.decisions,
          ...(input.patch.decisions ?? []).map(redactDecision),
        ],
        evidence: [
          ...current.evidence,
          ...(input.patch.evidence ?? []).map(redactEvidence),
        ],
        nextStep:
          input.patch.nextStep === undefined
            ? current.nextStep
            : redactSensitiveText(input.patch.nextStep),
      };
      await writeContextPack(path, updated);
      return updated;
    },
  });
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/giu,
      `$1=${REDACTED}`,
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, REDACTED)
    .replace(/\bgh[opsu]_[A-Za-z0-9_]{12,}\b/gu, REDACTED)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}\b/gu, REDACTED);
}

async function buildReferences(
  projectDirectory: string,
  references: readonly ContextReferenceInput[],
): Promise<ContextReference[]> {
  const projectRoot = await realpath(resolve(projectDirectory));
  const result: ContextReference[] = [];

  for (const reference of references) {
    const absolutePath = isAbsolute(reference.path)
      ? resolve(reference.path)
      : resolve(projectRoot, reference.path);
    const relativePath = relative(projectRoot, absolutePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Context reference is outside the project: ${reference.path}`);
    }

    const realPath = await realpath(absolutePath);
    const realRelative = relative(projectRoot, realPath);
    if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
      throw new Error(
        `Context reference resolves outside the project: ${reference.path}`,
      );
    }
    const content = await readFile(realPath);
    result.push({
      path: relativePath.replaceAll("\\", "/"),
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    });
  }

  return result;
}

async function writeContextPack(
  path: string,
  pack: ContextPack,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function contextPackPath(storeDirectory: string, key: string): string {
  if (!SAFE_CONTEXT_KEY.test(key)) {
    throw new Error(`Invalid Context Pack key: ${key}`);
  }
  return resolve(storeDirectory, `${key}.json`);
}

function redactFact(fact: ContextFact): ContextFact {
  return {
    statement: redactSensitiveText(fact.statement),
    source: fact.source,
    ...(fact.reference
      ? { reference: redactSensitiveText(fact.reference) }
      : {}),
  };
}

function redactDecision(decision: ContextDecision): ContextDecision {
  return {
    statement: redactSensitiveText(decision.statement),
    ...(decision.rationale
      ? { rationale: redactSensitiveText(decision.rationale) }
      : {}),
    ...(decision.unlockCondition
      ? { unlockCondition: redactSensitiveText(decision.unlockCondition) }
      : {}),
  };
}

function redactEvidence(evidence: ContextEvidence): ContextEvidence {
  return {
    description: redactSensitiveText(evidence.description),
    reference: redactSensitiveText(evidence.reference),
    ...(evidence.recordedAt ? { recordedAt: evidence.recordedAt } : {}),
    ...(evidence.claim ? { claim: redactSensitiveText(evidence.claim) } : {}),
    ...(evidence.receiptId ? { receiptId: evidence.receiptId } : {}),
    ...(evidence.sha256 ? { sha256: evidence.sha256 } : {}),
    source: evidence.source ?? "declared",
    ...(evidence.receiptKind ? { receiptKind: evidence.receiptKind } : {}),
    ...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
  };
}

function isContextPack(value: unknown): value is ContextPack {
  return (
    isRecord(value) &&
    value.version === CONTEXT_PACK_VERSION &&
    typeof value.id === "string" &&
    typeof value.revision === "number" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.goal === "string" &&
    isContextAuthorization(value.authorization) &&
    Array.isArray(value.knownFacts) &&
    value.knownFacts.every(isContextFact) &&
    Array.isArray(value.unknowns) &&
    value.unknowns.every((item) => typeof item === "string") &&
    Array.isArray(value.decisions) &&
    value.decisions.every(isContextDecision) &&
    Array.isArray(value.references) &&
    value.references.every(isContextReference) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isContextEvidence) &&
    Array.isArray(value.claims) &&
    value.claims.every((item) => typeof item === "string") &&
    (value.learningClaims === undefined ||
      (Array.isArray(value.learningClaims) && parseStoredLearningClaims(value.learningClaims))) &&
    typeof value.nextStep === "string"
  );
}

function parseStoredLearningClaims(value: unknown): value is LearningClaimV1[] {
  try {
    parseLearningClaims(value);
    return true;
  } catch {
    return false;
  }
}

function isContextAuthorization(value: unknown): value is ContextAuthorization {
  return (
    value === "read-only" ||
    value === "write-approved" ||
    value === "sensitive-approved"
  );
}

function isContextFact(value: unknown): value is ContextFact {
  return (
    isRecord(value) &&
    typeof value.statement === "string" &&
    (value.source === "user" ||
      value.source === "repository" ||
      value.source === "delegated" ||
      value.source === "external" ||
      value.source === "learning") &&
    (value.reference === undefined || typeof value.reference === "string")
  );
}

function isContextDecision(value: unknown): value is ContextDecision {
  return (
    isRecord(value) &&
    typeof value.statement === "string" &&
    (value.rationale === undefined || typeof value.rationale === "string") &&
    (value.unlockCondition === undefined || typeof value.unlockCondition === "string")
  );
}

function isContextEvidence(value: unknown): value is ContextEvidence {
  return (
    isRecord(value) &&
    typeof value.description === "string" &&
    typeof value.reference === "string" &&
    (value.recordedAt === undefined || typeof value.recordedAt === "string") &&
    (value.claim === undefined || typeof value.claim === "string") &&
    (value.receiptId === undefined || typeof value.receiptId === "string") &&
    (value.sha256 === undefined || typeof value.sha256 === "string") &&
    (value.source === undefined ||
      value.source === "declared" ||
      value.source === "runtime-receipt" ||
      value.source === "runtime-session") &&
    (value.receiptKind === undefined ||
      value.receiptKind === "file" ||
      value.receiptKind === "test" ||
      value.receiptKind === "command-output" ||
      value.receiptKind === "session" ||
      value.receiptKind === "diff") &&
    (value.exitCode === undefined || typeof value.exitCode === "number")
  );
}

function isContextReference(value: unknown): value is ContextReference {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.digest === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
