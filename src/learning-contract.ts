/**
 * Learning-contract surface, now sourced from @minhduydev/pi-core.
 *
 * This module used to carry its own `taggedDigest`, canonicalization, and
 * claim/receipt validation — one of the nine digest copies the 2026-07-26
 * audit found (§2.2). The primitives and types come from pi-core now, so the
 * producer and every consumer hash the same preimage by construction.
 *
 * What stays local is POLICY, not primitives: at the tool input boundary this
 * package throws on an out-of-bounds or malformed claim list rather than
 * silently dropping entries — a caller that supplied a bad claim should hear
 * about it, not have it quietly vanish from its lease.
 */
import {
  makeLearningClaim as coreMakeLearningClaim,
  makeUsageReceipt,
  MAX_CLAIMS,
  MAX_EVIDENCE,
  type LearningClaimV1,
  type SupportedLearningClaimV1,
  type TaggedSha256V1,
  type UsageReceiptV1,
} from "@minhduydev/pi-core";
import { isTaggedSha256, taggedDigest } from "@minhduydev/pi-core";

export { taggedDigest };
export type {
  LearningClaimV1,
  SupportedLearningClaimV1,
  TaggedSha256V1,
  UsageReceiptV1,
};
export type LearningClaimKindV1 = LearningClaimV1["kind"];
export type LearningSupportModeV1 = LearningClaimV1["support"]["mode"];
export type LearningEvidenceKindV1 =
  LearningClaimV1["support"]["evidenceRefs"][number]["kind"];
export type LearningEvidenceRefV1 =
  LearningClaimV1["support"]["evidenceRefs"][number];

export function makeLearningClaim(value: unknown): LearningClaimV1 {
  return coreMakeLearningClaim(value);
}

/** STRICT list parse for the tool boundary: invalid input throws. */
export function parseLearningClaims(value: unknown): LearningClaimV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CLAIMS) {
    throw new Error("learningClaims is out of bounds");
  }
  return value.map((entry) => coreMakeLearningClaim(entry));
}

/** STRICT list parse for the tool boundary: invalid input throws. */
export function parseUsageReceipts(value: unknown): UsageReceiptV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error("usageReceipts is out of bounds");
  }
  return value.map((entry) => makeUsageReceipt(entry));
}

/** STRICT list parse for the tool boundary: invalid input throws. */
export function parseSupportedLearningClaims(
  value: unknown,
): SupportedLearningClaimV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CLAIMS) {
    throw new Error("supportedClaims is out of bounds");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("supportedClaim must be an object");
    }
    const input = entry as Record<string, unknown>;
    if (typeof input.supported !== "boolean") {
      throw new Error("supportedClaim.supported must be boolean");
    }
    if (!isTaggedSha256(input.claimId)) {
      throw new Error("supportedClaim.claimId must be a tagged digest");
    }
    if (!Array.isArray(input.evidenceDigests) || input.evidenceDigests.length > MAX_EVIDENCE) {
      throw new Error("supportedClaim.evidenceDigests is out of bounds");
    }
    return {
      claimId: input.claimId,
      supported: input.supported,
      evidenceDigests: input.evidenceDigests.map((item) => {
        if (!isTaggedSha256(item)) {
          throw new Error("supportedClaim.evidenceDigest must be a tagged digest");
        }
        return item;
      }),
    };
  });
}
