import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadContextPack } from "./context.js";
import { getOrchestrationPaths } from "./paths.js";
import {
  getDurableRunByTaskId,
  type DurableTaskRun,
} from "./run-store.js";
import { getFinalTaskResult, getTaskSnapshot } from "./task-query.js";
import type { OrchestrationEvent } from "./telemetry.js";
import { inspectTaskWorktree } from "../worktree.js";

export type ReviewerVerdict = "approved" | "changes_requested" | "rejected";

export interface ReviewerOwnedVerdict {
  verdict: ReviewerVerdict;
  reviewedDigest: string;
  outputDigest: string;
}

export interface SemanticAttestationInput {
  claim: string;
  receiptId: string;
  artifactDigest: string;
  subjectDigest: string;
}

const VERDICT_RE =
  /<review_verdict>\s*(approved|changes_requested|rejected)\s*<\/review_verdict>/giu;
const DIGEST_RE =
  /<reviewed_digest>\s*(sha256:[a-f0-9]{64})\s*<\/reviewed_digest>/giu;
const ATTESTATION_RE =
  /<semantic_attestation>\s*(\{[\s\S]*?\})\s*<\/semantic_attestation>/giu;

/**
 * Parse the verdict from the reviewer's canonical final assistant output.
 *
 * The caller supplies no verdict. The reviewer must name the exact subject
 * digest it reviewed, which prevents a completed review from being rebound to
 * a later mutation of the producer's session, evidence, or retained worktree.
 */
export function parseReviewerOwnedVerdict(
  output: string,
  expectedSubjectDigest: string,
): ReviewerOwnedVerdict {
  const verdictMatches = [...output.matchAll(VERDICT_RE)];
  const digestMatches = [...output.matchAll(DIGEST_RE)];
  const verdictMatch = verdictMatches[0];
  const digestMatch = digestMatches[0];
  if (
    verdictMatches.length !== 1 ||
    digestMatches.length !== 1 ||
    !verdictMatch?.[1] ||
    !digestMatch?.[1]
  ) {
    throw new Error(
      "Reviewer output must contain exactly one <review_verdict>approved|changes_requested|rejected</review_verdict> and exactly one <reviewed_digest>sha256:…</reviewed_digest>",
    );
  }
  const reviewedDigest = digestMatch[1].toLowerCase();
  if (reviewedDigest !== expectedSubjectDigest.toLowerCase()) {
    throw new Error(
      `Reviewer output is bound to ${reviewedDigest}, not the current subject digest ${expectedSubjectDigest}`,
    );
  }
  return {
    verdict: verdictMatch[1].toLowerCase() as ReviewerVerdict,
    reviewedDigest,
    outputDigest: `sha256:${createHash("sha256").update(output).digest("hex")}`,
  };
}

export function parseSemanticAttestations(
  output: string,
  requiredClaims: readonly string[],
  expectedSubjectDigest: string,
): SemanticAttestationInput[] {
  const matches = [...output.matchAll(ATTESTATION_RE)];
  if (matches.length !== requiredClaims.length) {
    throw new Error(
      `Reviewer output must contain exactly ${requiredClaims.length} semantic attestation(s)`,
    );
  }
  const required = new Set(requiredClaims);
  const seen = new Set<string>();
  const attestations = matches.map((match) => {
    let value: unknown;
    try {
      value = JSON.parse(match[1]!);
    } catch {
      throw new Error("Semantic attestation is not valid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Semantic attestation must be an object");
    }
    const input = value as Record<string, unknown>;
    if (
      typeof input.claim !== "string" ||
      input.claim.length === 0 ||
      !required.has(input.claim) ||
      seen.has(input.claim) ||
      typeof input.receipt_id !== "string" ||
      input.receipt_id.length === 0 ||
      typeof input.artifact_digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(input.artifact_digest) ||
      input.subject_digest !== expectedSubjectDigest
    ) {
      throw new Error("Semantic attestation is incomplete or not bound to this subject");
    }
    seen.add(input.claim);
    return {
      claim: input.claim,
      receiptId: input.receipt_id,
      artifactDigest: input.artifact_digest,
      subjectDigest: input.subject_digest,
    };
  });
  if (seen.size !== required.size) {
    throw new Error("Semantic attestations do not cover every requested claim");
  }
  return attestations;
}

export function isAcceptingReviewerVerdict(
  verdict: string | undefined,
): boolean {
  return verdict === "approved";
}

/**
 * Digest the canonical reviewer subject. The session, retained worktree diff,
 * and durable evidence references are all bound so a verdict cannot be reused
 * after any of those inputs changes.
 */
export async function taskSubjectDigest(
  projectDirectory: string,
  taskId: string,
): Promise<string> {
  const snapshot = await getTaskSnapshot(projectDirectory, taskId);
  if (!snapshot.sessionReference) {
    throw new Error(`Task ${taskId} has no canonical session to review`);
  }
  const hash = createHash("sha256");
  hash.update(await readFile(snapshot.sessionReference));
  const paths = getOrchestrationPaths(projectDirectory);
  const run = await getDurableRunByTaskId(paths.runStore, taskId);
  if (run?.worktree) {
    const worktreeResult =
      run.worktreeDisposition === "retained"
        ? inspectTaskWorktree(run.worktree)
        : run.worktreeResult;
    if (worktreeResult) {
      hash.update("\0worktree\0");
      hash.update(worktreeResult.diffDigest);
    }
  }
  const pack = await loadContextPack({
    storeDirectory: paths.contextStore,
    key: taskId,
  });
  if (pack) {
    hash.update("\0context\0");
    // Bind the complete persisted context, not only evidence.  Claims,
    // authorization, decisions, and next-step changes must force a fresh
    // reviewer attestation rather than reusing a verdict for a different
    // semantic subject.
    hash.update(JSON.stringify(pack));
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Re-prove a durable review event from the canonical reviewer run and final
 * output. Presence of reviewer-shaped fields in the writable event journal is
 * not authority by itself.
 */
export async function isReviewerEventBound(input: {
  event: OrchestrationEvent;
  subject: DurableTaskRun;
  subjectDigest: string;
  projectDirectory: string;
  runs: readonly DurableTaskRun[];
}): Promise<boolean> {
  const { event, subject, subjectDigest, projectDirectory, runs } = input;
  if (
    event.type !== "task_reviewed" ||
    event.taskId !== subject.taskId ||
    !event.reviewerTaskId ||
    event.reviewerTaskId === subject.taskId ||
    !event.reviewerInvocationId ||
    event.subjectDigest !== subjectDigest ||
    !event.reviewerOutputDigest ||
    !/^sha256:[a-f0-9]{64}$/u.test(event.reviewerOutputDigest)
  ) {
    return false;
  }
  const reviewer = runs.find(
    (candidate) =>
      candidate.invocationId === event.reviewerInvocationId &&
      candidate.taskId === event.reviewerTaskId,
  );
  if (
    !reviewer ||
    reviewer.executionPhase !== "completed" ||
    reviewer.reportedOutcome !== "success" ||
    (reviewer.verificationPhase !== "passed" &&
      reviewer.verificationPhase !== "not-required") ||
    (subject.verifier?.reviewerAgent !== undefined &&
      reviewer.agentType !== subject.verifier.reviewerAgent)
  ) {
    return false;
  }
  try {
    const snapshot = await getTaskSnapshot(
      projectDirectory,
      event.reviewerTaskId,
    );
    const output = await getFinalTaskResult(snapshot);
    if (!output) return false;
    const parsed = parseReviewerOwnedVerdict(output, subjectDigest);
    return (
      parsed.verdict === event.verdict &&
      parsed.outputDigest === event.reviewerOutputDigest
    );
  } catch {
    return false;
  }
}
