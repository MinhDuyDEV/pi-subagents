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
import {
  parseWorkflowCheckpoint,
  type HandoffPackV1,
} from "@minhduydev/pi-core/workflow";
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
  /** Runtime-observed command metadata. Never populated from child prose. */
  command?: string;
  cwd?: string;
  toolCallId?: string;
  sessionDigest?: string;
}

export interface ContextReferenceInput {
  path: string;
}

export interface ContextReference {
  path: string;
  digest: string;
}

export type ContextDisclosure = "open" | "blind-first";

export interface BlindOrientationRecord {
  text: string;
  digest: string;
  recordedAt: string;
}

export interface BlindDisclosureState {
  phase:
    | "awaiting-orientation"
    | "orientation-recorded"
    | "continuation-dispatching"
    | "continuation-started";
  orientation?: BlindOrientationRecord;
  continuationAttemptId?: string;
  continuationCorrelationId?: string;
  continuationDispatchStartedAt?: string;
  continuationStartedAt?: string;
  continuedInvocationId?: string;
}

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
   * Durable disclosure policy.  "blind-first" requires a separate orientation
   * turn before any facts, decisions, evidence, or acceptance claims are sent.
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
  disclosure: ContextDisclosure;
  blindDisclosure?: BlindDisclosureState;
  /** Canonical fourteen-section handoffs shared with the harness. */
  workflowHandoffs: HandoffPackV1[];
}

export interface ContextHandoffPatch {
  decisions?: readonly ContextDecision[];
  evidence?: readonly ContextEvidence[];
  unknowns?: readonly string[];
  nextStep?: string;
  workflowHandoff?: HandoffPackV1;
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
    disclosure: input.input.disclosure ?? "open",
    ...(input.input.disclosure === "blind-first"
      ? { blindDisclosure: { phase: "awaiting-orientation" as const } }
      : {}),
    workflowHandoffs: [],
  };
}

export interface RenderContextPackOptions {
  /** @deprecated Disclosure is persisted on the Context Pack. */
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
  const disclosure = options.disclosure ?? pack.disclosure;
  const blindFirst = disclosure === "blind-first";
  if (
    blindFirst &&
    (pack.blindDisclosure?.phase ?? "awaiting-orientation") ===
      "awaiting-orientation"
  ) {
    return [
      "## Blind-first orientation turn",
      `Outcome: ${pack.goal}`,
      `Authorization: ${pack.authorization}`,
      "Parent context is intentionally withheld for this turn.",
      "Return your independent problem read, uncertainties, and proposed frontier only; do not implement or verify yet.",
    ].join("\n");
  }
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

  lines.push(...factLines);
  for (const unknown of pack.unknowns) {
    lines.push(`Unknown: ${unknown}`);
  }
  lines.push(...decisionLines);
  for (const reference of pack.references) {
    lines.push(`Reference: ${reference.path} (${reference.digest})`);
  }
  for (const evidence of pack.evidence) {
    const recordedAt = evidence.recordedAt ? ` @ ${evidence.recordedAt}` : "";
    lines.push(
      `Evidence receipt: ${evidence.description} (${evidence.reference}${recordedAt})`,
    );
  }
  lines.push(`Suggested entry point (optional, non-binding): ${pack.nextStep}`);

  if (blindFirst && pack.blindDisclosure?.orientation) {
    lines.push(
      "",
      "## Your independently recorded orientation",
      pack.blindDisclosure.orientation.text,
    );
  }
  for (const handoff of pack.workflowHandoffs) {
    lines.push(
      "",
      `## Canonical handoff: ${handoff.title}`,
      `Receiver: ${handoff.receiver}`,
      `Goal: ${handoff.goal}`,
      `Current state: ${handoff.currentState}`,
      ...handoff.verified.map((item) => `Verified: ${item}`),
      ...handoff.unknowns.map((item) => `Unknown: ${item}`),
      ...handoff.realConstraints.map((item) => `Real constraint: ${item}`),
      ...handoff.relevantFiles.map((item) => `Relevant file: ${item}`),
      ...handoff.closedDecisions.map((item) => `Closed decision: ${item}`),
      ...handoff.openDecisions.map((item) => `Open decision: ${item}`),
      ...handoff.existingEvidence.map((item) => `Existing evidence: ${item}`),
      `Expected deliverable: ${handoff.expectedDeliverable}`,
      ...handoff.permissions.map((item) => `Permission: ${item}`),
      ...handoff.antiPatterns.map((item) => `Anti-pattern: ${item}`),
      `Next step: ${handoff.nextStep}`,
      `Resume keys: task=${handoff.resumeKeys.taskId ?? "none"}, conversation=${handoff.resumeKeys.conversationId ?? "none"}`,
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
    return normalizeStoredContextPack(value);
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
        workflowHandoffs: input.patch.workflowHandoff
          ? [
              ...current.workflowHandoffs.filter(
                (handoff) =>
                  handoff.recordId !== input.patch.workflowHandoff?.recordId,
              ),
              structuredClone(input.patch.workflowHandoff),
            ]
          : current.workflowHandoffs,
      };
      await writeContextPack(path, updated);
      return updated;
    },
  });
}

/**
 * Persist the independent first-turn read before the withheld context is made
 * available.  Retrying the same turn is idempotent; a different orientation
 * cannot overwrite the already recorded observation.
 */
export async function recordBlindOrientation(input: {
  storeDirectory: string;
  key: string;
  text: string;
  now?: Date;
}): Promise<ContextPack> {
  const path = contextPackPath(input.storeDirectory, input.key);
  return withFileLock({
    lockPath: `${path}.lock`,
    operation: async () => {
      const current = await loadContextPack(input);
      if (!current) throw new Error(`Context Pack not found: ${input.key}`);
      if (current.disclosure !== "blind-first") {
        throw new Error(`Context Pack is not blind-first: ${input.key}`);
      }
      const text = redactSensitiveText(input.text.trim());
      if (!text) throw new Error("Blind-first orientation cannot be empty");
      const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
      const existing = current.blindDisclosure?.orientation;
      if (existing) {
        if (existing.digest !== digest) {
          throw new Error("Blind-first orientation is immutable once recorded");
        }
        return current;
      }
      const recordedAt = (input.now ?? new Date()).toISOString();
      const updated: ContextPack = {
        ...current,
        revision: current.revision + 1,
        updatedAt: recordedAt,
        blindDisclosure: {
          phase: "orientation-recorded",
          orientation: { text, digest, recordedAt },
        },
      };
      await writeContextPack(path, updated);
      return updated;
    },
  });
}

export async function beginBlindContinuation(input: {
  storeDirectory: string;
  key: string;
  attemptId: string;
  correlationId: string;
  now?: Date;
}): Promise<ContextPack> {
  const path = contextPackPath(input.storeDirectory, input.key);
  return withFileLock({
    lockPath: `${path}.lock`,
    operation: async () => {
      const current = await loadContextPack(input);
      if (!current) throw new Error(`Context Pack not found: ${input.key}`);
      if (current.disclosure !== "blind-first") return current;
      if (current.blindDisclosure?.phase === "continuation-started") return current;
      if (!current.blindDisclosure?.orientation) {
        throw new Error("Cannot dispatch blind-first continuation before orientation is recorded");
      }
      if (current.blindDisclosure.phase === "continuation-dispatching") {
        if (
          current.blindDisclosure.continuationAttemptId !== input.attemptId ||
          current.blindDisclosure.continuationCorrelationId !== input.correlationId
        ) {
          throw new Error("Blind-first continuation already has a different dispatch attempt");
        }
        return current;
      }
      const dispatchStartedAt = (input.now ?? new Date()).toISOString();
      const updated: ContextPack = {
        ...current,
        revision: current.revision + 1,
        updatedAt: dispatchStartedAt,
        blindDisclosure: {
          ...current.blindDisclosure,
          phase: "continuation-dispatching",
          continuationAttemptId: input.attemptId,
          continuationCorrelationId: input.correlationId,
          continuationDispatchStartedAt: dispatchStartedAt,
        },
      };
      await writeContextPack(path, updated);
      return updated;
    },
  });
}

export async function markBlindContinuationStarted(input: {
  storeDirectory: string;
  key: string;
  attemptId: string;
  continuedInvocationId: string;
  now?: Date;
}): Promise<ContextPack> {
  const path = contextPackPath(input.storeDirectory, input.key);
  return withFileLock({
    lockPath: `${path}.lock`,
    operation: async () => {
      const current = await loadContextPack(input);
      if (!current) throw new Error(`Context Pack not found: ${input.key}`);
      if (current.disclosure !== "blind-first") return current;
      const disclosure = current.blindDisclosure;
      if (disclosure?.phase === "continuation-started") {
        if (
          disclosure.continuationAttemptId !== input.attemptId ||
          disclosure.continuedInvocationId !== input.continuedInvocationId
        ) {
          throw new Error("Blind-first continuation start is immutable");
        }
        return current;
      }
      if (
        disclosure?.phase !== "continuation-dispatching" ||
        disclosure.continuationAttemptId !== input.attemptId
      ) {
        throw new Error("Blind-first continuation did not own the durable dispatch");
      }
      const continuationStartedAt = (input.now ?? new Date()).toISOString();
      const updated: ContextPack = {
        ...current,
        revision: current.revision + 1,
        updatedAt: continuationStartedAt,
        blindDisclosure: {
          ...disclosure,
          phase: "continuation-started",
          continuationStartedAt,
          continuedInvocationId: input.continuedInvocationId,
        },
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
    ...(evidence.command ? { command: redactSensitiveText(evidence.command) } : {}),
    ...(evidence.cwd ? { cwd: redactSensitiveText(evidence.cwd) } : {}),
    ...(evidence.toolCallId ? { toolCallId: evidence.toolCallId } : {}),
    ...(evidence.sessionDigest ? { sessionDigest: evidence.sessionDigest } : {}),
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
    typeof value.nextStep === "string" &&
    (value.disclosure === undefined ||
      value.disclosure === "open" ||
      value.disclosure === "blind-first") &&
    (value.blindDisclosure === undefined ||
      isBlindDisclosureState(value.blindDisclosure)) &&
    (value.workflowHandoffs === undefined ||
      (Array.isArray(value.workflowHandoffs) &&
        value.workflowHandoffs.every(
          (handoff) => parseWorkflowCheckpoint(handoff)?.kind === "handoff",
        )))
  );
}

function normalizeStoredContextPack(
  value: ContextPack | (Omit<ContextPack, "disclosure"> & { disclosure?: ContextDisclosure }),
): ContextPack {
  const disclosure = value.disclosure ?? "open";
  return {
    ...structuredClone(value),
    learningClaims: value.learningClaims ?? [],
    workflowHandoffs: value.workflowHandoffs ?? [],
    disclosure,
    ...(disclosure === "blind-first" && !value.blindDisclosure
      ? { blindDisclosure: { phase: "awaiting-orientation" as const } }
      : {}),
  };
}

function isBlindOrientation(value: unknown): value is BlindOrientationRecord {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.digest === "string" &&
    typeof value.recordedAt === "string"
  );
}

function isBlindDisclosureState(value: unknown): value is BlindDisclosureState {
  if (!isRecord(value)) return false;
  if (value.phase === "awaiting-orientation") {
    return value.orientation === undefined;
  }
  if (!isBlindOrientation(value.orientation)) return false;
  if (value.phase === "orientation-recorded") {
    return (
      value.continuationAttemptId === undefined &&
      value.continuationCorrelationId === undefined &&
      value.continuationDispatchStartedAt === undefined &&
      value.continuationStartedAt === undefined &&
      value.continuedInvocationId === undefined
    );
  }
  if (
    value.phase !== "continuation-dispatching" &&
    value.phase !== "continuation-started"
  ) {
    return false;
  }
  if (
    typeof value.continuationAttemptId !== "string" ||
    typeof value.continuationCorrelationId !== "string" ||
    typeof value.continuationDispatchStartedAt !== "string"
  ) {
    return false;
  }
  if (value.phase === "continuation-dispatching") {
    return (
      value.continuationStartedAt === undefined &&
      value.continuedInvocationId === undefined
    );
  }
  return (
    typeof value.continuationStartedAt === "string" &&
    typeof value.continuedInvocationId === "string"
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
    (value.exitCode === undefined || typeof value.exitCode === "number") &&
    (value.command === undefined || typeof value.command === "string") &&
    (value.cwd === undefined || typeof value.cwd === "string") &&
    (value.toolCallId === undefined || typeof value.toolCallId === "string") &&
    (value.sessionDigest === undefined || typeof value.sessionDigest === "string")
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
