import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  LearningClaimV1,
  SupportedLearningClaimV1,
  TaggedSha256V1,
} from "../learning-contract.js";
import type { ContextEvidence } from "./context.js";
import type { SemanticAttestationV1 } from "./run-store.js";

export interface EvidenceProofResult {
  valid: boolean;
  /** Integrity (fresh, runtime-owned, digest-bound receipt) is separate from
   * semantic substantiation of the requested claims. */
  receiptIntegrityValid: boolean;
  semanticProofValid: boolean;
  issues: string[];
  supportedClaims: SupportedLearningClaimV1[];
}

export async function validateEvidenceOnlyProof(input: {
  projectDirectory: string;
  allowedProjectDirectories?: readonly string[];
  evidence: readonly ContextEvidence[];
  now?: Date;
  maxEvidenceAgeMs: number;
  claims?: readonly string[];
  learningClaims?: readonly LearningClaimV1[];
  /** Reviewer-owned, canonical semantic attestations. */
  semanticAttestations?: readonly SemanticAttestationV1[];
  /** Current subject digest to which each attestation must bind. */
  subjectDigest?: string;
}): Promise<EvidenceProofResult> {
  const integrityIssues: string[] = [];
  const semanticIssues: string[] = [];
  if (input.evidence.length === 0) {
    return {
      valid: false,
      receiptIntegrityValid: false,
      semanticProofValid: (input.claims?.length ?? 0) === 0 &&
        (input.learningClaims?.length ?? 0) === 0,
      issues: ["No completion evidence was provided."],
      supportedClaims: unsupportedLearningClaims(input.learningClaims),
    };
  }

  const projectDirectories = [
    input.projectDirectory,
    ...(input.allowedProjectDirectories ?? []),
  ];
  const now = input.now ?? new Date();
  for (const evidence of input.evidence) {
    validateEvidenceAuthority(evidence, integrityIssues);
    validateFreshness(evidence, now, input.maxEvidenceAgeMs, integrityIssues);
    validateReference(evidence, projectDirectories, integrityIssues);
  }
  validateSubstantiation(
    input.claims,
    input.evidence,
    input.semanticAttestations,
    input.subjectDigest,
    semanticIssues,
  );
  const supportedClaims = validateLearningClaims(
    input.learningClaims,
    input.evidence,
    projectDirectories,
    now,
    input.maxEvidenceAgeMs,
    input.semanticAttestations,
    input.subjectDigest,
    semanticIssues,
  );

  const issues = [...integrityIssues, ...semanticIssues];
  return {
    valid: issues.length === 0,
    receiptIntegrityValid: integrityIssues.length === 0,
    semanticProofValid: semanticIssues.length === 0,
    issues,
    supportedClaims,
  };
}

function unsupportedLearningClaims(
  claims: readonly LearningClaimV1[] | undefined,
): SupportedLearningClaimV1[] {
  return (claims ?? []).map((claim) => ({
    claimId: claim.claimId,
    supported: false,
    evidenceDigests: [],
  }));
}

function validateLearningClaims(
  claims: readonly LearningClaimV1[] | undefined,
  evidence: readonly ContextEvidence[],
  projectDirectories: readonly string[],
  now: Date,
  maxEvidenceAgeMs: number,
  semanticAttestations: readonly SemanticAttestationV1[] | undefined,
  subjectDigest: string | undefined,
  issues: string[],
): SupportedLearningClaimV1[] {
  return (claims ?? []).map((claim): SupportedLearningClaimV1 => {
    const boundEvidence = claim.support.evidenceRefs.map((reference) => ({
      reference,
      evidence: evidence.find(
        (item) =>
          item.reference === reference.ref || item.receiptId === reference.ref,
      ),
    }));
    if (boundEvidence.some((item) => item.evidence === undefined)) {
      return { claimId: claim.claimId, supported: false, evidenceDigests: [] };
    }

    const verifiedDigests: TaggedSha256V1[] = [];
    let substantiated = false;
    for (const binding of boundEvidence) {
      const item = binding.evidence!;
      const bindingIssues: string[] = [];
      validateEvidenceAuthority(item, bindingIssues);
      validateFreshness(item, now, maxEvidenceAgeMs, bindingIssues);
      validateReference(item, projectDirectories, bindingIssues);
      const filePath = resolveEvidenceFilePath(item, projectDirectories);
      if (bindingIssues.length > 0 || filePath === undefined) {
        return { claimId: claim.claimId, supported: false, evidenceDigests: [] };
      }
      const digest = `sha256:v1:${createHash("sha256")
        .update(readFileSync(filePath))
        .digest("hex")}` as TaggedSha256V1;
      if (digest !== binding.reference.digest) {
        return { claimId: claim.claimId, supported: false, evidenceDigests: [] };
      }
      verifiedDigests.push(digest);
      const attestation = findSemanticAttestation(
        semanticAttestations,
        claim.statement,
        item.receiptId ?? item.reference,
        item.sha256 ?? "",
        subjectDigest,
      );
      substantiated ||= attestation !== undefined;
    }

    if (!substantiated) {
      issues.push(`Learning claim has no verifier-bound semantic proof: ${claim.claimId}`);
    }

    return {
      claimId: claim.claimId,
      supported: substantiated,
      evidenceDigests: substantiated ? verifiedDigests : [],
    };
  });
}

function validateEvidenceAuthority(
  evidence: ContextEvidence,
  issues: string[],
): void {
  if (evidence.source !== "runtime-receipt") {
    issues.push(
      `Evidence lacks a runtime-generated receipt: ${evidence.reference}.`,
    );
  }
  if (evidence.source === "runtime-receipt") {
    if (
      !evidence.receiptId ||
      !evidence.sha256 ||
      !evidence.receiptKind ||
      evidence.source !== "runtime-receipt"
    ) {
      issues.push(`Runtime receipt metadata is incomplete: ${evidence.reference}.`);
    }
    if (evidence.receiptKind === "session") {
      issues.push(`A session transcript is not a command receipt: ${evidence.reference}.`);
    }
    if (evidence.receiptKind === "test" || evidence.receiptKind === "command-output") {
      if (
        !evidence.command ||
        !evidence.cwd ||
        !evidence.toolCallId ||
        !evidence.sessionDigest
      ) {
        issues.push(`Runtime command receipt is not bound to an observed tool call: ${evidence.reference}.`);
      }
      if (evidence.exitCode !== 0) {
        issues.push(
          `Evidence command did not exit successfully: ${evidence.reference} (exit ${evidence.exitCode ?? "unknown"}).`,
        );
      }
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

function validateSubstantiation(
  claims: readonly string[] | undefined,
  evidence: readonly ContextEvidence[],
  semanticAttestations: readonly SemanticAttestationV1[] | undefined,
  subjectDigest: string | undefined,
  issues: string[],
): void {
  if (!claims || claims.length === 0) {
    return;
  }
  for (const claim of claims) {
    const bound = evidence.filter((item) => item.claim === claim);
    if (bound.length === 0) {
      issues.push(`Claim has no bound evidence: ${claim}`);
      continue;
    }
    const validBinding = bound.some((item) =>
      findSemanticAttestation(
        semanticAttestations,
        claim,
        item.receiptId ?? item.reference,
        item.sha256 ?? "",
        subjectDigest,
      ),
    );
    if (!validBinding) {
      issues.push(`Claim has no verifier-bound semantic proof: ${claim}`);
    }
  }
}

function findSemanticAttestation(
  attestations: readonly SemanticAttestationV1[] | undefined,
  claim: string,
  receiptId: string,
  artifactDigest: string,
  subjectDigest: string | undefined,
): SemanticAttestationV1 | undefined {
  if (!subjectDigest) return undefined;
  return (attestations ?? []).find(
    (attestation) =>
      attestation.claim === claim &&
      attestation.receiptId === receiptId &&
      attestation.artifactDigest === artifactDigest &&
      attestation.subjectDigest === subjectDigest,
  );
}
