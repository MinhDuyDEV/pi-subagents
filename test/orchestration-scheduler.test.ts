import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskScheduler } from "../src/orchestration/scheduler.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("durable task scheduler", () => {
  it("persists and cancels cron schedules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-schedule-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const scheduler = new TaskScheduler(join(directory, "schedules.json"));
    const schedule = await scheduler.add({
      name: "nightly review",
      projectDirectory: directory,
      cron: "0 0 * * *",
      parameters: { agent_type: "reviewer" },
    });
    expect(schedule.nextRunAt).toBeDefined();
    expect(await scheduler.list()).toHaveLength(1);
    expect(await scheduler.cancel(schedule.id)).toBe(true);
    expect((await scheduler.list())[0]?.enabled).toBe(false);
    scheduler.dispose();
  });

  it("fires a persisted one-shot schedule exactly once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-schedule-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const scheduler = new TaskScheduler(join(directory, "schedules.json"));
    const calls: unknown[] = [];
    await scheduler.start(async (parameters) => {
      calls.push(parameters);
    });
    await scheduler.add({
      name: "once",
      projectDirectory: directory,
      at: new Date(Date.now() + 120).toISOString(),
      parameters: { agent_type: "general", background: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toHaveLength(1);
    expect((await scheduler.list())[0]).toMatchObject({ runs: 1, enabled: false });
    scheduler.dispose();
  });
});
