import { describe, expect, it } from "vitest";
import {
  validateLearningContext,
  mergeLearningFacts,
  clampString,
  clampIssues,
  validateSha256Hex,
  validateEvidenceDigests,
  makeContextRequestPayload,
  makeProofVerifiedPayload,
  makeReviewCompletedPayload,
  SUBAGENT_LEARNING_EVENTS_V1,
  MAX_TASK_ID,
  MAX_AGENT_TYPE,
  MAX_DESCRIPTION,
  MAX_VERDICT,
  MAX_ID,
  MAX_ISSUES,
  MAX_EVIDENCE_DIGESTS,
  type LearningContextV1,
  type ContextRequestPayloadV1,
  type ProofVerifiedPayloadV1,
  type ReviewCompletedPayloadV1,
} from "../src/events.js";
import type { ContextFact } from "../src/orchestration/context.js";

describe("learning event emission contracts", () => {
  it("uses one explicit correlation ID and redacts bounded payload fields", () => {
    const correlationId = "orchestration-1";
    const context = makeContextRequestPayload(
      "task-1",
      "worker",
      "deploy api_key=secret-value",
      correlationId,
    );
    const proof = makeProofVerifiedPayload(
      "task-1",
      false,
      ["password=hunter2"],
      ["a".repeat(64)],
      correlationId,
    );
    const review = makeReviewCompletedPayload(
      "task-1",
      "rejected secret=bad-value",
      "review-task",
      "review-invocation",
      "b".repeat(64),
      correlationId,
    );

    expect(context.correlationId).toBe(correlationId);
    expect(proof.correlationId).toBe(correlationId);
    expect(review.correlationId).toBe(correlationId);
    expect(context.description).not.toContain("secret-value");
    expect(proof.verificationIssues[0]).not.toContain("hunter2");
    expect(review.verdict).not.toContain("bad-value");
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  validateLearningContext
// ───────────────────────────────────────────────────────────────────────────

describe("validateLearningContext", () => {
  it("returns undefined for null/undefined input", () => {
    expect(validateLearningContext(null)).toBeUndefined();
    expect(validateLearningContext(undefined)).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(validateLearningContext("string")).toBeUndefined();
    expect(validateLearningContext(42)).toBeUndefined();
    expect(validateLearningContext(true)).toBeUndefined();
  });

  it("returns undefined when version is not 1", () => {
    expect(validateLearningContext({ version: 2, facts: [] })).toBeUndefined();
    expect(validateLearningContext({ version: "1", facts: [] })).toBeUndefined();
  });

  it("returns undefined when facts is not an array", () => {
    expect(validateLearningContext({ version: 1, facts: "not-array" })).toBeUndefined();
    expect(validateLearningContext({ version: 1 })).toBeUndefined();
  });

  it("returns undefined when facts array is empty", () => {
    expect(validateLearningContext({ version: 1, facts: [] })).toBeUndefined();
  });

  it("accepts valid facts and clamps string lengths", () => {
    const input = {
      version: 1,
      facts: [
        {
          domain: "typescript",
          summary: "Use branded types for domain modeling",
          confidence: "high",
          evidenceDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
    };
    const result = validateLearningContext(input);
    expect(result).toBeDefined();
    expect(result!.version).toBe(1);
    expect(result!.facts).toHaveLength(1);
    expect(result!.facts[0].domain).toBe("typescript");
    expect(result!.facts[0].summary).toBe("Use branded types for domain modeling");
    expect(result!.facts[0].confidence).toBe("high");
    expect(result!.facts[0].evidenceDigest).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("rejects facts with invalid confidence", () => {
    const input = {
      version: 1,
      facts: [
        {
          domain: "typescript",
          summary: "Some fact",
          confidence: "very-high",
        },
      ],
    };
    const result = validateLearningContext(input);
    expect(result).toBeUndefined();
  });

  it("rejects facts with empty domain or summary", () => {
    const input = {
      version: 1,
      facts: [
        { domain: "", summary: "valid", confidence: "high" },
      ],
    };
    expect(validateLearningContext(input)).toBeUndefined();

    const input2 = {
      version: 1,
      facts: [
        { domain: "valid", summary: "", confidence: "high" },
      ],
    };
    expect(validateLearningContext(input2)).toBeUndefined();
  });

  it("caps facts at 3 items", () => {
    const input = {
      version: 1,
      facts: [
        { domain: "a", summary: "1", confidence: "high" },
        { domain: "b", summary: "2", confidence: "medium" },
        { domain: "c", summary: "3", confidence: "low" },
        { domain: "d", summary: "4", confidence: "high" },
        { domain: "e", summary: "5", confidence: "high" },
      ],
    };
    const result = validateLearningContext(input);
    expect(result).toBeDefined();
    expect(result!.facts).toHaveLength(3);
  });

  it("clamps domain to 200 chars", () => {
    const input = {
      version: 1,
      facts: [
        {
          domain: "x".repeat(300),
          summary: "test",
          confidence: "high",
        },
      ],
    };
    const result = validateLearningContext(input);
    expect(result).toBeDefined();
    expect(result!.facts[0].domain.length).toBe(200);
  });

  it("clamps summary to 1200 chars", () => {
    const input = {
      version: 1,
      facts: [
        {
          domain: "test",
          summary: "x".repeat(2000),
          confidence: "high",
        },
      ],
    };
    const result = validateLearningContext(input);
    expect(result).toBeDefined();
    expect(result!.facts[0].summary.length).toBe(1200);
  });

  it("rejects non-SHA-256 evidenceDigest", () => {
    const input = {
      version: 1,
      facts: [
        {
          domain: "test",
          summary: "test",
          confidence: "high",
          evidenceDigest: "x".repeat(256),
        },
      ],
    };
    const result = validateLearningContext(input);
    expect(result).toBeUndefined();
  });

  it("accepts optional patterns and clamps them", () => {
    const input = {
      version: 1,
      facts: [
        { domain: "test", summary: "test", confidence: "high" },
      ],
      patterns: [
        { category: "error-pattern", description: "Common error pattern" },
        { category: "", description: "empty category dropped" },
      ],
    };
    const result = validateLearningContext(input);
    expect(result).toBeDefined();
    expect(result!.patterns).toHaveLength(1);
    expect(result!.patterns![0].category).toBe("error-pattern");
  });

  it("accepts optional metrics and clamps them", () => {
    const input = {
      version: 1,
      facts: [
        { domain: "test", summary: "test", confidence: "high" },
      ],
      metrics: {
        totalTasksCompleted: 10,
        totalProofsPassed: 8,
        totalProofsFailed: -1,
      },
    };
    const result = validateLearningContext(input);
    expect(result).toBeDefined();
    expect(result!.metrics).toBeDefined();
    expect(result!.metrics!.totalTasksCompleted).toBe(10);
    expect(result!.metrics!.totalProofsPassed).toBe(8);
    // Negative values are clamped to 0
    expect(result!.metrics!.totalProofsFailed).toBe(0);
  });

  it("rejects non-finite metric values", () => {
    const input = {
      version: 1,
      facts: [
        { domain: "test", summary: "test", confidence: "high" },
      ],
      metrics: {
        totalTasksCompleted: Infinity,
        totalProofsPassed: NaN,
      },
    };
    const result = validateLearningContext(input);
    expect(result).toBeDefined();
    expect(result!.metrics).toBeUndefined();
  });

  it("preserves only valid facts when mixed with invalid ones", () => {
    const input = {
      version: 1,
      facts: [
        { domain: "valid", summary: "good", confidence: "high" },
        { domain: "", summary: "bad", confidence: "high" },
        { domain: "also-valid", summary: "also-good", confidence: "medium" },
      ],
    };
    const result = validateLearningContext(input);
    expect(result).toBeDefined();
    expect(result!.facts).toHaveLength(2);
    expect(result!.facts[0].domain).toBe("valid");
    expect(result!.facts[1].domain).toBe("also-valid");
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  mergeLearningFacts
// ───────────────────────────────────────────────────────────────────────────

describe("mergeLearningFacts", () => {
  it("returns empty array when both inputs are empty/undefined", () => {
    const result = mergeLearningFacts(undefined, undefined);
    expect(result).toEqual([]);
  });

  it("returns existing facts when learning context is undefined", () => {
    const existing: ContextFact[] = [
      { statement: "existing fact", source: "user", reference: "" },
    ];
    const result = mergeLearningFacts(existing, undefined);
    expect(result).toEqual(existing);
  });

  it("returns existing facts when learning context has no facts", () => {
    const existing: ContextFact[] = [
      { statement: "existing fact", source: "user", reference: "" },
    ];
    const ctx: LearningContextV1 = { version: 1, facts: [] };
    const result = mergeLearningFacts(existing, ctx);
    expect(result).toEqual(existing);
  });

  it("appends learning facts as ContextFact entries with provenance", () => {
    const existing: ContextFact[] = [
      { statement: "user fact", source: "user", reference: "" },
    ];
    const ctx: LearningContextV1 = {
      version: 1,
      facts: [
        { domain: "typescript", summary: "Use branded types", confidence: "high" },
      ],
    };
    const result = mergeLearningFacts(existing, ctx);
    expect(result).toHaveLength(2);
    expect(result[0].statement).toBe("user fact");
    expect(result[1].statement).toBe("[learning] typescript: Use branded types");
    expect(result[1].source).toBe("learning");
    expect(result[1].reference).toBe("pi-learning:active");
  });

  it("includes evidenceDigest in reference when available", () => {
    const ctx: LearningContextV1 = {
      version: 1,
      facts: [
        { domain: "test", summary: "fact with digest", confidence: "high", evidenceDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      ],
    };
    const result = mergeLearningFacts([], ctx);
    expect(result[0].reference).toBe("pi-learning:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("caps total merged chars at 1200 by default", () => {
    const existing: ContextFact[] = [
      { statement: "x".repeat(1000), source: "user", reference: "" },
    ];
    const ctx: LearningContextV1 = {
      version: 1,
      facts: [
        { domain: "a", summary: "y".repeat(500), confidence: "high" },
        { domain: "b", summary: "z".repeat(500), confidence: "high" },
      ],
    };
    const result = mergeLearningFacts(existing, ctx);
    // Learning budget counts only added learning chars; existing context is not charged
    expect(result).toHaveLength(3);
  });

  it("respects custom maxTotalChars", () => {
    const existing: ContextFact[] = [
      { statement: "short", source: "user", reference: "" },
    ];
    const ctx: LearningContextV1 = {
      version: 1,
      facts: [
        { domain: "a", summary: "long " + "x".repeat(200), confidence: "high" },
      ],
    };
    const result = mergeLearningFacts(existing, ctx, 50);
    expect(result).toHaveLength(1);
    expect(result[0].statement).toBe("short");
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  Event payload types — construction and field bounds
// ───────────────────────────────────────────────────────────────────────────

describe("ContextRequestPayloadV1", () => {
  it("can be constructed with required fields", () => {
    const payload: ContextRequestPayloadV1 = makeContextRequestPayload(
      "task-123",
      "general",
      "Implement feature X",
      "corr-123",
    );
    expect(payload.protocolVersion).toBe(1);
    expect(payload.taskId).toBe("task-123");
    expect(payload.agentType).toBe("general");
    expect(payload.description).toBe("Implement feature X");
    expect("response" in payload).toBe(false);
  });

  it("does not carry a mutable response slot", () => {
    const payload = makeContextRequestPayload("task-123", "general", "test");
    expect("response" in payload).toBe(false);
  });
});

describe("ProofVerifiedPayloadV1", () => {
  it("carries proof pass outcome with evidence digests", () => {
    const payload: ProofVerifiedPayloadV1 = {
      protocolVersion: 1,
      taskId: "task-123",
      correlationId: "corr-123",
      verificationPassed: true,
      verificationIssues: [],
      evidenceDigests: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      timestamp: "2026-07-19T00:00:00.000Z",
    };
    expect(payload.verificationPassed).toBe(true);
    expect(payload.verificationIssues).toHaveLength(0);
    expect(payload.evidenceDigests).toHaveLength(2);
    // evidenceBundleDigest was removed — verify it's not present
    expect((payload as any).evidenceBundleDigest).toBeUndefined();
  });

  it("carries proof fail outcome with issues", () => {
    const payload: ProofVerifiedPayloadV1 = {
      protocolVersion: 1,
      taskId: "task-123",
      correlationId: "corr-123",
      verificationPassed: false,
      verificationIssues: ["No evidence provided", "Stale reference"],
      evidenceDigests: [],
      timestamp: "2026-07-19T00:00:00.000Z",
    };
    expect(payload.verificationPassed).toBe(false);
    expect(payload.verificationIssues).toHaveLength(2);
    expect(payload.evidenceDigests).toHaveLength(0);
  });

  it("has readonly array types (compile-time constraint)", () => {
    const payload: ProofVerifiedPayloadV1 = {
      protocolVersion: 1,
      taskId: "task-123",
      correlationId: "corr-123",
      verificationPassed: true,
      verificationIssues: [],
      evidenceDigests: [],
      timestamp: "2026-07-19T00:00:00.000Z",
    };
    // Verify the type annotation is readonly (compile-time check)
    const issuesType: readonly string[] = payload.verificationIssues;
    const digestsType: readonly string[] = payload.evidenceDigests;
    expect(issuesType).toEqual([]);
    expect(digestsType).toEqual([]);
  });
});

describe("ReviewCompletedPayloadV1", () => {
  it("carries review verdict with reviewer identity", () => {
    const payload: ReviewCompletedPayloadV1 = {
      protocolVersion: 1,
      taskId: "task-123",
      correlationId: "corr-123",
      verdict: "accepted",
      reviewerTaskId: "reviewer-456",
      reviewerInvocationId: "invoc-789",
      subjectDigest: "abc123def456",
      timestamp: "2026-07-19T00:00:00.000Z",
    };
    expect(payload.verdict).toBe("accepted");
    expect(payload.reviewerTaskId).toBe("reviewer-456");
    expect(payload.reviewerInvocationId).toBe("invoc-789");
    expect(payload.subjectDigest).toBe("abc123def456");
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  Event name constants
// ───────────────────────────────────────────────────────────────────────────

describe("SUBAGENT_LEARNING_EVENTS_V1", () => {
  it("defines all three event names with v1 prefix", () => {
    expect(SUBAGENT_LEARNING_EVENTS_V1.CONTEXT_REQUEST).toBe("pi-subagents:v1:context-request");
    expect(SUBAGENT_LEARNING_EVENTS_V1.PROOF_VERIFIED).toBe("pi-subagents:v1:proof-verified");
    expect(SUBAGENT_LEARNING_EVENTS_V1.REVIEW_COMPLETED).toBe("pi-subagents:v1:review-completed");
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  clampString / clampIssues
// ───────────────────────────────────────────────────────────────────────────

describe("clampString", () => {
  it("returns empty string for non-string input", () => {
    expect(clampString(undefined as any, 10)).toBe("");
    expect(clampString(null as any, 10)).toBe("");
    expect(clampString(42 as any, 10)).toBe("");
  });

  it("clamps string to maxLength", () => {
    expect(clampString("hello world", 5)).toBe("hello");
  });

  it("returns full string when within maxLength", () => {
    expect(clampString("short", 100)).toBe("short");
  });

  it("redacts long base64-like sequences", () => {
    const longToken = "a".repeat(150);
    const result = clampString(longToken, 200);
    expect(result).toBe("[redacted:150chars]");
  });

  it("does not redact normal long text with spaces", () => {
    const normalText = "a ".repeat(60).trim(); // ~120 chars with spaces
    const result = clampString(normalText, 200);
    expect(result).not.toMatch(/^\[redacted/);
    expect(result.length).toBeLessThanOrEqual(200);
  });
});

describe("clampIssues", () => {
  it("clamps each issue to 500 chars", () => {
    const issues = ["x y ".repeat(300).trim(), "short"];
    const result = clampIssues(issues);
    expect(result).toHaveLength(2);
    expect(result[0].length).toBe(500);
    expect(result[1]).toBe("short");
  });

  it("redacts long token-like issues", () => {
    const issues = ["a".repeat(200)];
    const result = clampIssues(issues);
    expect(result[0]).toBe("[redacted:200chars]");
  });

  it("returns empty array for empty input", () => {
    expect(clampIssues([])).toEqual([]);
  });

  it("bounds issue count to MAX_ISSUES", () => {
    const issues = Array.from({ length: 30 }, (_, i) => `issue ${i}`);
    const result = clampIssues(issues);
    expect(result).toHaveLength(MAX_ISSUES);
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  validateSha256Hex
// ───────────────────────────────────────────────────────────────────────────

describe("validateSha256Hex", () => {
  it("returns undefined for non-string input", () => {
    expect(validateSha256Hex(undefined as any)).toBeUndefined();
    expect(validateSha256Hex(null as any)).toBeUndefined();
    expect(validateSha256Hex(42 as any)).toBeUndefined();
  });

  it("returns undefined for wrong length", () => {
    expect(validateSha256Hex("abc")).toBeUndefined();
    expect(validateSha256Hex("a".repeat(63))).toBeUndefined();
    expect(validateSha256Hex("a".repeat(65))).toBeUndefined();
  });

  it("returns undefined for non-hex characters", () => {
    expect(validateSha256Hex("z" + "0".repeat(63))).toBeUndefined();
    expect(validateSha256Hex("g" + "0".repeat(63))).toBeUndefined();
  });

  it("accepts valid lowercase hex SHA-256", () => {
    const digest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    expect(validateSha256Hex(digest)).toBe(digest);
  });

  it("accepts valid uppercase hex SHA-256", () => {
    const digest = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
    expect(validateSha256Hex(digest)).toBe(digest);
  });

  it("trims whitespace before validating", () => {
    const digest = "  abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789  ";
    expect(validateSha256Hex(digest)).toBe(
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  validateEvidenceDigests
// ───────────────────────────────────────────────────────────────────────────

describe("validateEvidenceDigests", () => {
  it("returns empty array for empty input", () => {
    expect(validateEvidenceDigests([])).toEqual([]);
  });

  it("filters out invalid digests", () => {
    const digests = [
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "invalid",
      "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
    ];
    const result = validateEvidenceDigests(digests);
    expect(result).toHaveLength(2);
  });

  it("bounds to MAX_EVIDENCE_DIGESTS items", () => {
    const digests = Array.from({ length: 100 }, (_, i) =>
      ("0".repeat(63) + i.toString(16).padStart(1, "0")).slice(0, 64),
    );
    const result = validateEvidenceDigests(digests);
    expect(result.length).toBeLessThanOrEqual(MAX_EVIDENCE_DIGESTS);
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  makeContextRequestPayload
// ───────────────────────────────────────────────────────────────────────────

describe("makeContextRequestPayload", () => {
  it("bounds redaction markers and rejects invalid clamp limits", () => {
    const token = "A".repeat(150);
    expect(clampString(token, 500)).toBe("[redacted:150chars]");
    expect(clampString(token, 5)).toBe("[reda");
    expect(clampString(token, 0)).toBe("");
    expect(() => clampString("value", -1)).toThrow(/non-negative safe integer/u);
    expect(() => clampString("value", 1.5)).toThrow(/non-negative safe integer/u);
  });

  it("clamps taskId to MAX_TASK_ID", () => {
    const payload = makeContextRequestPayload(
      "x y ".repeat(100).trim(),
      "general",
      "test description",
    );
    expect(payload.taskId.length).toBe(MAX_TASK_ID);
  });

  it("clamps agentType to MAX_AGENT_TYPE", () => {
    const payload = makeContextRequestPayload(
      "task-1",
      "x y ".repeat(50).trim(),
      "test description",
    );
    expect(payload.agentType.length).toBe(MAX_AGENT_TYPE);
  });

  it("clamps description to MAX_DESCRIPTION and redacts secrets", () => {
    const payload = makeContextRequestPayload(
      "task-1",
      "general",
      "x y ".repeat(200).trim(),
    );
    expect(payload.description.length).toBe(MAX_DESCRIPTION);
  });

  it("redacts long token-like descriptions", () => {
    const payload = makeContextRequestPayload(
      "task-1",
      "general",
      "a".repeat(150),
    );
    expect(payload.description).toBe("[redacted:150chars]");
  });

  it("preserves normal short descriptions", () => {
    const payload = makeContextRequestPayload(
      "task-1",
      "general",
      "Implement feature X",
    );
    expect(payload.description).toBe("Implement feature X");
  });

  it("sets protocolVersion to 1", () => {
    const payload = makeContextRequestPayload("task-1", "general", "desc");
    expect(payload.protocolVersion).toBe(1);
  });

  it("does not set response field", () => {
    const payload = makeContextRequestPayload("task-1", "general", "desc");
    expect("response" in payload).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  makeProofVerifiedPayload
// ───────────────────────────────────────────────────────────────────────────

describe("makeProofVerifiedPayload", () => {
  it("clamps taskId", () => {
    const payload = makeProofVerifiedPayload(
      "x y ".repeat(100).trim(),
      true,
      [],
      [],
    );
    expect(payload.taskId.length).toBe(MAX_TASK_ID);
  });

  it("carries verificationPassed", () => {
    const pass = makeProofVerifiedPayload("t1", true, [], []);
    expect(pass.verificationPassed).toBe(true);

    const fail = makeProofVerifiedPayload("t1", false, [], []);
    expect(fail.verificationPassed).toBe(false);
  });

  it("clamps and bounds issues", () => {
    const issues = Array.from({ length: 30 }, (_, i) => `issue ${i}`);
    const payload = makeProofVerifiedPayload("t1", false, issues, []);
    expect(payload.verificationIssues.length).toBeLessThanOrEqual(MAX_ISSUES);
  });

  it("validates evidence digests", () => {
    const digests = [
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "invalid",
    ];
    const payload = makeProofVerifiedPayload("t1", true, [], digests);
    expect(payload.evidenceDigests).toHaveLength(1);
  });

  it("sets timestamp to ISO string", () => {
    const payload = makeProofVerifiedPayload("t1", true, [], []);
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("sets protocolVersion to 1", () => {
    const payload = makeProofVerifiedPayload("t1", true, [], []);
    expect(payload.protocolVersion).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  makeReviewCompletedPayload
// ───────────────────────────────────────────────────────────────────────────

describe("makeReviewCompletedPayload", () => {
  it("clamps taskId", () => {
    const payload = makeReviewCompletedPayload(
      "x y ".repeat(100).trim(),
      "accepted",
      "reviewer-1",
      "invoc-1",
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    expect(payload.taskId.length).toBe(MAX_TASK_ID);
  });

  it("clamps verdict to MAX_VERDICT", () => {
    const payload = makeReviewCompletedPayload(
      "t1",
      "x y ".repeat(200).trim(),
      "reviewer-1",
      "invoc-1",
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    expect(payload.verdict.length).toBe(MAX_VERDICT);
  });

  it("clamps reviewerTaskId to MAX_ID", () => {
    const payload = makeReviewCompletedPayload(
      "t1",
      "accepted",
      "x y ".repeat(100).trim(),
      "invoc-1",
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    expect(payload.reviewerTaskId.length).toBe(MAX_ID);
  });

  it("clamps reviewerInvocationId to MAX_ID", () => {
    const payload = makeReviewCompletedPayload(
      "t1",
      "accepted",
      "reviewer-1",
      "x y ".repeat(100).trim(),
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    expect(payload.reviewerInvocationId.length).toBe(MAX_ID);
  });

  it("validates subjectDigest as SHA-256 hex", () => {
    const validDigest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const payload = makeReviewCompletedPayload(
      "t1", "accepted", "r1", "i1", validDigest,
    );
    expect(payload.subjectDigest).toBe(validDigest);
  });

  it("sets subjectDigest to empty string for invalid digest", () => {
    const payload = makeReviewCompletedPayload(
      "t1", "accepted", "r1", "i1", "invalid-digest",
    );
    expect(payload.subjectDigest).toBe("");
  });

  it("sets timestamp to ISO string", () => {
    const payload = makeReviewCompletedPayload(
      "t1", "accepted", "r1", "i1",
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("sets protocolVersion to 1", () => {
    const payload = makeReviewCompletedPayload(
      "t1", "accepted", "r1", "i1",
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
    expect(payload.protocolVersion).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
//  Content privacy — no raw transcripts or secrets in events
// ───────────────────────────────────────────────────────────────────────────

describe("content privacy", () => {
  it("LearningContextV1 type has no transcript field", () => {
    const ctx: LearningContextV1 = {
      version: 1,
      facts: [
        { domain: "test", summary: "test", confidence: "high" },
      ],
    };
    const keys = Object.keys(ctx);
    expect(keys).not.toContain("transcript");
    expect(keys).toContain("version");
    expect(keys).toContain("facts");
  });

  it("ProofVerifiedPayloadV1 type has no rawOutput field", () => {
    const payload: ProofVerifiedPayloadV1 = {
      protocolVersion: 1,
      taskId: "task-123",
      correlationId: "corr-123",
      verificationPassed: true,
      verificationIssues: [],
      evidenceDigests: [],
      timestamp: "2026-07-19T00:00:00.000Z",
    };
    const keys = Object.keys(payload);
    expect(keys).not.toContain("rawOutput");
    expect(keys).toContain("protocolVersion");
    expect(keys).toContain("taskId");
  });

  it("ReviewCompletedPayloadV1 type has no secrets field", () => {
    const payload: ReviewCompletedPayloadV1 = {
      protocolVersion: 1,
      taskId: "task-123",
      correlationId: "corr-123",
      verdict: "accepted",
      reviewerTaskId: "reviewer-456",
      reviewerInvocationId: "invoc-789",
      subjectDigest: "abc123def456",
      timestamp: "2026-07-19T00:00:00.000Z",
    };
    const keys = Object.keys(payload);
    expect(keys).not.toContain("apiKey");
    expect(keys).not.toContain("secret");
    expect(keys).toContain("verdict");
  });
});
