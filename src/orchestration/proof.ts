import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ContextEvidence } from "./context.js";

export interface EvidenceProofResult {
  valid: boolean;
  issues: string[];
}

export async function validateEvidenceOnlyProof(input: {
  projectDirectory: string;
  evidence: readonly ContextEvidence[];
  now?: Date;
  maxEvidenceAgeMs: number;
}): Promise<EvidenceProofResult> {
  const issues: string[] = [];
  if (input.evidence.length === 0) {
    return { valid: false, issues: ["No completion evidence was provided."] };
  }

  const now = input.now ?? new Date();
  for (const evidence of input.evidence) {
    validateFreshness(evidence, now, input.maxEvidenceAgeMs, issues);
    validateReference(evidence, input.projectDirectory, issues);
  }

  return { valid: issues.length === 0, issues };
}

function validateFreshness(
  evidence: ContextEvidence,
  now: Date,
  maxEvidenceAgeMs: number,
  issues: string[],
): void {
  if (!evidence.recordedAt) {
    issues.push(`Evidence has no timestamp: ${evidence.reference}.`);
    return;
  }

  const recordedAt = Date.parse(evidence.recordedAt);
  if (!Number.isFinite(recordedAt)) {
    issues.push(`Evidence has an invalid timestamp: ${evidence.reference}.`);
    return;
  }

  const age = now.getTime() - recordedAt;
  if (age < 0) {
    issues.push(`Evidence timestamp is in the future: ${evidence.reference}.`);
  } else if (age > maxEvidenceAgeMs) {
    issues.push(`Evidence is stale: ${evidence.reference} (${age}ms old).`);
  }
}

function validateReference(
  evidence: ContextEvidence,
  projectDirectory: string,
  issues: string[],
): void {
  if (evidence.reference.startsWith("command:")) {
    issues.push(
      `Command evidence has no captured output reference: ${evidence.reference}.`,
    );
    return;
  }
  if (evidence.reference.startsWith("url:")) {
    issues.push(`URL evidence was not captured locally: ${evidence.reference}.`);
    return;
  }

  const reference = evidence.reference.startsWith("session:")
    ? evidence.reference.slice("session:".length)
    : evidence.reference;
  const projectRoot = resolve(projectDirectory);
  const absolutePath = isAbsolute(reference)
    ? resolve(reference)
    : resolve(projectRoot, reference);
  const relativePath = relative(projectRoot, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    issues.push(`Evidence reference is outside the project: ${evidence.reference}.`);
    return;
  }
  if (!existsSync(absolutePath)) {
    issues.push(`Evidence reference does not exist: ${evidence.reference}.`);
  }
}
