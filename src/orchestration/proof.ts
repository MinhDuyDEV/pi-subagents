import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ContextEvidence } from "./context.js";

export interface EvidenceProofResult {
  valid: boolean;
  issues: string[];
}

export async function validateEvidenceOnlyProof(input: {
  projectDirectory: string;
  allowedProjectDirectories?: readonly string[];
  evidence: readonly ContextEvidence[];
  now?: Date;
  maxEvidenceAgeMs: number;
  claims?: readonly string[];
}): Promise<EvidenceProofResult> {
  const issues: string[] = [];
  if (input.evidence.length === 0) {
    return { valid: false, issues: ["No completion evidence was provided."] };
  }

  const projectDirectories = [
    input.projectDirectory,
    ...(input.allowedProjectDirectories ?? []),
  ];
  const now = input.now ?? new Date();
  for (const evidence of input.evidence) {
    validateEvidenceAuthority(evidence, issues);
    validateFreshness(evidence, now, input.maxEvidenceAgeMs, issues);
    validateReference(evidence, projectDirectories, issues);
  }
  validateSubstantiation(input.claims, input.evidence, projectDirectories, issues);

  return { valid: issues.length === 0, issues };
}

function validateEvidenceAuthority(
  evidence: ContextEvidence,
  issues: string[],
): void {
  if (
    evidence.source !== "runtime-receipt" &&
    evidence.source !== "runtime-session"
  ) {
    issues.push(
      `Evidence lacks a runtime-generated receipt or session binding: ${evidence.reference}.`,
    );
  }
  if (evidence.source === "runtime-receipt") {
    if (!evidence.receiptId || !evidence.sha256 || !evidence.receiptKind) {
      issues.push(`Runtime receipt metadata is incomplete: ${evidence.reference}.`);
    }
    if (
      (evidence.receiptKind === "test" ||
        evidence.receiptKind === "command-output") &&
      evidence.exitCode !== 0
    ) {
      issues.push(
        `Evidence command did not exit successfully: ${evidence.reference} (exit ${evidence.exitCode ?? "unknown"}).`,
      );
    }
  }
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
  projectDirectories: readonly string[],
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

  const resolved = resolveEvidencePath(evidence, projectDirectories);
  if (resolved.path) {
    if (evidence.sha256) {
      try {
        if (!statSync(resolved.path).isFile()) {
          issues.push(`Receipt evidence is not a file: ${evidence.reference}.`);
        } else {
          const digest = `sha256:${createHash("sha256")
            .update(readFileSync(resolved.path))
            .digest("hex")}`;
          if (digest !== evidence.sha256) {
            issues.push(`Evidence artifact changed after receipt ${evidence.receiptId ?? "recording"}: ${evidence.reference}.`);
          }
        }
      } catch {
        issues.push(`Evidence artifact cannot be hashed: ${evidence.reference}.`);
      }
    }
    return;
  }
  issues.push(
    resolved.outside
      ? `Evidence reference resolves outside the project: ${evidence.reference}.`
      : `Evidence reference does not exist: ${evidence.reference}.`,
  );
}

function resolveEvidencePath(
  evidence: ContextEvidence,
  projectDirectories: readonly string[],
): { path?: string; outside: boolean } {
  const reference = evidence.reference.startsWith("session:")
    ? evidence.reference.slice("session:".length)
    : evidence.reference;
  const roots = [
    ...new Set(
      projectDirectories.flatMap((directory) => {
        try {
          return [realpathSync(resolve(directory))];
        } catch {
          return [];
        }
      }),
    ),
  ];
  const candidates = isAbsolute(reference)
    ? [resolve(reference)]
    : roots.map((root) => resolve(root, reference));
  let outside = false;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      outside ||= !roots.some((root) => isWithinRoot(root, candidate));
      continue;
    }
    try {
      const realPath = realpathSync(candidate);
      if (roots.some((root) => isWithinRoot(root, realPath))) {
        return { path: realPath, outside: false };
      }
      outside = true;
    } catch {
      // Treat an unresolvable existing reference as unavailable.
    }
  }
  return { outside };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

const SUBSTANTIATION_STOPWORDS = new Set([
  "the",
  "and",
  "with",
  "that",
  "this",
  "from",
  "have",
  "been",
  "will",
  "was",
  "were",
  "are",
  "for",
  "not",
  "but",
  "your",
  "their",
]);

function resolveEvidenceFilePath(
  evidence: ContextEvidence,
  projectDirectories: readonly string[],
): string | undefined {
  if (
    evidence.reference.startsWith("command:") ||
    evidence.reference.startsWith("url:")
  ) {
    return undefined;
  }
  const resolved = resolveEvidencePath(evidence, projectDirectories).path;
  if (!resolved) return undefined;
  try {
    return statSync(resolved).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function extractSignificantTokens(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.filter(
    (token) => token.length > 3 && !SUBSTANTIATION_STOPWORDS.has(token),
  );
}

function fileContainsClaimToken(filePath: string, claim: string): boolean {
  const claimTokens = extractSignificantTokens(claim);
  if (claimTokens.length === 0) {
    return true;
  }
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8").toLowerCase();
  } catch {
    return false;
  }
  const matching = claimTokens.filter((token) => contents.includes(token));
  const required = Math.min(2, claimTokens.length);
  return matching.length >= required;
}

function validateSubstantiation(
  claims: readonly string[] | undefined,
  evidence: readonly ContextEvidence[],
  projectDirectories: readonly string[],
  issues: string[],
): void {
  if (!claims || claims.length === 0) {
    return;
  }
  for (const claim of claims) {
    let bound = evidence.filter((item) => item.claim === claim);
    if (bound.length === 0) {
      bound = evidence.filter(
        (item) =>
          item.claim !== undefined &&
          item.claim.toLowerCase().includes(claim.toLowerCase()),
      );
    }
    if (bound.length === 0) {
      issues.push(`Claim has no bound evidence: ${claim}`);
      continue;
    }
    for (const item of bound) {
      const filePath = resolveEvidenceFilePath(item, projectDirectories);
      if (filePath === undefined) {
        continue;
      }
      if (!fileContainsClaimToken(filePath, claim)) {
        issues.push(
          `Evidence does not substantiate claim: ${claim} (no overlap in ${item.reference})`,
        );
      }
    }
  }
}
