import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateEvidenceOnlyProof } from "../src/orchestration/proof.ts";
import type { ContextEvidence } from "../src/orchestration/context.ts";

const temporaryDirectories: string[] = [];
const NOW = new Date("2026-07-19T00:10:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runtimeReceipt(
  projectDirectory: string,
  claim?: string,
): Promise<ContextEvidence> {
  const contents = "runtime-owned command output\n";
  await writeFile(join(projectDirectory, "receipt.json"), contents);
  const sha256 = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
  return {
    description: "Runtime-observed command",
    reference: "receipt.json",
    recordedAt: "2026-07-19T00:09:00.000Z",
    source: "runtime-receipt",
    receiptId: "observation-1",
    sha256,
    receiptKind: "test",
    exitCode: 0,
    command: "npm test",
    cwd: projectDirectory,
    toolCallId: "tool-1",
    sessionDigest: `sha256:${"a".repeat(64)}`,
    ...(claim ? { claim } : {}),
  };
}

describe("semantic claim substantiation", () => {
  it("does not treat session self-report or text overlap as semantic proof", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "pi-proof-"));
    temporaryDirectories.push(projectDirectory);
    await writeFile(
      join(projectDirectory, "self-report.txt"),
      "authentication middleware authentication middleware\n",
    );
    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [{
        description: "Child says auth is fixed",
        reference: "self-report.txt",
        recordedAt: "2026-07-19T00:09:00.000Z",
        source: "runtime-session",
        claim: "Implement authentication middleware",
      }],
      claims: ["Implement authentication middleware"],
      now: NOW,
      maxEvidenceAgeMs: 10 * 60_000,
    });
    expect(result.valid).toBe(false);
    expect(result.receiptIntegrityValid).toBe(false);
    expect(result.semanticProofValid).toBe(false);
  });

  it("does not auto-pass tokenless claims or directory references", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "pi-proof-"));
    temporaryDirectories.push(projectDirectory);
    const receipt = await runtimeReceipt(projectDirectory, "!!!");
    receipt.reference = ".";
    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [receipt],
      claims: ["!!!"],
      now: NOW,
      maxEvidenceAgeMs: 10 * 60_000,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.join(" ")).toMatch(/not a file|no verifier-bound/u);
  });

  it("requires an exact verifier-created binding for the exact claim and receipt", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "pi-proof-"));
    temporaryDirectories.push(projectDirectory);
    const claim = "Implement authentication middleware";
    const receipt = await runtimeReceipt(projectDirectory, claim);
    const subjectDigest = "sha256:" + "f".repeat(64);
    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [receipt],
      claims: [claim],
      subjectDigest,
      semanticAttestations: [{
        claim,
        receiptId: receipt.receiptId!,
        artifactDigest: receipt.sha256!,
        reviewerTaskId: "reviewer",
        reviewerInvocationId: "reviewer-invocation",
        reviewerOutputDigest: "sha256:" + "e".repeat(64),
        subjectDigest,
        attestedAt: NOW.toISOString(),
      }],
      now: NOW,
      maxEvidenceAgeMs: 10 * 60_000,
    });
    expect(result).toMatchObject({
      valid: true,
      receiptIntegrityValid: true,
      semanticProofValid: true,
      issues: [],
    });
  });

  it("rejects replaying a valid binding onto a different claim or digest", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "pi-proof-"));
    temporaryDirectories.push(projectDirectory);
    const receipt = await runtimeReceipt(projectDirectory, "Claim B");
    const subjectDigest = "sha256:" + "f".repeat(64);
    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [receipt],
      claims: ["Claim B"],
      subjectDigest,
      semanticAttestations: [{
        claim: "Claim A",
        receiptId: receipt.receiptId!,
        artifactDigest: receipt.sha256!,
        reviewerTaskId: "reviewer",
        reviewerInvocationId: "reviewer-invocation",
        reviewerOutputDigest: "sha256:" + "e".repeat(64),
        subjectDigest,
        attestedAt: NOW.toISOString(),
      }],
      now: NOW,
      maxEvidenceAgeMs: 10 * 60_000,
    });
    expect(result.semanticProofValid).toBe(false);
    expect(result.issues).toContain(
      "Claim has no verifier-bound semantic proof: Claim B",
    );
  });
});
