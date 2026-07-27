/**
 * Cross-process contention fixtures for the lease store and the run store.
 *
 * Both stores are guarded by `withFileLock`, which layers an in-process queue
 * (`inProcessLocks`) on top of a filesystem lock. The in-process queue means
 * `Promise.all` inside one process never truly contends — the operations
 * serialize on the queue before they reach the lock file. These fixtures
 * instead spawn real child processes (see `fixtures/store-contention-worker.ts`)
 * that all wait on a shared start barrier and then hit the same on-disk store
 * at once, so the filesystem lock + CAS + unique-constraint paths are exercised
 * under genuine concurrency.
 *
 * These close the §6 gap from the 2026-07-27 audit/rebuttal: the F-01
 * result-digest CAS, the F-09 decision-resume unique correlation, and the F-10
 * lease mutual-exclusion invariants all held in the existing sequential tests but
 * were never proven under interleaving. The fixes are real, but a green
 * sequential suite alone does not prove they survive contention.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDurableRun,
  listDurableRuns,
  patchDurableRun,
  putDurableRun,
} from "../src/orchestration/run-store.ts";
import { listActiveResourceLeases } from "../src/orchestration/claims.ts";
import { taggedDigest } from "../src/learning-contract.ts";

const WORKER = join(import.meta.dirname, "fixtures", "store-contention-worker.ts");
// tsx is a workspace dependency of pi-subagents, so the child must resolve it
// from here regardless of the directory vitest was launched from.
const REPO_ROOT = join(import.meta.dirname, "..");
const RUNNER_ARGS = ["--import", "tsx"];

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-contention-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface WorkerLine {
  phase: "ready" | "done";
  ok?: boolean;
  result?: { [key: string]: unknown };
  error?: string;
  name?: string;
}

interface WorkerHandle {
  child: ChildProcess;
  ready: Promise<void>;
  done: Promise<WorkerLine>;
}

function spawnWorker(argSet: string[]): WorkerHandle {
  const child = spawn("node", [...RUNNER_ARGS, WORKER, ...argSet], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
    // Vitest injects its own loader via NODE_OPTIONS; the child must run plain
    // `node --import tsx`, so drop inherited loader flags that conflict.
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  let buffer = "";
  let stderrText = "";
  let readyResolve: () => void = () => undefined;
  let doneResolve: (line: WorkerLine) => void = () => undefined;
  let settled = false;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const done = new Promise<WorkerLine>((resolve) => {
    doneResolve = resolve;
  });
  const settle = (line: WorkerLine) => {
    // A worker that crashes before it reaches the barrier must still unblock the
    // ready gate, otherwise Promise.all(ready) hangs until the test times out.
    readyResolve();
    if (settled) return;
    settled = true;
    doneResolve(line);
    // Surface crashes in the test output for diagnosis.
    if (line.name === "WorkerCrash") console.error(`[contention worker] ${line.error}`);
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!raw) continue;
      try {
        const line = JSON.parse(raw) as WorkerLine;
        if (line.phase === "ready") readyResolve();
        if (line.phase === "done") settle(line);
      } catch {
        // tsx or the runtime may emit a stray line; only JSON lines matter.
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  child.on("error", (error) =>
    settle({ phase: "done", ok: false, error: error.message, name: error.name }),
  );
  child.on("exit", (code) => {
    if (!settled) {
      settle({
        phase: "done",
        ok: false,
        error: `worker exited without a done line (code=${code})${
          stderrText ? ": " + stderrText.trim().slice(0, 600) : ""
        }`,
        name: "WorkerCrash",
      });
    }
  });
  return { child, ready, done };
}

async function runContention(
  startPath: string,
  argSets: string[][],
): Promise<WorkerLine[]> {
  const handles = argSets.map((argSet) => spawnWorker([...argSet, "--start", startPath]));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("contention fixture timed out")), 30_000);
  });
  try {
    await Promise.race([Promise.all(handles.map((handle) => handle.ready)), timeout]);
    await mkdir(dirname(startPath), { recursive: true });
    await writeFile(startPath, "");
    const results = await Promise.race([
      Promise.all(handles.map((handle) => handle.done)),
      timeout,
    ]);
    return results;
  } finally {
    if (timer) clearTimeout(timer);
    for (const handle of handles) {
      if (handle.child.exitCode === null) handle.child.kill("SIGKILL");
    }
  }
}

function winners(results: WorkerLine[]): WorkerLine[] {
  return results.filter((result) => result.phase === "done" && result.ok);
}

function losers(results: WorkerLine[]): WorkerLine[] {
  return results.filter((result) => result.phase === "done" && !result.ok);
}

describe("cross-process store contention", () => {
  it(
    "keeps lease mutual exclusion when several processes acquire the same claim at once",
    async () => {
      const project = await temporaryProject();
      const store = join(project, "leases.json");
      const start = join(project, "start");
      const workers = 5;
      const results = await runContention(
        start,
        Array.from({ length: workers }, (_, index) => [
          "--op",
          "acquire-lease",
          "--store",
          store,
          "--owner",
          `owner-${index}`,
        ]),
      );

      expect(winners(results)).toHaveLength(1);
      expect(losers(results)).toHaveLength(workers - 1);
      for (const loser of losers(results)) {
        expect(loser.name).toBe("ResourceClaimConflictError");
      }

      const leases = await listActiveResourceLeases({
        storePath: store,
        now: new Date(),
      });
      expect(leases).toHaveLength(1);
      const winner = winners(results)[0]!.result!;
      expect(leases[0]!.owner).toBe(winner.owner);
    },
    30_000,
  );

  it(
    "lets exactly one process complete a run when two race with different result digests",
    async () => {
      const project = await temporaryProject();
      const store = join(project, "runs.json");
      const start = join(project, "start");
      const run = createDurableRun({
        invocationId: "cas-contention",
        projectDirectory: project,
      });
      await putDurableRun(store, run);
      await patchDurableRun(store, run.invocationId, { executionPhase: "working" });

      const results = await runContention(start, [
        ["--op", "complete-run", "--store", store, "--invocation", "cas-contention", "--digest", "win-a"],
        ["--op", "complete-run", "--store", store, "--invocation", "cas-contention", "--digest", "win-b"],
      ]);

      expect(winners(results)).toHaveLength(1);
      expect(losers(results)).toHaveLength(1);
      expect(losers(results)[0]!.error).toMatch(/Conflicting terminal result/u);

      const [final] = await listDurableRuns(store);
      expect(final.executionPhase).toBe("completed");
      expect([
        taggedDigest({ contention: "win-a" }),
        taggedDigest({ contention: "win-b" }),
      ]).toContain(final.resultDigest);
    },
    30_000,
  );

  it(
    "admits exactly one durable invocation when two processes race the same decision-resume correlation",
    async () => {
      const project = await temporaryProject();
      const store = join(project, "runs.json");
      const start = join(project, "start");
      const correlation = "decision-resume:subject:decision";

      const results = await runContention(start, [
        ["--op", "put-decision-resume", "--store", store, "--invocation", "resume-1", "--correlation", correlation, "--project", project],
        ["--op", "put-decision-resume", "--store", store, "--invocation", "resume-2", "--correlation", correlation, "--project", project],
      ]);

      expect(winners(results)).toHaveLength(1);
      expect(losers(results)).toHaveLength(1);
      expect(losers(results)[0]!.error).toMatch(/already has a durable invocation/u);

      const runs = await listDurableRuns(store);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.correlationId).toBe(correlation);
    },
    30_000,
  );
});