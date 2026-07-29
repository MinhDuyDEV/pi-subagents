import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildContextPack } from "../src/orchestration/context.js";
import { parseOrchestrationRequest } from "../src/orchestration/contract.js";
import { validateEvidenceOnlyProof } from "../src/orchestration/proof.js";
import { createDurableRun } from "../src/orchestration/run-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const DIGEST = `sha256:v1:${"a".repeat(64)}`;
const MODULE_PATH = "../src/events.js";

type ClaimApi = {
  makeLearningClaim(value: unknown): {
    claimId: string;
    statement: string;
  };
  makeLearningClaimIntent(value: unknown): {
    version: 2;
    claimId: string;
    statement: string;
    applicability: string;
  };
  makeContextRequestPayload(
    taskId: string,
    agentType: string,
    description: string,
    correlationId: string,
    learningClaims?: readonly unknown[],
  ): { description: string; requestDigest: string; learningClaims: readonly unknown[] };
  makeContextRequestPayloadV2(
    taskId: string,
    agentType: string,
    description: string,
    correlationId: string,
    learningIntents?: readonly unknown[],
  ): { description: string; requestDigest: string; learningIntents: readonly unknown[] };
  makeProofVerifiedPayload(
    taskId: string,
    passed: boolean,
    issues: readonly string[],
    evidenceDigests: readonly string[],
    correlationId: string,
    details?: { requestDigest: string; supportedClaims: readonly unknown[] },
  ): { requestDigest: string; supportedClaims: readonly unknown[] };
};

async function api(): Promise<ClaimApi> {
  return import(MODULE_PATH) as Promise<ClaimApi>;
}

function rawClaim(): Record<string, unknown> {
  return {
    version: 1,
    kind: "pattern",
    statement: "Run focused parser tests before the complete suite",
    applicability: "Parser changes",
    support: {
      mode: "task-outcome",
      evidenceRefs: [{
        kind: "evidence-receipt",
        ref: "receipt-1",
        digest: DIGEST,
      }],
    },
  };
}

describe("Phase 5 explicit learning claims", () => {
  it("does not derive a learning claim from task description", async () => {
    const events = await api();
    const request = events.makeContextRequestPayload(
      "task-1",
      "general",
      "Fix the parser",
      "correlation-1",
    );
    expect(request.description).toBe("Fix the parser");
    expect(request.learningClaims).toEqual([]);
    expect(request.requestDigest).toMatch(/^sha256:v1:[a-f0-9]{64}$/);
  });

  it("constructs a canonical claim with claim-specific evidence", async () => {
    const events = await api();
    const claim = events.makeLearningClaim(rawClaim());
    expect(claim.claimId).toMatch(/^sha256:v1:[a-f0-9]{64}$/);
    expect(claim.statement).toBe("Run focused parser tests before the complete suite");
  });

  it("reports per-claim support bound to the request digest", async () => {
    const events = await api();
    const claim = events.makeLearningClaim(rawClaim());
    const request = events.makeContextRequestPayload(
      "task-1",
      "general",
      "Fix the parser",
      "correlation-1",
      [claim],
    );
    const proof = events.makeProofVerifiedPayload(
      "task-1",
      true,
      [],
      ["a".repeat(64)],
      "correlation-1",
      {
        requestDigest: request.requestDigest,
        supportedClaims: [{
          claimId: claim.claimId,
          supported: true,
          evidenceDigests: [DIGEST],
        }],
      },
    );
    expect(proof.requestDigest).toBe(request.requestDigest);
    expect(proof.supportedClaims).toEqual([expect.objectContaining({ claimId: claim.claimId, supported: true })]);
  });

  it("exports the producer protocol through a public package subpath", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, unknown> };
    expect(manifest.exports?.["./events"]).toBeDefined();
    expect(manifest.exports?.["./replay"]).toBeDefined();
  });

  it("keeps explicit learning claims separate from free-form context claims", async () => {
    const events = await api();
    const claim = events.makeLearningClaim(rawClaim());
    const parsed = parseOrchestrationRequest({
      context: {
        goal: "Verify a bounded claim",
        authorization: "read-only",
        claims: ["free-form orchestration assertion"],
        learning_claims: [claim],
        next_step: "Return proof",
      },
    });

    expect(parsed.context?.claims).toEqual(["free-form orchestration assertion"]);
    expect((parsed.context as { learningClaims?: unknown[] }).learningClaims).toEqual([claim]);

    const contextPack = await buildContextPack({
      projectDirectory: process.cwd(),
      input: parsed.context!,
    });
    const durableRun = createDurableRun({
      invocationId: "invocation-phase5",
      projectDirectory: process.cwd(),
      contextPack,
    });

    expect(contextPack.claims).toEqual(["free-form orchestration assertion"]);
    expect((contextPack as { learningClaims?: unknown[] }).learningClaims).toEqual([claim]);
    expect((durableRun.contextPack as { learningClaims?: unknown[] }).learningClaims).toEqual([
      claim,
    ]);
  });

  it("supports a learning claim only from evidence named by that claim", async () => {
    const events = await api();
    const directory = await mkdtemp(join(tmpdir(), "pi-subagents-phase5-proof-"));
    temporaryDirectories.push(directory);
    const namedReference = "named-evidence.txt";
    const unrelatedReference = "unrelated-evidence.txt";
    const namedContents = "run focused parser tests before the complete suite";
    const unrelatedContents = "unrelated output contains forbidden shortcut evidence";
    await writeFile(join(directory, namedReference), namedContents, "utf8");
    await writeFile(join(directory, unrelatedReference), unrelatedContents, "utf8");
    const namedDigest = `sha256:v1:${createHash("sha256").update(namedContents).digest("hex")}`;
    const supportedClaim = events.makeLearningClaim({
      ...rawClaim(),
      support: {
        mode: "task-outcome",
        evidenceRefs: [{ kind: "evidence-receipt", ref: namedReference, digest: namedDigest }],
      },
    });
    const unsupportedClaim = events.makeLearningClaim({
      ...rawClaim(),
      statement: "forbidden shortcut evidence",
      support: {
        mode: "task-outcome",
        evidenceRefs: [{ kind: "evidence-receipt", ref: namedReference, digest: namedDigest }],
      },
    });
    const now = new Date("2026-03-20T10:00:00.000Z");
    const namedArtifactDigest = `sha256:${createHash("sha256")
      .update(namedContents)
      .digest("hex")}`;
    const subjectDigest = `sha256:${"f".repeat(64)}`;
    const result = await validateEvidenceOnlyProof({
      projectDirectory: directory,
      evidence: [
        {
          description: "Named claim evidence",
          reference: namedReference,
          recordedAt: now.toISOString(),
          source: "runtime-receipt",
          receiptId: "receipt-1",
          sha256: namedArtifactDigest,
          receiptKind: "test",
          exitCode: 0,
          command: "npm test",
          cwd: directory,
          toolCallId: "tool-1",
          sessionDigest: `sha256:${"b".repeat(64)}`,
        },
        {
          description: "Unrelated evidence that must not support the claim",
          reference: unrelatedReference,
          recordedAt: now.toISOString(),
          source: "declared",
        },
      ],
      learningClaims: [supportedClaim, unsupportedClaim],
      maxEvidenceAgeMs: 60_000,
      now,
      subjectDigest,
      semanticAttestations: [{
        claim: supportedClaim.statement,
        receiptId: "receipt-1",
        artifactDigest: namedArtifactDigest,
        reviewerTaskId: "reviewer-task",
        reviewerInvocationId: "reviewer-invocation",
        reviewerOutputDigest: `sha256:${"c".repeat(64)}`,
        subjectDigest,
        attestedAt: now.toISOString(),
      }],
    } as Parameters<typeof validateEvidenceOnlyProof>[0] & { learningClaims: unknown[] });

    expect((result as { supportedClaims?: unknown[] }).supportedClaims).toEqual([
      {
        claimId: supportedClaim.claimId,
        supported: true,
        evidenceDigests: [namedDigest],
      },
      {
        claimId: unsupportedClaim.claimId,
        supported: false,
        evidenceDigests: [],
      },
    ]);
  });

  it("accepts a V2 launch intent and binds runtime evidence only after reviewer attestation", async () => {
    const parsed = parseOrchestrationRequest({
      context: {
        goal: "Verify a bounded intent",
        authorization: "read-only",
        learning_claims: [{
          version: 2,
          kind: "pattern",
          statement: "Use completion-bound runtime evidence",
          applicability: "Verified orchestration tasks",
        }],
        next_step: "Return proof",
      },
    });
    const intent = parsed.context?.learningClaims[0];
    expect(intent?.version).toBe(2);
    expect(intent?.claimId).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
    if (!intent || intent.version !== 2) throw new Error("expected V2 learning intent");

    const directory = await mkdtemp(join(tmpdir(), "pi-subagents-intent-"));
    temporaryDirectories.push(directory);
    const artifactPath = join(directory, "runtime-intent.json");
    const contents = "verified completion output\n";
    await writeFile(artifactPath, contents, "utf8");
    const rawDigest = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
    const subjectDigest = `sha256:${"e".repeat(64)}`;
    const now = new Date("2026-08-06T00:00:00.000Z");
    const result = await validateEvidenceOnlyProof({
      projectDirectory: directory,
      evidence: [{
        description: "runtime observed completion",
        reference: "runtime-intent.json",
        recordedAt: now.toISOString(),
        receiptId: "observation-intent",
        sha256: rawDigest,
        source: "runtime-receipt",
        receiptKind: "command-output",
        exitCode: 0,
        command: "npm test",
        cwd: directory,
        toolCallId: "tool-intent",
        sessionDigest: `sha256:v1:${"a".repeat(64)}`,
      }],
      learningClaims: [intent],
      now,
      maxEvidenceAgeMs: 60_000,
      subjectDigest,
      semanticAttestations: [{
        claim: intent.statement,
        claimId: intent.claimId,
        receiptId: "observation-intent",
        artifactDigest: rawDigest,
        reviewerTaskId: "reviewer-intent",
        reviewerInvocationId: "reviewer-invocation",
        subjectDigest,
        attestedAt: now.toISOString(),
      }],
    });

    expect(result.valid).toBe(true);
    expect(result.supportedClaims).toEqual([{
      claimId: intent.claimId,
      supported: true,
      evidenceDigests: [`sha256:v1:${createHash("sha256").update(contents).digest("hex")}`],
    }]);

    const unbound = await validateEvidenceOnlyProof({
      projectDirectory: directory,
      evidence: [{
        description: "runtime observed completion",
        reference: "runtime-intent.json",
        recordedAt: now.toISOString(),
        receiptId: "observation-intent",
        sha256: rawDigest,
        source: "runtime-receipt",
        receiptKind: "command-output",
        exitCode: 0,
        command: "npm test",
        cwd: directory,
        toolCallId: "tool-intent",
        sessionDigest: `sha256:v1:${"a".repeat(64)}`,
      }],
      learningClaims: [intent],
      now,
      maxEvidenceAgeMs: 60_000,
      subjectDigest,
      semanticAttestations: [{
        claim: intent.statement,
        receiptId: "observation-intent",
        artifactDigest: rawDigest,
        reviewerTaskId: "reviewer-intent",
        reviewerInvocationId: "reviewer-invocation",
        subjectDigest,
        attestedAt: now.toISOString(),
      }],
    });
    expect(unbound.supportedClaims[0]).toMatchObject({ supported: false });
  });

  it("rejects mixed V1 claims and V2 intents at the task boundary", async () => {
    const { makeLearningClaim, makeLearningClaimIntent } = await import(
      "../src/learning-contract.js",
    ) as ClaimApi;
    const v1 = makeLearningClaim({
      version: 1,
      kind: "pattern",
      statement: "V1",
      applicability: "compatibility",
      support: {
        mode: "direct-artifact",
        evidenceRefs: [{
          kind: "repository-file",
          ref: "evidence.txt",
          digest: `sha256:v1:${"b".repeat(64)}`,
        }],
      },
    });
    const v2 = makeLearningClaimIntent({
      version: 2,
      kind: "pattern",
      statement: "V2",
      applicability: "completion evidence",
    });
    expect(() => parseOrchestrationRequest({
      context: {
        goal: "Reject mixed claims",
        authorization: "read-only",
        learning_claims: [v1, v2],
        next_step: "Stop",
      },
    })).toThrow(/one protocol version/);
  });
});
