import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateEvidenceOnlyProof } from "../src/orchestration/proof.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-harness-proof-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("evidence-only review", () => {
  it("rejects a completion claim with no evidence", async () => {
    const projectDirectory = await createTemporaryProject();
    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [],
      now: new Date("2026-07-19T00:10:00.000Z"),
      maxEvidenceAgeMs: 10 * 60 * 1_000,
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("No completion evidence was provided.");
  });

  it("rejects stale or missing evidence references", async () => {
    const projectDirectory = await createTemporaryProject();
    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [
        {
          description: "Old test output",
          reference: "artifacts/missing.txt",
          recordedAt: "2026-07-18T23:00:00.000Z",
          source: "runtime-session",
        },
      ],
      now: new Date("2026-07-19T00:10:00.000Z"),
      maxEvidenceAgeMs: 10 * 60 * 1_000,
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain(
      "Evidence is stale: artifacts/missing.txt (4200000ms old).",
    );
    expect(result.issues).toContain(
      "Evidence reference does not exist: artifacts/missing.txt.",
    );
  });

  it("rejects command-only evidence without captured output", async () => {
    const projectDirectory = await createTemporaryProject();
    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [
        {
          description: "npm test passed",
          reference: "command:npm test",
          recordedAt: "2026-07-19T00:09:00.000Z",
          source: "runtime-session",
        },
      ],
      now: new Date("2026-07-19T00:10:00.000Z"),
      maxEvidenceAgeMs: 10 * 60 * 1_000,
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain(
      "Command evidence has no captured output reference: command:npm test.",
    );
  });

  it("rejects self-declared evidence even when the artifact exists", async () => {
    const projectDirectory = await createTemporaryProject();
    const artifact = join(projectDirectory, "declared.txt");
    await writeFile(artifact, "claimed pass", "utf8");
    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [
        {
          description: "Self-authored claim",
          reference: "declared.txt",
          recordedAt: "2026-07-19T00:09:00.000Z",
          source: "declared",
        },
      ],
      now: new Date("2026-07-19T00:10:00.000Z"),
      maxEvidenceAgeMs: 5 * 60_000,
    });
    expect(result.valid).toBe(false);
    expect(result.issues).toContain(
      "Evidence lacks a runtime-generated receipt: declared.txt.",
    );
  });

  it("accepts a fresh runtime-observed zero-exit command receipt", async () => {
    const projectDirectory = await createTemporaryProject();
    const evidencePath = join(projectDirectory, "artifacts", "focused-test.txt");
    await mkdir(join(projectDirectory, "artifacts"), { recursive: true });
    await writeFile(evidencePath, "4 tests passed\n", "utf8");
    const digest = `sha256:${createHash("sha256")
      .update("4 tests passed\n")
      .digest("hex")}`;

    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [
        {
          description: "Focused test passed",
          reference: "artifacts/focused-test.txt",
          recordedAt: "2026-07-19T00:09:00.000Z",
          source: "runtime-receipt",
          receiptId: "observation-tool-1",
          sha256: digest,
          receiptKind: "test",
          exitCode: 0,
          command: "npm test",
          cwd: projectDirectory,
          toolCallId: "tool-1",
          sessionDigest: `sha256:${"a".repeat(64)}`,
        },
      ],
      now: new Date("2026-07-19T00:10:00.000Z"),
      maxEvidenceAgeMs: 10 * 60 * 1_000,
    });

    expect(result).toEqual({
      valid: true,
      receiptIntegrityValid: true,
      semanticProofValid: true,
      issues: [],
      supportedClaims: [],
    });
  });

  it("rejects a forged receipt whose artifact changed", async () => {
    const projectDirectory = await createTemporaryProject();
    await writeFile(join(projectDirectory, "receipt.json"), "tampered\n");
    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [{
        description: "Forged command receipt",
        reference: "receipt.json",
        recordedAt: "2026-07-19T00:09:00.000Z",
        source: "runtime-receipt",
        receiptId: "observation-forged",
        sha256: `sha256:${"b".repeat(64)}`,
        receiptKind: "test",
        exitCode: 0,
        command: "npm test",
        cwd: projectDirectory,
        toolCallId: "tool-forged",
        sessionDigest: `sha256:${"c".repeat(64)}`,
      }],
      now: new Date("2026-07-19T00:10:00.000Z"),
      maxEvidenceAgeMs: 10 * 60_000,
    });
    expect(result.receiptIntegrityValid).toBe(false);
    expect(result.issues.join(" ")).toMatch(/changed after receipt/u);
  });
});
