import { existsSync, type Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { claimsConflict, listActiveResourceLeases } from "./claims.js";
import { loadContextPack } from "./context.js";
import { resolveTaskSessionReference } from "./lifecycle.js";
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
  issues.push(...validateCeremony(input.ceremonySteps ?? []));
  issues.push(
    ...(await validateRuntimeParity(input.projectDirectory)),
    ...(await validateTaskHistory(input.projectDirectory)),
    ...(await validateLifecycleEvents(input.projectDirectory, now, staleAfterMs)),
    ...(await validateResourceLeases(input.projectDirectory, now)),
    ...(await validateContextEvidence(input.projectDirectory, now, staleAfterMs)),
  );

  return {
    ok: issues.length === 0,
    status: issues.length === 0 ? "healthy" : "issues",
    exitCode: issues.length === 0 ? 0 : 1,
    issues,
  };
}

function validateDelegationContract(prompt: string): DoctorIssue[] {
  const requiredSections = [
    ["goal", /(?:^|\n)\s*goal\s*:/iu],
    ["complete context", /(?:^|\n)\s*(?:complete\s+)?context\s*:/iu],
    ["non-goals", /(?:^|\n)\s*non-goals?\s*:/iu],
    ["read/write policy", /(?:^|\n)\s*read\/write\s+policy\s*:/iu],
    ["expected output", /(?:^|\n)\s*expected\s+output\s*:/iu],
    ["stop condition", /(?:^|\n)\s*stop\s+condition\s*:/iu],
    ["verification recipe", /(?:^|\n)\s*verification\s+recipe\s*:/iu],
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

function validateCeremony(steps: readonly CeremonyStep[]): DoctorIssue[] {
  return steps
    .filter((step) => !step.uniqueValue.trim())
    .map((step) => ({
      code: "valueless-ceremony",
      severity: "warning" as const,
      message: `Ceremony step has no unique value: ${step.name}.`,
      remediation:
        "Remove the step or state the distinct safety, information, or proof it provides.",
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
  if (!existsSync(liveEntryPath)) {
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
  if (!packagedExtensions.includes("./dist/task-runtime.js")) {
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
  const events = await readOrchestrationEvents(eventPath);
  const terminalTaskIds = new Set(
    events
      .filter(
        (event) => event.type === "task_completed" || event.type === "task_failed",
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
  const leases = await listActiveResourceLeases({ storePath, now });
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
    const pack = await loadContextPack({ storeDirectory, key });
    if (!pack) {
      continue;
    }
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
