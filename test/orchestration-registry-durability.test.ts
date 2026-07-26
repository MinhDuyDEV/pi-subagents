/**
 * The task registry and session history are what `restoreActiveBackgroundTasks`
 * reads to find panes, processes, and worktrees left by a previous session.
 * Losing them orphans all three, so these are the audit's §2.9 PoCs as tests:
 * a lost update, a truncated file read as empty, and the two writers of the
 * same file racing each other.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readRegistry,
  readTaskSessionHistory,
  setRegistryQuarantineReporter,
  upsertTaskSessionHistory,
  writeRegistry,
} from "../src/conversation.ts";
import { persistTaskHistoryReference } from "../src/orchestration/task-state.ts";

const temporaryDirectories: string[] = [];

async function createPiDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-harness-registry-"));
  temporaryDirectories.push(directory);
  const piDir = join(directory, ".pi");
  mkdirSync(piDir, { recursive: true });
  return piDir;
}

afterEach(async () => {
  setRegistryQuarantineReporter(() => undefined);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("task session history (§2.9)", () => {
  it("keeps every upsert — a read-modify-write no longer drops one", async () => {
    const piDir = await createPiDir();

    for (const id of ["t1", "t2", "t3"]) {
      upsertTaskSessionHistory(piDir, {
        id,
        sessionName: `task-${id}`,
      } as never);
    }

    const history = readTaskSessionHistory(piDir);
    expect(history.map((entry) => entry.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("merges into an existing entry rather than duplicating it", async () => {
    const piDir = await createPiDir();
    upsertTaskSessionHistory(piDir, { id: "t1", sessionName: "task-t1" } as never);
    upsertTaskSessionHistory(piDir, { id: "t1", status: "completed" } as never);

    const history = readTaskSessionHistory(piDir);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: "t1",
      sessionName: "task-t1",
      status: "completed",
    });
  });

  it("reports a truncated history instead of reading it as empty", async () => {
    const piDir = await createPiDir();
    upsertTaskSessionHistory(piDir, { id: "t1", sessionName: "task-t1" } as never);

    // Exactly what a bare `writeFileSync` interrupted mid-flight leaves behind.
    await writeFile(join(piDir, "task-session-history.json"), '[{"id":"t1"', "utf8");

    const reports: string[] = [];
    setRegistryQuarantineReporter((info) => reports.push(info.reason));

    // Reading still yields a usable value — the extension must not die — but
    // the loss is now announced rather than looking like "there were no tasks".
    expect(readTaskSessionHistory(piDir)).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/unparseable JSON/u);

    const entries = await readdir(piDir);
    expect(entries.some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("does not let a later upsert erase history it could not read", async () => {
    const piDir = await createPiDir();
    upsertTaskSessionHistory(piDir, { id: "t1", sessionName: "task-t1" } as never);
    await writeFile(join(piDir, "task-session-history.json"), "{ truncated", "utf8");

    const quarantined: string[] = [];
    setRegistryQuarantineReporter((info) => quarantined.push(info.quarantinePath));

    upsertTaskSessionHistory(piDir, { id: "t7", sessionName: "task-t7" } as never);
    expect(readTaskSessionHistory(piDir).map((entry) => entry.id)).toEqual(["t7"]);

    // The previous history was preserved on disk for recovery instead of being
    // overwritten in place.
    expect(quarantined).toHaveLength(1);
    expect(await readFile(quarantined[0] as string, "utf8")).toBe("{ truncated");
  });
});

describe("registry writes are atomic", () => {
  it("leaves no partial file behind and no stray temp files", async () => {
    const piDir = await createPiDir();
    writeRegistry(piDir, [
      { id: "t1", agentType: "explore" },
      { id: "t2", agentType: "scout" },
    ] as never);

    expect(readRegistry(piDir).map((entry) => entry.id)).toEqual(["t1", "t2"]);
    const entries = await readdir(piDir);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("survives the two writers of task-session-history.json racing", async () => {
    const piDir = await createPiDir();
    const projectDirectory = join(piDir, "..");

    // `conversation.ts` (sync) and `task-state.ts` (async) both own this file.
    // Before they shared a lock, whichever landed second erased the other.
    upsertTaskSessionHistory(piDir, { id: "t1", sessionName: "task-t1" } as never);
    const asyncWrite = persistTaskHistoryReference(
      projectDirectory,
      "t2",
      "task-t2",
      "/sessions/t2.jsonl",
    );
    upsertTaskSessionHistory(piDir, { id: "t3", sessionName: "task-t3" } as never);
    await asyncWrite;

    const ids = readTaskSessionHistory(piDir)
      .map((entry) => entry.id)
      .sort();
    expect(ids).toEqual(["t1", "t2", "t3"]);
  });
});

describe("registry lock", () => {
  it("is not defeated by a stale lock directory from a dead process", async () => {
    const piDir = await createPiDir();
    const file = join(piDir, "task-session-history.json");

    // A lock left behind by a process that no longer exists. PID 1 would be
    // alive, so use a pid that cannot be, and backdate it past the stale window.
    mkdirSync(`${file}.lock`, { recursive: true });
    writeFileSync(
      join(`${file}.lock`, "owner"),
      `${JSON.stringify({ owner: "dead", pid: 0x7ffffff })}\n`,
      "utf8",
    );
    const past = new Date(Date.now() - 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(`${file}.lock`, past, past);

    upsertTaskSessionHistory(piDir, { id: "t1", sessionName: "task-t1" } as never);
    expect(readTaskSessionHistory(piDir).map((entry) => entry.id)).toEqual(["t1"]);
  });
});
