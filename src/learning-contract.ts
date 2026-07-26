import { createHash } from "node:crypto";

export type TaggedSha256V1 = `sha256:v1:${string}`;
export type LearningClaimKindV1 = "pattern" | "discovery";
export type LearningSupportModeV1 = "direct-artifact" | "task-outcome";
export type LearningEvidenceKindV1 = "repository-file" | "evidence-receipt";

export interface LearningEvidenceRefV1 {
  kind: LearningEvidenceKindV1;
  ref: string;
  digest: TaggedSha256V1;
}

export interface LearningClaimV1 {
  version: 1;
  claimId: TaggedSha256V1;
  kind: LearningClaimKindV1;
  statement: string;
  applicability: string;
  support: {
    mode: LearningSupportModeV1;
    evidenceRefs: LearningEvidenceRefV1[];
  };
}

export interface SupportedLearningClaimV1 {
  claimId: TaggedSha256V1;
  supported: boolean;
  evidenceDigests: TaggedSha256V1[];
}

export interface UsageReceiptV1 {
  version: 1;
  usageId: TaggedSha256V1;
  projectId: string;
  trustEpoch: string;
  sessionGeneration: string;
  consumer: { kind: "parent-turn" | "subagent"; id: string };
  correlationId: string;
  requestDigest: TaggedSha256V1;
  queryDigest: TaggedSha256V1;
  learningId: string;
  learningRevision: number;
  learningDigest: TaggedSha256V1;
  returnedAt: string;
}

const TAGGED_DIGEST = /^sha256:v1:[a-f0-9]{64}$/;
const SECRET = /(ghp_[a-z0-9]{20,}|sk-[a-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|BEGIN [A-Z ]*PRIVATE KEY)/i;
const MAX_CLAIMS = 8;
const MAX_EVIDENCE = 16;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}.${key} is not allowed`);
  }
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0 || normalized.length > max || SECRET.test(normalized)) {
    throw new Error(`${label} is unsafe or out of bounds`);
  }
  return normalized;
}

function digest(value: unknown, label: string): TaggedSha256V1 {
  if (typeof value !== "string" || !TAGGED_DIGEST.test(value)) throw new Error(`${label} must be a tagged SHA-256 digest`);
  return value as TaggedSha256V1;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source).sort().flatMap((key) => source[key] === undefined ? [] : [[key, canonical(source[key])]]),
  );
}

export function taggedDigest(value: unknown): TaggedSha256V1 {
  const bytes = JSON.stringify(canonical(value));
  return `sha256:v1:${createHash("sha256").update(bytes).digest("hex")}`;
}

function evidenceRef(value: unknown): LearningEvidenceRefV1 {
  const input = object(value, "evidenceRef");
  exactKeys(input, ["kind", "ref", "digest"], "evidenceRef");
  if (input.kind !== "repository-file" && input.kind !== "evidence-receipt") {
    throw new Error("evidenceRef.kind is invalid");
  }
  return {
    kind: input.kind,
    ref: text(input.ref, "evidenceRef.ref", 240),
    digest: digest(input.digest, "evidenceRef.digest"),
  };
}

export function makeLearningClaim(value: unknown): LearningClaimV1 {
  const input = object(value, "learningClaim");
  exactKeys(input, ["version", "claimId", "kind", "statement", "applicability", "support"], "learningClaim");
  if (input.version !== 1) throw new Error("learningClaim.version must be 1");
  if (input.kind !== "pattern" && input.kind !== "discovery") throw new Error("learningClaim.kind is invalid");
  const kind: LearningClaimKindV1 = input.kind;
  const supportInput = object(input.support, "learningClaim.support");
  exactKeys(supportInput, ["mode", "evidenceRefs"], "learningClaim.support");
  if (supportInput.mode !== "direct-artifact" && supportInput.mode !== "task-outcome") {
    throw new Error("learningClaim.support.mode is invalid");
  }
  const mode: LearningSupportModeV1 = supportInput.mode;
  if (!Array.isArray(supportInput.evidenceRefs) || supportInput.evidenceRefs.length === 0 || supportInput.evidenceRefs.length > MAX_EVIDENCE) {
    throw new Error("learningClaim.support.evidenceRefs is out of bounds");
  }
  const body = {
    version: 1 as const,
    kind,
    statement: text(input.statement, "learningClaim.statement", 400),
    applicability: text(input.applicability, "learningClaim.applicability", 240),
    support: {
      mode,
      evidenceRefs: supportInput.evidenceRefs.map(evidenceRef),
    },
  };
  const claimId = taggedDigest(body);
  if (input.claimId !== undefined && digest(input.claimId, "learningClaim.claimId") !== claimId) {
    throw new Error("learningClaim.claimId does not match canonical content");
  }
  return { ...body, claimId };
}

export function parseLearningClaims(value: unknown): LearningClaimV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CLAIMS) {
    throw new Error("learningClaims is out of bounds");
  }
  return value.map(makeLearningClaim);
}

export function parseUsageReceipts(value: unknown): UsageReceiptV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error("usageReceipts is out of bounds");
  }
  return value.map((entry) => {
    const input = object(entry, "usageReceipt");
    exactKeys(input, [
      "version", "usageId", "projectId", "trustEpoch", "sessionGeneration", "consumer",
      "correlationId", "requestDigest", "queryDigest", "learningId", "learningRevision",
      "learningDigest", "returnedAt",
    ], "usageReceipt");
    if (input.version !== 1) throw new Error("usageReceipt.version must be 1");
    const consumer = object(input.consumer, "usageReceipt.consumer");
    exactKeys(consumer, ["kind", "id"], "usageReceipt.consumer");
    if (consumer.kind !== "parent-turn" && consumer.kind !== "subagent") {
      throw new Error("usageReceipt.consumer.kind is invalid");
    }
    if (!Number.isInteger(input.learningRevision) || Number(input.learningRevision) < 1) {
      throw new Error("usageReceipt.learningRevision is invalid");
    }
    const returnedAt = text(input.returnedAt, "usageReceipt.returnedAt", 80);
    if (!Number.isFinite(Date.parse(returnedAt))) {
      throw new Error("usageReceipt.returnedAt is invalid");
    }
    return {
      version: 1,
      usageId: digest(input.usageId, "usageReceipt.usageId"),
      projectId: text(input.projectId, "usageReceipt.projectId", 160),
      trustEpoch: text(input.trustEpoch, "usageReceipt.trustEpoch", 160),
      sessionGeneration: text(input.sessionGeneration, "usageReceipt.sessionGeneration", 160),
      consumer: {
        kind: consumer.kind,
        id: text(consumer.id, "usageReceipt.consumer.id", 200),
      },
      correlationId: text(input.correlationId, "usageReceipt.correlationId", 200),
      requestDigest: digest(input.requestDigest, "usageReceipt.requestDigest"),
      queryDigest: digest(input.queryDigest, "usageReceipt.queryDigest"),
      learningId: text(input.learningId, "usageReceipt.learningId", 200),
      learningRevision: Number(input.learningRevision),
      learningDigest: digest(input.learningDigest, "usageReceipt.learningDigest"),
      returnedAt,
    } satisfies UsageReceiptV1;
  });
}

export function parseSupportedLearningClaims(value: unknown): SupportedLearningClaimV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CLAIMS) throw new Error("supportedClaims is out of bounds");
  return value.map((entry) => {
    const input = object(entry, "supportedClaim");
    exactKeys(input, ["claimId", "supported", "evidenceDigests"], "supportedClaim");
    if (typeof input.supported !== "boolean") throw new Error("supportedClaim.supported must be boolean");
    if (!Array.isArray(input.evidenceDigests) || input.evidenceDigests.length > MAX_EVIDENCE) {
      throw new Error("supportedClaim.evidenceDigests is out of bounds");
    }
    return {
      claimId: digest(input.claimId, "supportedClaim.claimId"),
      supported: input.supported,
      evidenceDigests: input.evidenceDigests.map((item) => digest(item, "supportedClaim.evidenceDigest")),
    };
  });
}
