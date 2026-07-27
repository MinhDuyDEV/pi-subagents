import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildContextPack,
  loadContextPack,
  renderContextPackForPrompt,
  saveContextPack,
  updateContextHandoff,
} from "../src/orchestration/context.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-harness-context-"));
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

describe("Context Pack and Handoff", () => {
  it("records project-local reference hashes without copying file contents", async () => {
    const projectDirectory = await createTemporaryProject();
    const referencePath = join(projectDirectory, "src", "contract.ts");
    const referenceContent = "export const contractVersion = 1;\n";
    await mkdir(join(projectDirectory, "src"), { recursive: true });
    await writeFile(referencePath, referenceContent, "utf8");

    const pack = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Repair task lifecycle parity",
        authorization: "write-approved",
        knownFacts: [
          {
            statement: "The task session is nested below the task ID directory.",
            source: "repository",
            reference: "src/contract.ts",
          },
        ],
        references: [{ path: "src/contract.ts" }],
        nextStep: "Write the failing resume test.",
      },
      now: new Date("2026-07-19T00:00:00.000Z"),
    });

    const expectedDigest = createHash("sha256")
      .update(referenceContent)
      .digest("hex");
    expect(pack.references).toEqual([
      {
        path: "src/contract.ts",
        digest: `sha256:${expectedDigest}`,
      },
    ]);
    expect(JSON.stringify(pack)).not.toContain(referenceContent.trim());
  });

  it("redacts likely credentials from persisted context", async () => {
    const projectDirectory = await createTemporaryProject();
    const pack = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Use api_key=super-secret-value and github_pat_exampleFineGrainedCredentialValue without persisting them",
        authorization: "sensitive-approved",
        knownFacts: [
          {
            statement: "Observed token sk-example-secret-token-value",
            source: "user",
          },
        ],
        nextStep: "Continue with ghp_exampleSecretCredentialValue",
      },
    });

    const serialized = JSON.stringify(pack);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("sk-example-secret-token-value");
    expect(serialized).not.toContain("ghp_exampleSecretCredentialValue");
    expect(serialized).not.toContain("github_pat_exampleFineGrainedCredentialValue");
    expect(serialized).toContain("[REDACTED]");
  });

  it("renders provenance, unknowns, decisions, evidence, and next step", async () => {
    const projectDirectory = await createTemporaryProject();
    const pack = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Resume safely",
        authorization: "read-only",
        knownFacts: [{ statement: "Current disk wins.", source: "repository" }],
        unknowns: ["Whether the upstream registry is populated."],
        decisions: [{
          statement: "Use a thin wrapper.",
          rationale: "Avoid a fork.",
          unlockCondition: "A measured cold-start regression exceeds 10%.",
        }],
        evidence: [
          {
            description: "Focused lifecycle test failed before implementation.",
            reference: "package/tests/orchestration-lifecycle.test.ts",
            recordedAt: "2026-07-19T00:00:00.000Z",
          },
        ],
        nextStep: "Resolve the nested session.",
      },
    });

    const rendered = renderContextPackForPrompt(pack);
    expect(rendered).toContain("[repository] Current disk wins.");
    expect(rendered).toContain("Unknown: Whether the upstream registry is populated.");
    expect(rendered).toContain(
      "Decision: Use a thin wrapper. — Avoid a fork. (unlock if: A measured cold-start regression exceeds 10%.)",
    );
    expect(rendered).toContain("Evidence: Focused lifecycle test failed");
    expect(rendered).toContain(
      "Suggested entry point (optional, non-binding): Resolve the nested session.",
    );
  });

  it("keeps acceptance claims out of the child-visible prompt (anti-Goodhart)", async () => {
    const projectDirectory = await createTemporaryProject();
    const pack = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Fix the auth race",
        authorization: "write-approved",
        claims: [
          "The authentication race is fixed",
          "The focused auth tests pass",
        ],
        nextStep: "Reproduce the failing test",
      },
    });

    // The claims stay in the data model for the verifier-side proof gate…
    expect(pack.claims).toEqual([
      "The authentication race is fixed",
      "The focused auth tests pass",
    ]);

    // …but the child never sees the strings it will be graded against.
    const rendered = renderContextPackForPrompt(pack);
    expect(rendered).not.toContain("Claims to prove");
    expect(rendered).not.toContain("The authentication race is fixed");
    expect(rendered).not.toContain("The focused auth tests pass");
  });

  it("seals facts and decisions behind the blind-first block, after goal and frontier", async () => {
    const projectDirectory = await createTemporaryProject();
    const pack = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Fix the auth race",
        authorization: "write-approved",
        knownFacts: [{ statement: "Current disk wins.", source: "repository" }],
        unknowns: ["Which lock ordering is correct."],
        decisions: [{ statement: "Keep the public API stable.", rationale: "Compatibility" }],
        nextStep: "Reproduce the failing test",
      },
    });

    const rendered = renderContextPackForPrompt(pack, { disclosure: "blind-first" });
    const sealedHeading =
      "### Sealed context — open AFTER you have written your own 5-line read of the problem";
    expect(rendered).toContain(sealedHeading);

    const sealedAt = rendered.indexOf(sealedHeading);
    expect(rendered.indexOf("Goal: Fix the auth race")).toBeLessThan(sealedAt);
    expect(rendered.indexOf("Authorization: write-approved")).toBeLessThan(sealedAt);
    expect(rendered.indexOf("Unknown: Which lock ordering is correct.")).toBeLessThan(sealedAt);
    expect(
      rendered.indexOf("Suggested entry point (optional, non-binding):"),
    ).toBeLessThan(sealedAt);

    // Facts and decisions appear only inside the sealed block.
    expect(rendered.indexOf("Fact: [repository] Current disk wins.")).toBeGreaterThan(sealedAt);
    expect(
      rendered.indexOf("Decision: Keep the public API stable. — Compatibility"),
    ).toBeGreaterThan(sealedAt);

    // Default disclosure keeps the existing inline behavior.
    const open = renderContextPackForPrompt(pack);
    expect(open).not.toContain(sealedHeading);
    expect(open.indexOf("Fact: [repository] Current disk wins.")).toBeLessThan(
      open.indexOf("Suggested entry point"),
    );
  });

  it("serializes concurrent handoff updates without losing decisions", async () => {
    const projectDirectory = await createTemporaryProject();
    const storeDirectory = join(projectDirectory, ".pi", "artifacts", "tasks", "contexts");
    const pack = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Preserve concurrent handoffs",
        authorization: "write-approved",
        nextStep: "Update twice.",
      },
    });
    await saveContextPack({ storeDirectory, key: "task-concurrent", pack });

    await Promise.all([
      updateContextHandoff({
        storeDirectory,
        key: "task-concurrent",
        patch: { decisions: [{ statement: "Decision A" }] },
      }),
      updateContextHandoff({
        storeDirectory,
        key: "task-concurrent",
        patch: { decisions: [{ statement: "Decision B" }] },
      }),
    ]);

    const updated = await loadContextPack({
      storeDirectory,
      key: "task-concurrent",
    });
    expect(updated?.revision).toBe(3);
    expect(updated?.decisions.map((decision) => decision.statement).sort()).toEqual([
      "Decision A",
      "Decision B",
    ]);
  });

  it("persists and updates a compact handoff without losing provenance", async () => {
    const projectDirectory = await createTemporaryProject();
    const storeDirectory = join(projectDirectory, ".pi", "artifacts", "tasks", "contexts");
    const pack = await buildContextPack({
      projectDirectory,
      input: {
        goal: "Implement context handoff",
        authorization: "write-approved",
        knownFacts: [{ statement: "Artifacts are canonical.", source: "repository" }],
        nextStep: "Implement persistence.",
      },
      now: new Date("2026-07-19T00:00:00.000Z"),
    });
    await saveContextPack({ storeDirectory, key: "task-example", pack });

    const updated = await updateContextHandoff({
      storeDirectory,
      key: "task-example",
      patch: {
        decisions: [{ statement: "Store references, not full files." }],
        evidence: [
          {
            description: "Context tests pass.",
            reference: "package/tests/orchestration-context.test.ts",
            recordedAt: "2026-07-19T00:05:00.000Z",
          },
        ],
        nextStep: "Wire the wrapper.",
      },
      now: new Date("2026-07-19T00:05:00.000Z"),
    });

    expect(updated.revision).toBe(2);
    expect(updated.knownFacts).toEqual(pack.knownFacts);
    expect(updated.decisions).toEqual([
      { statement: "Store references, not full files." },
    ]);
    expect((await loadContextPack({ storeDirectory, key: "task-example" }))).toEqual(
      updated,
    );
  });
});
