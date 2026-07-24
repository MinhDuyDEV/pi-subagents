import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateEvidenceOnlyProof } from "../src/orchestration/proof.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-substantiation-"));
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

const NOW = "2026-07-19T00:10:00.000Z";
const RECENT = "2026-07-19T00:09:00.000Z";

describe("claim substantiation", () => {
  it("accepts a claim with bound evidence whose file overlaps the claim", async () => {
    const projectDirectory = await createTemporaryProject();
    await mkdir(join(projectDirectory, "src"), { recursive: true });
    await writeFile(
      join(projectDirectory, "src", "auth.ts"),
      "export function authenticationMiddleware() {}",
      "utf8",
    );

    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [
        {
          description: "Added the auth middleware",
          reference: "src/auth.ts",
          recordedAt: RECENT,
          source: "runtime-session",
          claim: "Implement authentication middleware",
        },
      ],
      claims: ["Implement authentication middleware"],
      now: new Date(NOW),
      maxEvidenceAgeMs: 10 * 60 * 1_000,
    });

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("rejects a claim with no bound evidence", async () => {
    const projectDirectory = await createTemporaryProject();
    await mkdir(join(projectDirectory, "artifacts"), { recursive: true });
    await writeFile(
      join(projectDirectory, "artifacts", "test.txt"),
      "all tests passed\n",
      "utf8",
    );

    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [
        {
          description: "Ran the focused suite",
          reference: "artifacts/test.txt",
          recordedAt: RECENT,
          source: "runtime-session",
          claim: "Ran the focused test suite",
        },
      ],
      claims: ["Deploy service to production"],
      now: new Date(NOW),
      maxEvidenceAgeMs: 10 * 60 * 1_000,
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain(
      "Claim has no bound evidence: Deploy service to production",
    );
  });

  it("rejects a claim whose bound evidence file has no token overlap", async () => {
    const projectDirectory = await createTemporaryProject();
    await mkdir(join(projectDirectory, "src"), { recursive: true });
    await writeFile(
      join(projectDirectory, "src", "index.ts"),
      "console.log('done');\n",
      "utf8",
    );

    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [
        {
          description: "Touched the index file",
          reference: "src/index.ts",
          recordedAt: RECENT,
          source: "runtime-session",
          claim: "Refactored authentication module",
        },
      ],
      claims: ["Refactored authentication module"],
      now: new Date(NOW),
      maxEvidenceAgeMs: 10 * 60 * 1_000,
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain(
      "Evidence does not substantiate claim: Refactored authentication module (no overlap in src/index.ts)",
    );
  });

  it("skips substantiation when no claims are declared", async () => {
    const projectDirectory = await createTemporaryProject();
    await mkdir(join(projectDirectory, "artifacts"), { recursive: true });
    await writeFile(
      join(projectDirectory, "artifacts", "test.txt"),
      "4 tests passed\n",
      "utf8",
    );

    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [
        {
          description: "Focused test passed",
          reference: "artifacts/test.txt",
          recordedAt: RECENT,
          source: "runtime-session",
        },
      ],
      now: new Date(NOW),
      maxEvidenceAgeMs: 10 * 60 * 1_000,
    });

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("binds evidence via case-insensitive contains when no exact match exists", async () => {
    const projectDirectory = await createTemporaryProject();
    await mkdir(join(projectDirectory, "src"), { recursive: true });
    await writeFile(
      join(projectDirectory, "src", "auth.ts"),
      "export const authenticationMiddleware = true;\n",
      "utf8",
    );

    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [
        {
          description: "Added the auth middleware",
          reference: "src/auth.ts",
          recordedAt: RECENT,
          source: "runtime-session",
          claim: "Auth Middleware Implementation",
        },
      ],
      claims: ["auth middleware"],
      now: new Date(NOW),
      maxEvidenceAgeMs: 10 * 60 * 1_000,
    });

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("skips the overlap check for non-file references", async () => {
    const projectDirectory = await createTemporaryProject();
    await mkdir(join(projectDirectory, "artifacts"), { recursive: true });
    await writeFile(
      join(projectDirectory, "artifacts", "output.txt"),
      "command output snapshot\n",
      "utf8",
    );

    const result = await validateEvidenceOnlyProof({
      projectDirectory,
      evidence: [
        {
          description: "Build artifacts produced",
          reference: "artifacts",
          recordedAt: RECENT,
          source: "runtime-session",
          claim: "Project builds cleanly",
        },
      ],
      claims: ["Project builds cleanly"],
      now: new Date(NOW),
      maxEvidenceAgeMs: 10 * 60 * 1_000,
    });

    // directory references pass validateReference but are not files, so the
    // token-overlap check is skipped and the bound claim is accepted.
    expect(result).toEqual({ valid: true, issues: [] });
  });
});