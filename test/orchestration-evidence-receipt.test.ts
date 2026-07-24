import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listEvidenceReceipts,
  recordEvidenceReceipt,
  verifyEvidenceReceipt,
} from "../src/orchestration/evidence.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("typed evidence receipts", () => {
  it("records runtime time and immutable artifact digest", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-evidence-"));
    directories.push(project);
    await writeFile(join(project, "test.log"), "12 tests passed\n");
    const store = join(project, ".pi", "evidence");
    const receipt = await recordEvidenceReceipt({
      storeDirectory: store,
      projectDirectory: project,
      taskId: "task-1",
      producerTaskId: "task-1",
      kind: "test",
      description: "Focused suite",
      claim: "Focused tests pass",
      artifactPath: "test.log",
      exitCode: 0,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(receipt.observedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(receipt.sha256).toMatch(/^sha256:/u);
    expect(verifyEvidenceReceipt(receipt, project)).toBe(true);
    await writeFile(join(project, "test.log"), "tampered\n");
    expect(verifyEvidenceReceipt(receipt, project)).toBe(false);
    expect(await listEvidenceReceipts(store, "task-1")).toHaveLength(1);
  });

  it("rejects artifacts outside the project", async () => {
    const project = await mkdtemp(join(tmpdir(), "pi-evidence-"));
    directories.push(project);
    await expect(
      recordEvidenceReceipt({
        storeDirectory: join(project, ".pi", "evidence"),
        projectDirectory: project,
        taskId: "task-1",
        producerTaskId: "task-1",
        kind: "file",
        description: "outside",
        artifactPath: "/etc/hosts",
      }),
    ).rejects.toThrow(/outside the project/u);
  });
});
