import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readFinalAssistantText,
  renderBackgroundReceipt,
  resolveTaskSessionReference,
} from "../src/orchestration/lifecycle.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-harness-orchestration-"));
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

describe("task lifecycle parity", () => {
  it("resolves a completed task session nested below the task artifact root", async () => {
    const projectDirectory = await createTemporaryProject();
    const taskId = "mrqexample-1234";
    const sessionName = `task-${taskId}`;
    const nestedDirectory = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "sessions",
      taskId,
    );
    const sessionPath = join(nestedDirectory, "2026-07-19T00-00-00-session.jsonl");

    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "nested-session-id",
          cwd: projectDirectory,
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "completed result" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const resolved = await resolveTaskSessionReference({
      projectDirectory,
      taskId,
      sessionName,
    });

    expect(resolved).toBe(sessionPath);
    expect(existsSync(resolved ?? "")).toBe(true);
  });

  it("prefers an existing recorded session reference", async () => {
    const projectDirectory = await createTemporaryProject();
    const sessionPath = join(projectDirectory, "recorded.jsonl");
    await writeFile(sessionPath, `${JSON.stringify({ type: "session" })}\n`, "utf8");

    const resolved = await resolveTaskSessionReference({
      projectDirectory,
      taskId: "mrqrecorded-1234",
      sessionName: "task-mrqrecorded-1234",
      recordedSessionReference: sessionPath,
    });

    expect(resolved).toBe(sessionPath);
  });

  it("does not advertise a synthetic session path before a real file exists", async () => {
    const projectDirectory = await createTemporaryProject();
    const syntheticPath = join(
      projectDirectory,
      ".pi",
      "artifacts",
      "tasks",
      "sessions",
      "task-mrqpending-1234.jsonl",
    );

    const receipt = renderBackgroundReceipt({
      taskId: "mrqpending-1234",
      sessionName: "task-mrqpending-1234",
      sessionReference: syntheticPath,
    });

    expect(receipt).toContain("Task ID: mrqpending-1234");
    expect(receipt).toContain("Session reference: task-mrqpending-1234");
    expect(receipt).not.toContain(syntheticPath);
  });

  it("advertises a canonical session path only when it exists", async () => {
    const projectDirectory = await createTemporaryProject();
    const sessionPath = join(projectDirectory, "actual-session.jsonl");
    await writeFile(sessionPath, `${JSON.stringify({ type: "session" })}\n`, "utf8");

    const receipt = renderBackgroundReceipt({
      taskId: "mrqcomplete-1234",
      sessionName: "task-mrqcomplete-1234",
      sessionReference: sessionPath,
    });

    expect(receipt).toContain(`Session file: ${sessionPath}`);
  });

  it("returns the final assistant text from a completed session", async () => {
    const projectDirectory = await createTemporaryProject();
    const sessionPath = join(projectDirectory, "completed-session.jsonl");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({ type: "session", name: "task-completed" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "intermediate" }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "final verified result" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    expect(await readFinalAssistantText(sessionPath)).toBe("final verified result");
  });
});
