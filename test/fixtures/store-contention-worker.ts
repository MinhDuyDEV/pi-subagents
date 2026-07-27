/**
 * Child-process worker for the cross-process store-contention fixtures
 * (see `../orchestration-store-contention.test.ts`).
 *
 * The lease and run stores are guarded by `withFileLock`, which layers an
 * in-process queue (`inProcessLocks`) on top of a filesystem lock. The
 * in-process queue means `Promise.all` inside one process never truly contends
 * — the operations serialize on the queue before they ever touch the lock file.
 * To exercise the filesystem lock + CAS + unique-constraint paths under genuine
 * concurrency, the test spawns several copies of this worker, each of which
 * waits on a shared start barrier and then hits the same on-disk store at once.
 *
 * The worker is driven entirely by argv and speaks a line-delimited JSON
 * protocol over stdout so the parent can collect results without sharing
 * memory:
 *
 *   {"phase":"ready"}                                  — polling the barrier
 *   {"phase":"done","ok":true,"result":{...}}          — op succeeded
 *   {"phase":"done","ok":false,"error":"...","name":..}— op failed
 *
 * Exit code mirrors `ok`. The parent reads the lines (not the code), but the
 * code is kept honest so a hung worker is debuggable from a shell.
 */
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  acquireResourceLease,
  type ResourceClaim,
} from "../../src/orchestration/claims.ts";
import {
  completeDurableRun,
  createDurableRun,
  putDurableRun,
} from "../../src/orchestration/run-store.ts";
import { taggedDigest } from "../../src/learning-contract.ts";

interface Args {
  op: "acquire-lease" | "complete-run" | "put-decision-resume";
  store: string;
  owner?: string;
  invocation?: string;
  correlation?: string;
  digest?: string;
  project?: string;
  start: string;
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`bad argv: ${JSON.stringify(argv)}`);
    }
    args[key.slice(2)] = value;
  }
  if (!args.op || !args.store || !args.start) {
    throw new Error("worker requires --op --store --start");
  }
  return args as unknown as Args;
}

async function waitForStart(startPath: string): Promise<void> {
  while (!existsSync(startPath)) await sleep(5);
}

function emit(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function run(args: Args): Promise<unknown> {
  switch (args.op) {
    case "acquire-lease": {
      if (!args.owner) throw new Error("acquire-lease requires --owner");
      const lease = await acquireResourceLease({
        storePath: args.store,
        owner: args.owner,
        claims: [
          { kind: "write", resource: "src/**", mode: "exclusive" },
        ] as ResourceClaim[],
        ttlMs: 60_000,
      });
      return { leaseId: lease.id, owner: lease.owner, fence: lease.fence };
    }
    case "complete-run": {
      if (!args.invocation || !args.digest) {
        throw new Error("complete-run requires --invocation --digest");
      }
      const completed = await completeDurableRun(
        args.store,
        args.invocation,
        taggedDigest({ contention: args.digest }),
        { executionPhase: "completed", reportedOutcome: "success" },
      );
      return { completed: completed !== undefined };
    }
    case "put-decision-resume": {
      if (!args.invocation || !args.correlation || !args.project) {
        throw new Error("put-decision-resume requires --invocation --correlation --project");
      }
      const run = createDurableRun({
        invocationId: args.invocation,
        correlationId: args.correlation,
        projectDirectory: args.project,
      });
      await putDurableRun(args.store, run);
      return { put: true, invocationId: run.invocationId };
    }
    default:
      throw new Error(`unknown op: ${args.op satisfies never}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  emit({ phase: "ready" });
  await waitForStart(args.start);
  try {
    const result = await run(args);
    emit({ phase: "done", ok: true, result });
  } catch (error) {
    emit({
      phase: "done",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error",
    });
    // Let the stdout write drain; the non-zero code still propagates.
    process.exitCode = 1;
  }
}

void main();