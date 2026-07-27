import { existsSync, type Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { claimsConflict, listActiveResourceLeases } from "./claims.js";
import { loadContextPack } from "./context.js";
import { resolveTaskSessionReference } from "./lifecycle.js";
import { getOrchestrationPaths } from "./paths.js";
import {
  isTerminalExecutionPhase,
  listDurableRuns,
} from "./run-store.js";
import { readOrchestrationEvents } from "./telemetry.js";

export type DoctorIssueSeverity = "error" | "warning";

export interface DoctorIssue {
  code: string;
  severity: DoctorIssueSeverity;
  message: string;
  remediation: string;
  reference?: string;
}

export interface DoctorResult {
  ok: boolean;
  status: "healthy" | "issues";
  exitCode: 0 | 1;
  issues: DoctorIssue[];
}

export interface CeremonyStep {
  name: string;
  uniqueValue: string;
}

export async function runOrchestrationDoctor(input: {
  projectDirectory: string;
  delegationPrompt?: string;
  ceremonySteps?: readonly CeremonyStep[];
  now?: Date;
  staleAfterMs?: number;
}): Promise<DoctorResult> {
  const now = input.now ?? new Date();
  const staleAfterMs = input.staleAfterMs ?? 30 * 60 * 1_000;
  const issues: DoctorIssue[] = [];

  if (input.delegationPrompt !== undefined) {
    issues.push(...validateDelegationContract(input.delegationPrompt));
  }
  issues.push(...validateCeremony(input.ceremonySteps ?? [], input.projectDirectory));
  const checks = await Promise.all([
    safeDoctorCheck("runtime-parity-check-failed", () =>
      validateRuntimeParity(input.projectDirectory),
    ),
    safeDoctorCheck("task-history-check-failed", () =>
      validateTaskHistory(input.projectDirectory),
    ),
    safeDoctorCheck("durable-run-check-failed", () =>
      validateDurableRuns(input.projectDirectory, now, staleAfterMs),
    ),
    safeDoctorCheck("lifecycle-check-failed", () =>
      validateLifecycleEvents(input.projectDirectory, now, staleAfterMs),
    ),
    safeDoctorCheck("lease-check-failed", () =>
      validateResourceLeases(input.projectDirectory, now),
    ),
    safeDoctorCheck("context-check-failed", () =>
      validateContextEvidence(input.projectDirectory, now, staleAfterMs),
    ),
    safeDoctorCheck("ship-gate-check-failed", () =>
      validateShipGate(input.projectDirectory),
    ),
    safeDoctorCheck("write-claim-check-failed", () =>
      validateWriteClaims(input.projectDirectory),
    ),
  ]);
  issues.push(...checks.flat());

  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? "healthy" : "issues",
    exitCode: issues.length === 0 ? 0 : 1,
    issues,
  };
}

async function safeDoctorCheck(
  code: string,
  check: () => Promise<DoctorIssue[]>,
): Promise<DoctorIssue[]> {
  try {
    return await check();
  } catch (error) {
    return [
      {
        code,
        severity: "error",
        message: `Doctor check failed: ${error instanceof Error ? error.message : String(error)}`,
        remediation:
          "Inspect the referenced orchestration files and rerun /task-doctor after repair.",
      },
    ];
  }
}

function validateDelegationContract(prompt: string): DoctorIssue[] {
  // Two contract dialects are accepted: the governed-outcome contract
  // (outcome/frontier/locked decisions/acceptance) and the legacy recipe
  // contract (goal/expected output/stop condition/verification recipe).
  // Acceptance subsumes the three legacy verification sections.
  const requiredSections = [
    ["goal or outcome", /(?:^|\n)\s*(?:goal|outcome)\s*:/iu],
    ["complete context", /(?:^|\n)\s*(?:complete\s+)?context\s*:/iu],
    ["non-goals", /(?:^|\n)\s*non-goals?\s*:/iu],
    ["read/write policy", /(?:^|\n)\s*(?:read\/write|write\/read)\s+policy\s*:/iu],
    ["expected output or acceptance", /(?:^|\n)\s*(?:expected\s+output|acceptance)\s*:/iu],
    ["stop condition or acceptance", /(?:^|\n)\s*(?:stop\s+condition|acceptance)\s*:/iu],
    [
      "verification recipe or acceptance",
      /(?:^|\n)\s*(?:verification\s+recipe|acceptance)\s*:/iu,
    ],
  ] as const;
  const missing = requiredSections
    .filter(([, pattern]) => !pattern.test(prompt))
    .map(([name]) => name);

  return missing.length === 0
    ? []
    : [
        {
          code: "delegation-contract-incomplete",
          severity: "error",
          message: `Delegation contract is missing: ${missing.join(", ")}.`,
          remediation:
            "Add every required delegation section before launching the task.",
        },
      ];
}

function validateCeremony(
  steps: readonly CeremonyStep[],
  projectDirectory: string,
): DoctorIssue[] {
  // Herdr §11.3 (anti-ceremony): every ceremony component must justify itself with
  // real substance. A non-empty-string check is itself the ceremony it warns against,
  // so a uniqueValue must be VERIFIABLE — an existing artifact path or a content hash —
  // or the step is valueless ceremony at error severity.
  return steps
    .filter((step) => {
      const value = step.uniqueValue.trim();
      if (!value) return true;
      const isHash = /^[a-f0-9]{16,}$/iu.test(value);
      const isExistingArtifact =
        existsSync(value) || existsSync(join(projectDirectory, value));
      return !isHash && !isExistingArtifact;
    })
    .map((step) => ({
      code: "valueless-ceremony",
      severity: "error" as const,
      message: `Ceremony step "${step.name}" has no verifiable unique value: "${step.uniqueValue}".`,
      remediation:
        "Point uniqueValue at a real produced artifact (path) or its content hash, or remove the step — ceremony must justify itself with proof (Herdr §11.3).",
    }));
}

async function validateRuntimeParity(
  projectDirectory: string,
): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const settingsPath = join(projectDirectory, ".pi", "settings.json");
  const liveEntryPath = join(projectDirectory, ".pi", "extensions", "task.ts");
  const packageManifestPath = join(projectDirectory, "package", "package.json");

  const settings = await readJson(settingsPath);
  const packages = isRecord(settings) && Array.isArray(settings.packages)
    ? settings.packages
    : [];
  if (
    packages.some(
      (entry) =>
        typeof entry === "string" &&
        (entry.includes("@heyhuynhgiabuu/pi-task") ||
          entry.includes("@hey-api-herd/herd")),
    )
  ) {
    issues.push({
      code: "runtime-package-drift",
      severity: "error",
      message: "Live settings load the upstream task package directly.",
      remediation:
        "Load the project-owned task wrapper so live and packaged behavior share one contract.",
      reference: settingsPath,
    });
  }

  // Additive/external-package integration: a consumer that loads the runtime
  // through .pi/settings.json `packages` (e.g. npm:@minhduydev/pi-subagents@...)
  // is a valid architecture. The wrapper and packaged runtime are provided by
  // the pinned package, so the embedded-source wiring checks below do not apply
  // and must not be flagged as runtime-wrapper-missing/packaged-runtime-drift.
  const externallyProvidedRuntime = hasPiSubagentsPackage(packages);

  if (!externallyProvidedRuntime && !existsSync(liveEntryPath)) {
    issues.push({
      code: "runtime-wrapper-missing",
      severity: "error",
      message: "The live task wrapper entrypoint is missing.",
      remediation: "Create .pi/extensions/task.ts and load the upstream task through it.",
      reference: liveEntryPath,
    });
  }

  const packageManifest = await readJson(packageManifestPath);
  const packagedExtensions =
    isRecord(packageManifest) &&
    isRecord(packageManifest.pi) &&
    Array.isArray(packageManifest.pi.extensions)
      ? packageManifest.pi.extensions
      : [];
  if (
    !externallyProvidedRuntime &&
    !packagedExtensions.includes("./dist/task-runtime.js")
  ) {
    issues.push({
      code: "packaged-runtime-drift",
      severity: "error",
      message: "The publishable package does not load the task wrapper.",
      remediation:
        "Point package.pi.extensions at ./dist/task-runtime.js before the kernel.",
      reference: packageManifestPath,
    });
  }

  return issues;
}

function hasPiSubagentsPackage(packages: unknown): boolean {
  if (!Array.isArray(packages)) {
    return false;
  }
  return packages.some(
    (entry) =>
      typeof entry === "string" &&
      (entry.includes("@minhduydev/pi-subagents") ||
        /\/pi-subagents\//u.test(entry)),
  );
}

async function validateTaskHistory(
  projectDirectory: string,
): Promise<DoctorIssue[]> {
  const historyPath = join(projectDirectory, ".pi", "task-session-history.json");
  const history = await readJson(historyPath);
  if (!Array.isArray(history)) {
    return [];
  }

  const issues: DoctorIssue[] = [];
  for (const entry of history) {
    if (
      !isRecord(entry) ||
      (entry.status !== "completed" && entry.status !== "done")
    ) {
      continue;
    }
    const taskId = stringField(entry, "id") ?? stringField(entry, "taskId");
    const sessionName = stringField(entry, "sessionName");
    if (!taskId || !sessionName) {
      continue;
    }
    const resolved = await resolveTaskSessionReference({
      projectDirectory,
      taskId,
      sessionName,
      recordedSessionReference: stringField(entry, "sessionRef"),
    });
    if (!resolved) {
      issues.push({
        code: "unresolved-task-session",
        severity: "error",
        message: `Completed task ${taskId} has no resolvable session.`,
        remediation:
          "Persist the canonical session reference and add a completed-task resume regression test.",
        reference: historyPath,
      });
    }
  }
  return issues;
}

async function validateDurableRuns(
  projectDirectory: string,
  now: Date,
  staleAfterMs: number,
): Promise<DoctorIssue[]> {
  const paths = getOrchestrationPaths(projectDirectory);
  let runs: Awaited<ReturnType<typeof listDurableRuns>>;
  try {
    runs = await listDurableRuns(paths.runStore);
  } catch (error) {
    return [
      {
        code: "run-store-corrupt",
        severity: "error",
        message: `Durable task store cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        remediation: "Restore runs.json from version control/backup or move it aside after inspecting active tasks.",
        reference: paths.runStore,
      },
    ];
  }
  const issues: DoctorIssue[] = [];
  for (const run of runs) {
    const label = run.taskId ?? run.invocationId;
    if (
      !isTerminalExecutionPhase(run.executionPhase) &&
      now.getTime() - Date.parse(run.heartbeatAt) > staleAfterMs
    ) {
      issues.push({
        code: "stale-run-heartbeat",
        severity: "warning",
        message: `Task ${label} has a stale durable heartbeat.`,
        remediation: "Reconnect its backend, resume it, or stop it and release its lease.",
        reference: paths.runStore,
      });
    }
    if (run.verificationPhase === "failed") {
      issues.push({
        code: "verification-failed",
        severity: "error",
        message: `Task ${label} failed verification: ${run.verificationIssues.join(" ")}`,
        remediation: "Produce fresh local evidence or rerun the delegated task.",
        reference: paths.runStore,
      });
    }
    if (
      run.worktreeDisposition === "retained" &&
      (!run.worktree || !existsSync(run.worktree.path))
    ) {
      issues.push({
        code: "retained-worktree-missing",
        severity: "error",
        message: `Task ${label} records a retained worktree that no longer exists.`,
        remediation:
          "Restore the owned worktree/branch, or explicitly mark the task worktree removed after confirming the changes are no longer needed.",
        reference: run.worktree?.path ?? paths.runStore,
      });
    }
    if (
      isTerminalExecutionPhase(run.executionPhase) &&
      run.worktree &&
      run.worktreeDisposition === undefined
    ) {
      issues.push({
        code: "worktree-disposition-unknown",
        severity: "warning",
        message: `Task ${label} completed without a durable worktree disposition.`,
        remediation:
          "Inspect the task worktree, then use task_control worktree_status, worktree_merge, or worktree_remove.",
        reference: run.worktree.path,
      });
    }
    if (run.reviewPhase === "awaiting") {
      issues.push({
        code: "awaiting-review",
        severity: "warning",
        message: `Task ${label} is awaiting independent review.`,
        remediation: "Complete a distinct reviewer task, record its receipt, then ship.",
        reference: paths.runStore,
      });
    }
  }
  return issues;
}

async function validateLifecycleEvents(
  projectDirectory: string,
  now: Date,
  staleAfterMs: number,
): Promise<DoctorIssue[]> {
  const eventPath = join(
    projectDirectory,
    ".pi",
    "artifacts",
    "tasks",
    "orchestration",
    "events.jsonl",
  );
  let events: Awaited<ReturnType<typeof readOrchestrationEvents>>;
  try {
    events = await readOrchestrationEvents(eventPath);
  } catch (error) {
    return [
      {
        code: "event-journal-corrupt",
        severity: "error",
        message: `Correctness event journal cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        remediation:
          "Preserve the journal for diagnosis, repair malformed non-tail records, then rerun /task-doctor.",
        reference: eventPath,
      },
    ];
  }
  const terminalTaskIds = new Set(
    events
      .filter(
        (event) =>
          event.type === "task_execution_completed" ||
          event.type === "task_completed" ||
          event.type === "task_failed" ||
          event.type === "task_cancelled" ||
          event.type === "task_timed_out",
      )
      .map((event) => event.taskId)
      .filter((taskId): taskId is string => taskId !== undefined),
  );
  const issues: DoctorIssue[] = [];

  for (const event of events) {
    if (
      (event.type === "task_started" || event.type === "task_resumed") &&
      event.taskId &&
      !terminalTaskIds.has(event.taskId) &&
      now.getTime() - Date.parse(event.timestamp) > staleAfterMs
    ) {
      issues.push({
        code: "stale-task",
        severity: "warning",
        message: `Task ${event.taskId} is stale.`,
        remediation: "Inspect its session, then resume, cancel, or release its claims.",
        reference: eventPath,
      });
    }
    if ((event.retryCount ?? 0) >= 3) {
      issues.push({
        code: "repeated-retries",
        severity: "warning",
        message: `Task ${event.taskId ?? event.orchestrationId} retried ${event.retryCount} times.`,
        remediation:
          "Change the hypothesis or escalate instead of repeating the same repair loop.",
        reference: eventPath,
      });
    }
  }
  return issues;
}

async function validateShipGate(
  projectDirectory: string,
): Promise<DoctorIssue[]> {
  const eventPath = join(
    projectDirectory,
    ".pi",
    "artifacts",
    "tasks",
    "orchestration",
    "events.jsonl",
  );
  const events = await readOrchestrationEvents(eventPath).catch(() => []);
  const lastBlocked = new Map<string, number>();
  const lastShipped = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.type === "task_ship_blocked" && event.taskId) {
      lastBlocked.set(event.taskId, index);
    }
    if (event.type === "task_shipped" && event.taskId) {
      lastShipped.set(event.taskId, index);
    }
  });
  const issues: DoctorIssue[] = [];
  for (const [taskId, blockedIndex] of lastBlocked) {
    const shippedIndex = lastShipped.get(taskId);
    if (shippedIndex === undefined || shippedIndex < blockedIndex) {
      issues.push({
        code: "unverified-ship",
        severity: "error",
        message: `Task ${taskId} was ship-blocked and never cleared by an independent review.`,
        remediation:
          "Record an independent review with task_control review, then task_control ship.",
        reference: eventPath,
      });
    }
  }
  return issues;
}

async function validateWriteClaims(
  _projectDirectory: string,
): Promise<DoctorIssue[]> {
  // A shared working-tree `git status` cannot attribute paths to one task and
  // produces false positives for pre-existing or concurrent changes. Write
  // coverage is therefore validated from an isolated worktree's changed-path
  // receipt during completion, never from global repository dirtiness here.
  return [];
}

async function validateResourceLeases(
  projectDirectory: string,
  now: Date,
): Promise<DoctorIssue[]> {
  const storePath = join(
    projectDirectory,
    ".pi",
    "artifacts",
    "tasks",
    "orchestration",
    "leases.json",
  );
  let leases: Awaited<ReturnType<typeof listActiveResourceLeases>>;
  try {
    leases = await listActiveResourceLeases({ storePath, now });
  } catch (error) {
    return [
      {
        code: "lease-store-corrupt",
        severity: "error",
        message: `Lease store cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        remediation:
          "Inspect active tasks before repairing leases.json; use PI_SUBAGENTS_NO_CLAIMS=1 only as an explicit emergency override.",
        reference: storePath,
      },
    ];
  }
  const issues: DoctorIssue[] = [];

  for (let leftIndex = 0; leftIndex < leases.length; leftIndex += 1) {
    const left = leases[leftIndex];
    if (!left) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < leases.length; rightIndex += 1) {
      const right = leases[rightIndex];
      if (!right || left.owner === right.owner) {
        continue;
      }
      for (const leftClaim of left.claims) {
        for (const rightClaim of right.claims) {
          if (claimsConflict(leftClaim, rightClaim)) {
            issues.push({
              code: "conflicting-active-claims",
              severity: "error",
              message: `Active leases ${left.id} and ${right.id} conflict.`,
              remediation: "Release one lease before continuing.",
              reference: storePath,
            });
          }
        }
      }
    }
  }
  return issues;
}

async function validateContextEvidence(
  projectDirectory: string,
  now: Date,
  staleAfterMs: number,
): Promise<DoctorIssue[]> {
  const storeDirectory = join(
    projectDirectory,
    ".pi",
    "artifacts",
    "tasks",
    "orchestration",
    "contexts",
  );
  let entries: Dirent[];
  try {
    entries = await readdir(storeDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const issues: DoctorIssue[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const key = entry.name.slice(0, -".json".length);
    let pack: Awaited<ReturnType<typeof loadContextPack>>;
    try {
      pack = await loadContextPack({ storeDirectory, key });
    } catch (error) {
      issues.push({
        code: "context-pack-corrupt",
        severity: "error",
        message: `Context Pack ${key} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        remediation: "Restore or recreate this Context Pack before resuming its task.",
        reference: join(storeDirectory, entry.name),
      });
      continue;
    }
    if (!pack) continue;
    for (const evidence of pack.evidence) {
      const recordedAt = evidence.recordedAt
        ? Date.parse(evidence.recordedAt)
        : Number.NaN;
      const age = now.getTime() - recordedAt;
      if (!Number.isFinite(recordedAt) || age < 0 || age > staleAfterMs) {
        issues.push({
          code: "stale-evidence",
          severity: "warning",
          message: `Context ${key} has stale or invalid evidence: ${evidence.reference}.`,
          remediation: "Refresh the evidence before making a completion claim.",
          reference: join(storeDirectory, entry.name),
        });
      }
    }
  }
  return issues;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    // Treat unparseable JSON as "no usable file" so a corrupt settings.json or
    // manifest cannot crash the doctor; downstream guards derive an empty view.
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
