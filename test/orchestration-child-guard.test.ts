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
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type, type TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { acquireResourceLease } from "../src/orchestration/claims.ts";
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

async function bootChild(projectDirectory: string, ownerIds: string[]): Promise<{
  guard: ToolCallHandler;
  leaseStore: string;
}> {
  const leaseStore = join(
    projectDirectory,
    ".pi",
    "artifacts",
    "tasks",
    "orchestration",
    "leases.json",
  );
  process.env.PI_TASK_TOOL_DISABLED = "1";
  process.env[CHILD_CLAIM_GUARD_ENV] = JSON.stringify({
    version: 1,
    projectDirectory,
    leaseStore,
    ownerIds,
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
    const { guard, leaseStore } = await bootChild(projectDirectory, [
      "task-child",
      "invocation-child",
    ]);

    await acquireResourceLease({
      storePath: leaseStore,
      owner: "task-other",
      claims: [{ kind: "write", resource: "src/auth/**", mode: "exclusive" }],
    });

    const verdict = await guard(
      { toolName: "write", input: { path: join(projectDirectory, "src/auth/token.ts") } },
      { cwd: projectDirectory },
    );
    expect(verdict).toMatchObject({ block: true });
    expect((verdict as { reason: string }).reason).toMatch(/claimed by task task-other/u);
  });

  it("allows the child to write paths covered by its own lease — under either identity", async () => {
    const projectDirectory = await createProject();
    const { guard, leaseStore } = await bootChild(projectDirectory, [
      "task-child",
      "invocation-child",
    ]);

    // Acquired under the invocation id at launch…
    await acquireResourceLease({
      storePath: leaseStore,
      owner: "invocation-child",
      claims: [{ kind: "write", resource: "src/auth/**", mode: "exclusive" }],
    });
    await expect(
      guard(
        { toolName: "edit", input: { path: join(projectDirectory, "src/auth/token.ts") } },
        { cwd: projectDirectory },
      ),
    ).resolves.toBeUndefined();
  });

  it("allows unclaimed paths and ignores writes outside the parent project", async () => {
    const projectDirectory = await createProject();
    const elsewhere = await createProject();
    const { guard } = await bootChild(projectDirectory, ["task-child"]);

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
          version: 1,
          projectDirectory: "/p",
          leaseStore: "/p/leases.json",
          ownerIds: ["a", "b"],
        }),
      ),
    ).toMatchObject({ ownerIds: ["a", "b"] });

    expect(parseChildClaimGuardConfig(undefined)).toBeUndefined();
    expect(parseChildClaimGuardConfig("not json")).toBeUndefined();
    expect(
      parseChildClaimGuardConfig(JSON.stringify({ version: 2, ownerIds: [] })),
    ).toBeUndefined();
    expect(
      parseChildClaimGuardConfig(
        JSON.stringify({ version: 1, projectDirectory: "/p", leaseStore: "/l", ownerIds: [1] }),
      ),
    ).toBeUndefined();
  });
});
