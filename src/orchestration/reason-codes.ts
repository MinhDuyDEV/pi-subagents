import { redactSensitiveText } from "./context.js";

export const ORCHESTRATION_REASON_MAX_CHARS = 1_024;

export const ORCHESTRATION_REASON_CODES = {
  claimLeaseLost: "CLAIM_LEASE_LOST",
  independentReviewRequired: "INDEPENDENT_REVIEW_REQUIRED",
} as const;

export type OrchestrationReasonCode =
  (typeof ORCHESTRATION_REASON_CODES)[keyof typeof ORCHESTRATION_REASON_CODES];

export function normalizeOrchestrationReason(value: string): string {
  return redactSensitiveText(value).slice(0, ORCHESTRATION_REASON_MAX_CHARS);
}
