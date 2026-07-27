/**
 * Write-claim enforcement inside a CHILD Pi process (audit S-A).
 *
 * The child used to return from `createTaskRuntime` before the guard was
 * registered, so the process doing the delegated writing was the one whose
 * writes were never checked against the lease store. These tests boot the
 * runtime exactly as a child boots it — `PI_TASK_TOOL_DISABLED=1` plus the
 * guard config env the parent now passes — and drive `tool_call` events at it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type, type TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  acquireResourceLease,
  assertNoConflictingWrite,
  transferResourceLeaseOwnership,
  type ResourceLease,
} from "../src/orchestration/claims.ts";
import {
  CHILD_CLAIM_GUARD_ENV,
  createTaskRuntime,
  parseChildClaimGuardConfig,
} from "../src/orchestration/runtime.ts";

const temporaryDirectories: string[] = [];

async function createProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "md-harness-child-guard-"));
  temporaryDirectories.push(directory);
  return directory;
}

type ToolCallHandler = (
  event: { toolName: string; input: Record<string, unknown> },
  ctx: { cwd: string },
) => Promise<{ block: boolean; reason?: string } | undefined | void>;

/** The minimal ExtensionAPI surface the child branch touches. */
function createChildPi(): { api: ExtensionAPI; toolCallHandlers: ToolCallHandler[] } {
  const toolCallHandlers: ToolCallHandler[] = [];
  const api = {
    on(event: string, handler: unknown) {
      if (event === "tool_call") toolCallHandlers.push(handler as ToolCallHandler);
      return () => undefined;
    },
    registerTool() {
      /* child upstream registers its tools; irrelevant here */
    },
    events: { on: () => () => undefined, emit: () => undefined },
    sendMessage() {
      /* not used by the child guard */
    },
  } as unknown as ExtensionAPI;
  return { api, toolCallHandlers };
}

afterEach(async () => {
  delete process.env.PI_TASK_TOOL_DISABLED;
  delete process.env[CHILD_CLAIM_GUARD_ENV];
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function leaseStoreFor(projectDirectory: string): string {
  return join(
    projectDirectory,
    ".pi",
    "artifacts",
    "tasks",
    "orchestration",
    "leases.json",
  );
}

function guardStateFor(projectDirectory: string): string {
  return join(
    projectDirectory,
    ".pi",
    "artifacts",
    "tasks",
    "orchestration",
    "claim-guards",
    "invocation-child.json",
  );
}

async function writeGuardState(
  projectDirectory: string,
  lease: ResourceLease,
): Promise<void> {
  const path = guardStateFor(projectDirectory);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        version: 1,
        invocationId: "invocation-child",
        leaseId: lease.id,
        owner: lease.owner,
        fence: lease.fence,
        claims: lease.claims,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function bootChild(
  projectDirectory: string,
  guardStateRequired = false,
): Promise<{
  guard: ToolCallHandler;
  leaseStore: string;
}> {
  const leaseStore = leaseStoreFor(projectDirectory);
  process.env.PI_TASK_TOOL_DISABLED = "1";
  process.env[CHILD_CLAIM_GUARD_ENV] = JSON.stringify({
    version: 2,
    projectDirectory,
    leaseStore,
    guardStatePath: guardStateFor(projectDirectory),
    guardStateRequired,
  });

  const { api, toolCallHandlers } = createChildPi();
  createTaskRuntime((pi) => {
    // A minimal upstream: the child resolves tools through it.
    pi.registerTool({
      name: "task",
      label: "Task",
      description: "noop",
      parameters: Type.Object({}) as TSchema,
      async execute() {
        return { content: [] };
      },
    } as never);
  })(api);

  const guard = toolCallHandlers[0];
  if (!guard) throw new Error("child guard was not registered");
  return { guard, leaseStore };
}

describe("child write-claim guard (S-A)", () => {
  it("blocks a child writing a path another task holds exclusively", async () => {
    const projectDirectory = await createProject();
    const leaseStore = leaseStoreFor(projectDirectory);

    await acquireResourceLease({
      storePath: leaseStore,
      owner: "task-other",
      claims: [{ kind: "write", resource: "src/auth/**", mode: "exclusive" }],
    });
    const { guard } = await bootChild(projectDirectory);

    const verdict = await guard(
      { toolName: "write", input: { path: join(projectDirectory, "src/auth/token.ts") } },
      { cwd: projectDirectory },
    );
    expect(verdict).toMatchObject({ block: true });
    expect((verdict as { reason: string }).reason).toMatch(/owned by task-other/u);
  });

  it("allows a child only under the exact live lease generation", async () => {
    const projectDirectory = await createProject();
    const leaseStore = leaseStoreFor(projectDirectory);

    const lease = await acquireResourceLease({
      storePath: leaseStore,
      owner: "invocation-child",
      claims: [{ kind: "write", resource: "src/auth/**", mode: "exclusive" }],
    });
    await writeGuardState(projectDirectory, lease);
    const { guard } = await bootChild(projectDirectory, true);
    await expect(
      guard(
        { toolName: "edit", input: { path: join(projectDirectory, "src/auth/token.ts") } },
        { cwd: projectDirectory },
      ),
    ).resolves.toBeUndefined();
  });

  it("blocks a stale child after ownership transfer or fence advancement", async () => {
    const projectDirectory = await createProject();
    const leaseStore = leaseStoreFor(projectDirectory);

    const issued = await acquireResourceLease({
      storePath: leaseStore,
      owner: "invocation-child",
      claims: [{ kind: "write", resource: "src/auth/**", mode: "exclusive" }],
    });
    await writeGuardState(projectDirectory, issued);
    const { guard } = await bootChild(projectDirectory, true);
    const transferred = await transferResourceLeaseOwnership({
      storePath: leaseStore,
      leaseId: issued.id,
      owner: "task-child",
      expectedOwner: "invocation-child",
      expectedFence: issued.fence,
    });

    // A fence-aware caller holding the issued generation is refused…
    await expect(
      assertNoConflictingWrite({
        storePath: leaseStore,
        ownerTaskId: "task-child",
        path: "src/auth/token.ts",
        fence: issued.fence,
      }),
    ).rejects.toThrow(/lease was superseded/u);

    const staleVerdict = await guard(
      { toolName: "write", input: { path: join(projectDirectory, "src/auth/token.ts") } },
      { cwd: projectDirectory },
    );
    expect(staleVerdict).toMatchObject({ block: true });
    expect((staleVerdict as { reason: string }).reason).toMatch(/fence/u);

    await writeGuardState(projectDirectory, transferred);
    await expect(
      guard(
        { toolName: "write", input: { path: join(projectDirectory, "src/auth/token.ts") } },
        { cwd: projectDirectory },
      ),
    ).resolves.toBeUndefined();
  });

  it("fails closed when a claimed launch has no runtime guard state", async () => {
    const projectDirectory = await createProject();
    const { guard } = await bootChild(projectDirectory, true);
    const verdict = await guard(
      { toolName: "write", input: { path: join(projectDirectory, "src/auth/token.ts") } },
      { cwd: projectDirectory },
    );
    expect(verdict).toMatchObject({ block: true });
    expect((verdict as { reason: string }).reason).toMatch(/generation is unavailable/u);
  });

  it("allows unclaimed paths and ignores writes outside the parent project", async () => {
    const projectDirectory = await createProject();
    const elsewhere = await createProject();
    const { guard } = await bootChild(projectDirectory);

    await expect(
      guard(
        { toolName: "write", input: { path: join(projectDirectory, "README.md") } },
        { cwd: projectDirectory },
      ),
    ).resolves.toBeUndefined();

    // A worktree or temp path resolves outside the parent project; the merge
    // gate owns those writes, not the lease store.
    await expect(
      guard(
        { toolName: "write", input: { path: join(elsewhere, "src/auth/token.ts") } },
        { cwd: elsewhere },
      ),
    ).resolves.toBeUndefined();
  });

  it("registers no guard without the env — plain child sessions are unchanged", async () => {
    process.env.PI_TASK_TOOL_DISABLED = "1";
    const { api, toolCallHandlers } = createChildPi();
    createTaskRuntime((pi) => {
      pi.registerTool({
        name: "task",
        label: "Task",
        description: "noop",
        parameters: Type.Object({}) as TSchema,
        async execute() {
          return { content: [] };
        },
      } as never);
    })(api);
    expect(toolCallHandlers).toHaveLength(0);
  });
});

describe("guard config parsing", () => {
  it("accepts a well-formed config and rejects everything else", () => {
    expect(
      parseChildClaimGuardConfig(
        JSON.stringify({
          version: 2,
          projectDirectory: "/p",
          leaseStore: "/p/leases.json",
          guardStatePath: "/p/guard.json",
          guardStateRequired: true,
        }),
      ),
    ).toMatchObject({
      version: 2,
      projectDirectory: "/p",
      guardStatePath: "/p/guard.json",
      guardStateRequired: true,
    });

    expect(parseChildClaimGuardConfig(undefined)).toBeUndefined();
    expect(parseChildClaimGuardConfig("not json")).toBeUndefined();
    expect(
      parseChildClaimGuardConfig(JSON.stringify({ version: 1, ownerIds: [] })),
    ).toBeUndefined();
    expect(
      parseChildClaimGuardConfig(
        JSON.stringify({
          version: 2,
          projectDirectory: "/p",
          leaseStore: "/l",
          guardStatePath: "/p/g",
          guardStateRequired: "yes",
        }),
      ),
    ).toBeUndefined();
  });
});
