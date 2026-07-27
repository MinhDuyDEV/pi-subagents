/**
 * Regression tests for the two ways the lease store used to fail: a lapsed
 * lease silently losing mutual exclusion, and one malformed claim making every
 * subsequent read throw.
 *
 * The scenarios here are the proof-of-concepts from the 2026-07-26 audit
 * (§2.7, §2.8) written as tests. They exercise the real functions against a
 * real store on disk with an injected clock — not a fixture — because both bugs
 * were invisible to tests that built their own inputs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireResourceLease,
  assertNoConflictingWrite,
  isResourceClaim,
  isResourceLease,
  listActiveResourceLeases,
  pruneExpiredLeases,
  releaseOrphanedLeases,
  releaseResourceLease,
  renewResourceLease,
  setStoreQuarantineReporter,
  transferResourceLeaseOwnership,
} from "../src/orchestration/claims.ts";
import { parseOrchestrationRequest } from "../src/orchestration/contract.ts";

const temporaryDirectories: string[] = [];

async function createStoreDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-harness-fencing-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createStorePath(): Promise<string> {
  return join(await createStoreDirectory(), "leases.json");
}

afterEach(async () => {
  setStoreQuarantineReporter(() => undefined);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("lease fencing (§2.7)", () => {
  it("rejects non-positive or missing fence tokens at the authority boundary", async () => {
    expect(
      isResourceLease({
        id: "lease",
        owner: "task",
        claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
        acquiredAt: "2026-07-26T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        fence: 0,
      }),
    ).toBe(false);
    expect(
      isResourceLease({
        id: "lease",
        owner: "task",
        claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
        acquiredAt: "2026-07-26T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ).toBe(false);
    const storePath = await createStorePath();
    await expect(
      assertNoConflictingWrite({
        storePath,
        ownerTaskId: "task",
        path: "src/a.ts",
        fence: -1,
      }),
    ).rejects.toThrow(/positive safe integer/u);
  });

  it("refuses a write from a holder whose lease was superseded after expiry", async () => {
    const storePath = await createStorePath();
    const t0 = new Date("2026-07-26T00:00:00.000Z");
    const afterExpiry = new Date("2026-07-26T00:00:02.000Z");

    const a = await acquireResourceLease({
      storePath,
      owner: "task-a",
      claims: [{ kind: "write", resource: "src/auth/**", mode: "exclusive" }],
      ttlMs: 1_000,
      now: t0,
    });

    // While A's lease is live, A may write and B is refused.
    await expect(
      assertNoConflictingWrite({
        storePath,
        ownerTaskId: "task-a",
        path: "src/auth/token.ts",
        fence: a.fence,
        now: t0,
      }),
    ).resolves.toBeUndefined();

    // A's lease lapses. B legitimately reclaims the resource — reclaim after
    // expiry is the point of a TTL, and blocking it would let a crashed holder
    // own the path forever.
    const b = await acquireResourceLease({
      storePath,
      owner: "task-b",
      claims: [{ kind: "write", resource: "src/auth/**", mode: "exclusive" }],
      ttlMs: 1_000,
      now: afterExpiry,
    });
    expect(b.fence).toBeGreaterThan(a.fence);

    // This is the part that used to be missing: A still believes it holds the
    // resource and nothing had told it otherwise, so it kept writing. Now the
    // write is refused — here because B's ownership is visible in the store.
    await expect(
      assertNoConflictingWrite({
        storePath,
        ownerTaskId: "task-a",
        path: "src/auth/token.ts",
        fence: a.fence,
        now: afterExpiry,
      }),
    ).rejects.toThrow(/locked by task task-b/u);

    // And A cannot quietly renew its way back in.
    await expect(
      renewResourceLease({
        storePath,
        leaseId: a.id,
        owner: "task-a",
        expectedFence: a.fence,
        now: afterExpiry,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a superseded holder even when the owner id still matches", async () => {
    // The case ownership alone cannot catch: the resource comes back to the
    // SAME owner under a new lease, so an owner check sees nothing wrong, but a
    // writer still holding the old generation is working from a stale belief.
    const storePath = await createStorePath();
    const t0 = new Date("2026-07-26T00:00:00.000Z");
    const afterExpiry = new Date("2026-07-26T00:00:02.000Z");

    const first = await acquireResourceLease({
      storePath,
      owner: "task-a",
      claims: [{ kind: "write", resource: "src/auth/**", mode: "exclusive" }],
      ttlMs: 1_000,
      now: t0,
    });
    const reacquired = await acquireResourceLease({
      storePath,
      owner: "task-a",
      claims: [{ kind: "write", resource: "src/auth/**", mode: "exclusive" }],
      ttlMs: 1_000,
      now: afterExpiry,
    });

    expect(reacquired.owner).toBe(first.owner);
    await expect(
      assertNoConflictingWrite({
        storePath,
        ownerTaskId: "task-a",
        path: "src/auth/token.ts",
        fence: first.fence,
        now: afterExpiry,
      }),
    ).rejects.toThrow(/lease was superseded/u);

    // The current generation is of course still allowed to write.
    await expect(
      assertNoConflictingWrite({
        storePath,
        ownerTaskId: "task-a",
        path: "src/auth/token.ts",
        fence: reacquired.fence,
        now: afterExpiry,
      }),
    ).resolves.toBeUndefined();
  });

  it("issues a fresh fence on ownership transfer so the old owner's token dies", async () => {
    const storePath = await createStorePath();
    const now = new Date("2026-07-26T00:00:00.000Z");
    const lease = await acquireResourceLease({
      storePath,
      owner: "invocation-1",
      claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
      now,
    });

    const transferred = await transferResourceLeaseOwnership({
      storePath,
      leaseId: lease.id,
      owner: "task-1",
      expectedOwner: "invocation-1",
      expectedFence: lease.fence,
      now,
    });

    expect(transferred?.fence).toBeGreaterThan(lease.fence);
    await expect(
      renewResourceLease({
        storePath,
        leaseId: lease.id,
        owner: "task-1",
        expectedFence: lease.fence,
        now,
      }),
    ).rejects.toThrow(/has fence/u);
    await expect(
      releaseResourceLease({
        storePath,
        leaseId: lease.id,
        expectedOwner: "task-1",
        expectedFence: lease.fence,
        now,
      }),
    ).rejects.toThrow(/has fence/u);
    await expect(
      transferResourceLeaseOwnership({
        storePath,
        leaseId: lease.id,
        owner: "task-2",
        expectedOwner: "task-1",
        expectedFence: lease.fence,
        now,
      }),
    ).rejects.toThrow(/has fence/u);
    await expect(
      assertNoConflictingWrite({
        storePath,
        ownerTaskId: "task-1",
        path: "src/a.ts",
        fence: lease.fence,
        now,
      }),
    ).rejects.toThrow(/lease was superseded/u);
  });

  it("never reuses a fence, even across release", async () => {
    const storePath = await createStorePath();
    const now = new Date("2026-07-26T00:00:00.000Z");
    const first = await acquireResourceLease({
      storePath,
      owner: "task-a",
      claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
      now,
    });
    await releaseResourceLease({
      storePath,
      leaseId: first.id,
      expectedOwner: "task-a",
      expectedFence: first.fence,
      now,
    });
    const second = await acquireResourceLease({
      storePath,
      owner: "task-b",
      claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
      now,
    });

    expect(second.fence).toBeGreaterThan(first.fence);
  });

  it("keeps reads pure — listing does not rewrite the store", async () => {
    const storePath = await createStorePath();
    const t0 = new Date("2026-07-26T00:00:00.000Z");
    await acquireResourceLease({
      storePath,
      owner: "task-a",
      claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
      ttlMs: 1_000,
      now: t0,
    });

    const afterExpiry = new Date("2026-07-26T00:00:05.000Z");
    const before = await readFile(storePath, "utf8");
    await expect(
      listActiveResourceLeases({ storePath, now: afterExpiry }),
    ).resolves.toEqual([]);
    expect(await readFile(storePath, "utf8")).toBe(before);

    // Pruning is explicit, and only then does the file change.
    await expect(pruneExpiredLeases({ storePath, now: afterExpiry })).resolves.toHaveLength(1);
    expect(await readFile(storePath, "utf8")).not.toBe(before);
  });
});

describe("lease ownership (S-B)", () => {
  it("refuses to release a lease the caller does not own", async () => {
    const storePath = await createStorePath();
    const now = new Date("2026-07-26T00:00:00.000Z");
    const lease = await acquireResourceLease({
      storePath,
      owner: "task-c",
      claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
      now,
    });

    await expect(
      releaseResourceLease({
        storePath,
        leaseId: lease.id,
        expectedOwner: "attacker",
        expectedFence: lease.fence,
        now,
      }),
    ).rejects.toThrow(/owned by task-c/u);

    // The lease survived the attempt.
    await expect(listActiveResourceLeases({ storePath, now })).resolves.toHaveLength(1);
  });

  it("refuses to transfer a lease away from an unexpected owner", async () => {
    const storePath = await createStorePath();
    const now = new Date("2026-07-26T00:00:00.000Z");
    const lease = await acquireResourceLease({
      storePath,
      owner: "task-b",
      claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
      now,
    });

    await expect(
      transferResourceLeaseOwnership({
        storePath,
        leaseId: lease.id,
        owner: "ATTACKER",
        expectedOwner: "someone-else",
        expectedFence: lease.fence,
        now,
      }),
    ).rejects.toThrow(/owned by task-b/u);

    const [current] = await listActiveResourceLeases({ storePath, now });
    expect(current?.owner).toBe("task-b");
  });

  it("requires the expected owner on release and transfer — no anonymous drops", async () => {
    const storePath = await createStorePath();
    const now = new Date("2026-07-26T00:00:00.000Z");
    const lease = await acquireResourceLease({
      storePath,
      owner: "task-owner",
      claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
      now,
    });

    // The parameter is required at the type level; the runtime check backs it
    // for JS callers. System-side reaping of dead owners goes through
    // releaseOrphanedLeases, which proves liveness instead of ownership.
    await expect(
      releaseResourceLease({
        storePath,
        leaseId: lease.id,
        expectedOwner: "",
        expectedFence: lease.fence,
        now,
      }),
    ).rejects.toThrow(/requires the expected owner/u);
    await expect(
      transferResourceLeaseOwnership({
        storePath,
        leaseId: lease.id,
        owner: "task-next",
        expectedOwner: "",
        expectedFence: lease.fence,
        now,
      }),
    ).rejects.toThrow(/requires the expected current owner/u);

    // The lease survived both refused attempts.
    await expect(listActiveResourceLeases({ storePath, now })).resolves.toHaveLength(1);
  });

  it("reaps orphans under a single lock, sparing a lease acquired under an invocation id", async () => {
    const storePath = await createStorePath();
    const now = new Date("2026-07-26T00:00:00.000Z");
    const allocating = await acquireResourceLease({
      storePath,
      owner: "invocation-9",
      claims: [{ kind: "write", resource: "src/a/**", mode: "exclusive" }],
      now,
    });
    const orphan = await acquireResourceLease({
      storePath,
      owner: "task-dead",
      claims: [{ kind: "write", resource: "src/b/**", mode: "exclusive" }],
      now,
    });

    const reaped = await releaseOrphanedLeases({
      storePath,
      // The caller reports both ids a live run can own a lease under.
      aliveOwnerIds: new Set(["invocation-9", "task-live"]),
      now,
    });

    expect(reaped).toEqual([orphan.id]);
    const remaining = await listActiveResourceLeases({ storePath, now });
    expect(remaining.map((lease) => lease.id)).toEqual([allocating.id]);
  });
});

describe("malformed claims (§2.8)", () => {
  it("rejects a bogus claim at the request boundary", () => {
    expect(
      parseOrchestrationRequest({
        claims: [{ kind: "bogus", resource: "src/**", mode: "wat" }],
      }),
    ).toBeUndefined();

    // A well-formed request still parses.
    expect(
      parseOrchestrationRequest({
        claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
      }),
    ).toMatchObject({
      claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
    });
  });

  it("rejects a bogus claim at the acquire boundary", async () => {
    const storePath = await createStorePath();
    await expect(
      acquireResourceLease({
        storePath,
        owner: "task-a",
        // The vector that bypassed the tool schema: a claim round-tripped
        // through the run store and re-acquired on recovery.
        claims: [{ kind: "bogus", resource: "src/**", mode: "wat" }] as never,
      }),
    ).rejects.toThrow(/Invalid resource claim/u);
  });

  it("recognizes exactly the claims the store can persist", () => {
    expect(isResourceClaim({ kind: "write", resource: "a", mode: "shared" })).toBe(true);
    expect(isResourceClaim({ kind: "bogus", resource: "a", mode: "shared" })).toBe(false);
    expect(isResourceClaim({ kind: "write", resource: "a", mode: "wat" })).toBe(false);
    expect(isResourceClaim({ kind: "write", mode: "shared" })).toBe(false);
    expect(isResourceClaim(null)).toBe(false);
  });

  it("quarantines an unreadable store instead of bricking every write", async () => {
    const directory = await createStoreDirectory();
    const storePath = join(directory, "leases.json");
    await writeFile(storePath, "{ not json at all", "utf8");

    const reports: { reason: string; quarantinePath: string }[] = [];
    setStoreQuarantineReporter((info) => reports.push(info));

    // Every one of these used to throw "Invalid resource lease store" forever.
    const lease = await acquireResourceLease({
      storePath,
      owner: "task-a",
      claims: [{ kind: "write", resource: "src/**", mode: "exclusive" }],
    });
    expect(lease.fence).toBe(1);
    await expect(listActiveResourceLeases({ storePath })).resolves.toHaveLength(1);

    expect(reports).toHaveLength(1);
    expect(reports[0]?.reason).toMatch(/unparseable JSON/u);

    // The bad file was moved aside, not deleted — it is evidence.
    const entries = await readdir(directory);
    expect(entries.some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("quarantines a store holding a claim that fails validation", async () => {
    const storePath = await createStorePath();
    await writeFile(
      storePath,
      JSON.stringify({
        version: 2,
        nextFence: 4,
        leases: [
          {
            id: "lease-1",
            owner: "task-a",
            claims: [{ kind: "bogus", resource: "src/**", mode: "wat" }],
            acquiredAt: "2026-07-26T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
            fence: 3,
          },
        ],
      }),
      "utf8",
    );

    const reports: string[] = [];
    setStoreQuarantineReporter((info) => reports.push(info.reason));

    await expect(listActiveResourceLeases({ storePath })).resolves.toEqual([]);
    expect(reports).toEqual(["store failed schema validation"]);
  });
});

describe("store migration (S-F)", () => {
  it("reads a v1 store and assigns fences in persisted order", async () => {
    const storePath = await createStorePath();
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        leases: [
          {
            id: "lease-old-1",
            owner: "task-a",
            claims: [{ kind: "write", resource: "src/a/**", mode: "exclusive" }],
            acquiredAt: "2026-07-26T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          {
            id: "lease-old-2",
            owner: "task-b",
            claims: [{ kind: "write", resource: "src/b/**", mode: "exclusive" }],
            acquiredAt: "2026-07-26T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const leases = await listActiveResourceLeases({ storePath });
    expect(leases.map((lease) => lease.fence)).toEqual([1, 2]);

    // A new lease continues above the migrated ones rather than colliding.
    const next = await acquireResourceLease({
      storePath,
      owner: "task-c",
      claims: [{ kind: "write", resource: "src/c/**", mode: "exclusive" }],
    });
    expect(next.fence).toBe(3);
  });

  it("quarantines a store written by a NEWER build rather than reinterpreting it", async () => {
    const storePath = await createStorePath();
    await writeFile(
      storePath,
      JSON.stringify({ version: 99, nextFence: 1, leases: [] }),
      "utf8",
    );

    const reports: string[] = [];
    setStoreQuarantineReporter((info) => reports.push(info.reason));

    await expect(listActiveResourceLeases({ storePath })).resolves.toEqual([]);
    expect(reports).toEqual(["store failed schema validation"]);
  });

  it("quarantines v2 stores with duplicate or rewound fence state", async () => {
    for (const leases of [
      [
        {
          id: "lease-a",
          owner: "task-a",
          claims: [{ kind: "write", resource: "src/a/**", mode: "exclusive" }],
          acquiredAt: "2026-07-26T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          fence: 1,
        },
        {
          id: "lease-b",
          owner: "task-b",
          claims: [{ kind: "write", resource: "src/b/**", mode: "exclusive" }],
          acquiredAt: "2026-07-26T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          fence: 1,
        },
      ],
      [
        {
          id: "lease-a",
          owner: "task-a",
          claims: [{ kind: "write", resource: "src/a/**", mode: "exclusive" }],
          acquiredAt: "2026-07-26T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          fence: 3,
        },
      ],
    ] as const) {
      const storePath = await createStorePath();
      await writeFile(
        storePath,
        JSON.stringify({ version: 2, nextFence: 3, leases }),
        "utf8",
      );
      const reports: string[] = [];
      setStoreQuarantineReporter((info) => reports.push(info.reason));
      await expect(listActiveResourceLeases({ storePath })).resolves.toEqual([]);
      expect(reports).toEqual(["store failed schema validation"]);
      setStoreQuarantineReporter(() => undefined);
    }
  });
});
