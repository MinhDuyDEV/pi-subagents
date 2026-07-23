import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ResourceClaimConflictError,
  acquireResourceLease,
  listActiveResourceLeases,
  releaseResourceLease,
  transferResourceLeaseOwnership,
} from "../src/orchestration/claims.ts";

const temporaryDirectories: string[] = [];

async function createStorePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-harness-claims-"));
  temporaryDirectories.push(directory);
  return join(directory, "leases.json");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("resource claims", () => {
  it("rejects overlapping exclusive write claims", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-alpha",
      claims: [
        { kind: "write", resource: "package/src", mode: "exclusive" },
      ],
      now: new Date("2026-07-19T00:00:00.000Z"),
    });

    await expect(
      acquireResourceLease({
        storePath,
        owner: "task-beta",
        claims: [
          {
            kind: "write",
            resource: "package/src/orchestration/runtime.ts",
            mode: "exclusive",
          },
        ],
        now: new Date("2026-07-19T00:00:01.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "ResourceClaimConflictError",
      owner: "task-alpha",
      resource: "package/src/orchestration/runtime.ts",
    });
  });

  it("treats a global write glob as conflicting with every write path", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-alpha",
      claims: [{ kind: "write", resource: "*", mode: "exclusive" }],
    });

    await expect(
      acquireResourceLease({
        storePath,
        owner: "task-beta",
        claims: [
          {
            kind: "write",
            resource: "package/src/orchestration/runtime.ts",
            mode: "exclusive",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ResourceClaimConflictError);
  });

  it("treats write globs conservatively as overlapping path scopes", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-alpha",
      claims: [
        { kind: "write", resource: "package/src/**", mode: "exclusive" },
      ],
    });

    await expect(
      acquireResourceLease({
        storePath,
        owner: "task-beta",
        claims: [
          {
            kind: "write",
            resource: "package/src/orchestration/runtime.ts",
            mode: "exclusive",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ResourceClaimConflictError);
  });

  it("keeps write, test, and evidence resources in explicit namespaces", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-writer",
      claims: [{ kind: "write", resource: "package:test", mode: "exclusive" }],
    });
    await acquireResourceLease({
      storePath,
      owner: "task-tester",
      claims: [{ kind: "test", resource: "package:test", mode: "exclusive" }],
    });

    expect(await listActiveResourceLeases({ storePath })).toHaveLength(2);
  });

  it("allows compatible shared evidence claims", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "reviewer-alpha",
      claims: [
        { kind: "evidence", resource: "artifacts/proof.json", mode: "shared" },
      ],
    });
    await acquireResourceLease({
      storePath,
      owner: "reviewer-beta",
      claims: [
        { kind: "evidence", resource: "artifacts/proof.json", mode: "shared" },
      ],
    });

    const leases = await listActiveResourceLeases({ storePath });
    expect(leases).toHaveLength(2);
  });

  it("treats wildcard test resources as overlapping namespaces", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-alpha",
      claims: [{ kind: "test", resource: "package:*", mode: "exclusive" }],
    });

    await expect(
      acquireResourceLease({
        storePath,
        owner: "task-beta",
        claims: [
          { kind: "test", resource: "package:test", mode: "exclusive" },
        ],
      }),
    ).rejects.toBeInstanceOf(ResourceClaimConflictError);
  });

  it("treats a global test wildcard as overlapping every test resource", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-alpha",
      claims: [{ kind: "test", resource: "*", mode: "exclusive" }],
    });

    await expect(
      acquireResourceLease({
        storePath,
        owner: "task-beta",
        claims: [
          { kind: "test", resource: "package:test", mode: "exclusive" },
        ],
      }),
    ).rejects.toBeInstanceOf(ResourceClaimConflictError);
  });

  it("treats matching test resources as exclusive", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-alpha",
      claims: [{ kind: "test", resource: "package:test", mode: "exclusive" }],
    });

    await expect(
      acquireResourceLease({
        storePath,
        owner: "task-beta",
        claims: [
          { kind: "test", resource: "package:test", mode: "exclusive" },
        ],
      }),
    ).rejects.toBeInstanceOf(ResourceClaimConflictError);
  });

  it("prunes expired leases before checking conflicts", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-expired",
      claims: [{ kind: "write", resource: "package/src", mode: "exclusive" }],
      now: new Date("2026-07-19T00:00:00.000Z"),
      ttlMs: 1_000,
    });

    const replacement = await acquireResourceLease({
      storePath,
      owner: "task-replacement",
      claims: [{ kind: "write", resource: "package/src", mode: "exclusive" }],
      now: new Date("2026-07-19T00:00:02.000Z"),
    });

    expect(replacement.owner).toBe("task-replacement");
    expect(
      await listActiveResourceLeases({
        storePath,
        now: new Date("2026-07-19T00:00:03.000Z"),
      }),
    ).toEqual([replacement]);
  });

  it("transfers a preflight lease to the canonical task owner", async () => {
    const storePath = await createStorePath();
    const lease = await acquireResourceLease({
      storePath,
      owner: "run-preflight",
      claims: [{ kind: "write", resource: "package/src", mode: "exclusive" }],
    });

    const transferred = await transferResourceLeaseOwnership({
      storePath,
      leaseId: lease.id,
      owner: "task-canonical",
    });

    expect(transferred?.owner).toBe("task-canonical");
    expect((await listActiveResourceLeases({ storePath }))[0]?.owner).toBe(
      "task-canonical",
    );
  });

  it("releases a lease durably", async () => {
    const storePath = await createStorePath();
    const lease = await acquireResourceLease({
      storePath,
      owner: "task-alpha",
      claims: [{ kind: "write", resource: "package/src", mode: "exclusive" }],
    });

    expect(await releaseResourceLease({ storePath, leaseId: lease.id })).toBe(true);
    expect(await listActiveResourceLeases({ storePath })).toEqual([]);

    const persisted = JSON.parse(await readFile(storePath, "utf8")) as {
      version: number;
      leases: unknown[];
    };
    expect(persisted).toEqual({ version: 1, leases: [] });
  });
});
