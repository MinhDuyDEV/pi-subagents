import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireFilesystemLock,
  withFileLock,
} from "../src/orchestration/file-lock.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryLock(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-lock-test-"));
  roots.push(root);
  return join(root, "state.lock");
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe("cross-process file lock", () => {
  it("heartbeats long operations so stale detection cannot steal them", async () => {
    const lockPath = await temporaryLock();
    let entered = false;
    const owner = withFileLock({
      lockPath,
      staleMs: 120,
      operation: async () => {
        entered = true;
        await delay(280);
      },
    });
    while (!entered) await delay(5);
    await delay(150);
    await expect(acquireFilesystemLock(lockPath, 120)).rejects.toThrow(/busy/u);
    await owner;
  });

  it("recovers an abandoned stale lock", async () => {
    const lockPath = await temporaryLock();
    await mkdir(lockPath);
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    await expect(
      withFileLock({ lockPath, staleMs: 100, operation: async () => "recovered" }),
    ).resolves.toBe("recovered");
  });
});
