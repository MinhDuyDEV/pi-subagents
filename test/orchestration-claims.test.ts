import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ResourceClaimConflictError,
  acquireResourceLease,
  assertNoConflictingWrite,
  findClaimCoveringPath,
  listActiveResourceLeases,
  releaseOrphanedLeases,
  renewResourceLease,
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

  it("rejects overlapping exclusive claims even when the owner id is reused", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "same-owner",
      claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
    });
    await expect(
      acquireResourceLease({
        storePath,
        owner: "same-owner",
        claims: [{ kind: "write", resource: "src/index.ts", mode: "exclusive" }],
      }),
    ).rejects.toBeInstanceOf(ResourceClaimConflictError);
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
      expectedOwner: "run-preflight",
      expectedFence: lease.fence,
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

    expect(
      await releaseResourceLease({
        storePath,
        leaseId: lease.id,
        expectedOwner: "task-alpha",
        expectedFence: lease.fence,
      }),
    ).toBe(true);
    expect(await listActiveResourceLeases({ storePath })).toEqual([]);

    const persisted = JSON.parse(await readFile(storePath, "utf8")) as {
      version: number;
      nextFence: number;
      leases: unknown[];
    };
    // `nextFence` never rewinds when a lease is released — a fence must not be
    // handed out twice, or a superseded writer's token would become valid again.
    expect(persisted).toEqual({ version: 2, nextFence: 2, leases: [] });
  });

  it("releaseOrphanedLeases reaps leases whose owner is not alive", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-alive",
      claims: [{ kind: "write", resource: "a", mode: "exclusive" }],
    });
    await acquireResourceLease({
      storePath,
      owner: "task-dead",
      claims: [{ kind: "write", resource: "b", mode: "exclusive" }],
    });
    expect(await listActiveResourceLeases({ storePath })).toHaveLength(2);

    const reaped = await releaseOrphanedLeases({
      storePath,
      aliveOwnerIds: new Set(["task-alive"]),
    });
    expect(reaped).toHaveLength(1);
    const remaining = await listActiveResourceLeases({ storePath });
    expect(remaining.map((lease) => lease.owner).sort()).toEqual(["task-alive"]);
  });

  it("renews only the matching opaque owner and extends heartbeat", async () => {
    const storePath = await createStorePath();
    const acquired = new Date("2026-01-01T00:00:00.000Z");
    const lease = await acquireResourceLease({
      storePath,
      owner: "opaque-owner",
      claims: [{ kind: "write", resource: "src", mode: "exclusive" }],
      now: acquired,
      ttlMs: 1_000,
    });
    const renewed = await renewResourceLease({
      storePath,
      leaseId: lease.id,
      owner: "opaque-owner",
      expectedFence: lease.fence,
      now: new Date("2026-01-01T00:00:00.500Z"),
      ttlMs: 2_000,
    });
    expect(renewed?.heartbeatAt).toBe("2026-01-01T00:00:00.500Z");
    expect(renewed?.expiresAt).toBe("2026-01-01T00:00:02.500Z");
    await expect(
      renewResourceLease({
        storePath,
        leaseId: lease.id,
        owner: "forged-owner",
        expectedFence: lease.fence,
        now: new Date("2026-01-01T00:00:00.600Z"),
      }),
    ).rejects.toThrow(/owned by opaque-owner/u);
  });

  it("rejects shared or out-of-project write ownership", async () => {
    const storePath = await createStorePath();
    await expect(
      acquireResourceLease({
        storePath,
        owner: "owner",
        claims: [{ kind: "write", resource: "src", mode: "shared" }],
      }),
    ).rejects.toThrow(/must be exclusive/u);
    await expect(
      acquireResourceLease({
        storePath,
        owner: "owner",
        claims: [{ kind: "write", resource: "../outside", mode: "exclusive" }],
      }),
    ).rejects.toThrow(/inside the project/u);
  });
});

describe("write-claim path coverage", () => {
  it("findClaimCoveringPath returns a lease whose claim covers the exact path", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-owner",
      claims: [{ kind: "write", resource: "dir/a.ts", mode: "exclusive" }],
    });

    const lease = await findClaimCoveringPath({ storePath, path: "dir/a.ts" });
    expect(lease?.owner).toBe("task-owner");
  });

  it("selects the highest fence when reading overlapping legacy leases", async () => {
    const storePath = await createStorePath();
    const now = new Date("2026-07-19T00:00:00.000Z");
    const lease = (id: string, fence: number) => ({
      id,
      owner: `owner-${fence}`,
      claims: [{ kind: "write", resource: "dir/**", mode: "exclusive" }],
      acquiredAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      fence,
    });
    await writeFile(
      storePath,
      `${JSON.stringify({
        version: 2,
        nextFence: 10,
        leases: [lease("old", 2), lease("new", 9)],
      })}\n`,
      "utf8",
    );
    const covering = await findClaimCoveringPath({ storePath, path: "dir/a.ts", now });
    expect(covering?.id).toBe("new");
    expect(covering?.fence).toBe(9);
  });

  it("findClaimCoveringPath treats a parent directory claim as covering a child path", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-owner",
      claims: [{ kind: "write", resource: "dir", mode: "exclusive" }],
    });

    const lease = await findClaimCoveringPath({ storePath, path: "dir/a.ts" });
    expect(lease?.owner).toBe("task-owner");
  });

  it("findClaimCoveringPath does not cover a sibling path outside the claim", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-owner",
      claims: [{ kind: "write", resource: "dir", mode: "exclusive" }],
    });

    const lease = await findClaimCoveringPath({ storePath, path: "other/a.ts" });
    expect(lease).toBeUndefined();
  });

  it("findClaimCoveringPath returns undefined when no leases exist", async () => {
    const storePath = await createStorePath();
    const lease = await findClaimCoveringPath({ storePath, path: "dir/a.ts" });
    expect(lease).toBeUndefined();
  });

  it("assertNoConflictingWrite throws when a different owner holds a covering write lease", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-subagent",
      claims: [{ kind: "write", resource: "dir", mode: "exclusive" }],
    });

    await expect(
      assertNoConflictingWrite({
        storePath,
        ownerTaskId: "parent",
        path: "dir/a.ts",
      }),
    ).rejects.toThrow(/Write blocked: dir\/a\.ts is locked by task task-subagent/);
  });

  it("assertNoConflictingWrite allows the owning task to write", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "parent",
      claims: [{ kind: "write", resource: "dir", mode: "exclusive" }],
    });

    await expect(
      assertNoConflictingWrite({
        storePath,
        ownerTaskId: "parent",
        path: "dir/a.ts",
      }),
    ).resolves.toBeUndefined();
  });

  it("assertNoConflictingWrite allows writes when no covering lease exists", async () => {
    const storePath = await createStorePath();
    await acquireResourceLease({
      storePath,
      owner: "task-subagent",
      claims: [{ kind: "write", resource: "other", mode: "exclusive" }],
    });

    await expect(
      assertNoConflictingWrite({
        storePath,
        ownerTaskId: "parent",
        path: "dir/a.ts",
      }),
    ).resolves.toBeUndefined();
  });
});
