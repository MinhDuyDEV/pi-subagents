import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { releaseResourceLease } from "./claims.js";
import {
  updateContextHandoff,
  type ContextHandoffPatch,
} from "./context.js";
import { runOrchestrationDoctor } from "./doctor.js";
import { getOrchestrationPaths } from "./paths.js";
import { getFinalTaskResult, getTaskSnapshot } from "./task-query.js";
import {
  appendOrchestrationEvent,
  deriveOrchestrationMetrics,
  readOrchestrationEvents,
} from "./telemetry.js";

const HandoffSchema = Type.Object(
  {
    decisions: Type.Optional(
      Type.Array(
        Type.Object(
          {
            statement: Type.String({ minLength: 1 }),
            rationale: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    evidence: Type.Optional(
      Type.Array(
        Type.Object(
          {
            description: Type.String({ minLength: 1 }),
            reference: Type.String({ minLength: 1 }),
            recorded_at: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    unknowns: Type.Optional(Type.Array(Type.String())),
    next_step: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const HerdrToolParameters = Type.Object(
  {
    action: Type.Union([
      Type.Literal("status"),
      Type.Literal("result"),
      Type.Literal("handoff"),
      Type.Literal("metrics"),
      Type.Literal("doctor"),
      Type.Literal("record_review"),
      Type.Literal("release"),
    ]),
    task_id: Type.Optional(Type.String({ minLength: 1 })),
    lease_id: Type.Optional(Type.String({ minLength: 1 })),
    handoff: Type.Optional(HandoffSchema),
    delegation_prompt: Type.Optional(Type.String()),
    ceremony_steps: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            unique_value: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    stale_after_ms: Type.Optional(Type.Number({ minimum: 1 })),
    review_findings: Type.Optional(Type.Integer({ minimum: 0 })),
    accepted_findings: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

type HerdrToolInput = Static<typeof HerdrToolParameters>;

export function registerHerdrTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "herdr",
    label: "HerdR",
    description:
      "Query task status/results, update Context Pack handoffs, inspect local orchestration metrics, run the orchestration doctor, or release a resource lease.",
    parameters: HerdrToolParameters,
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      return executeHerdrAction(input, ctx.cwd);
    },
  });
}

async function executeHerdrAction(
  input: HerdrToolInput,
  projectDirectory: string,
) {
  const paths = getOrchestrationPaths(projectDirectory);
  switch (input.action) {
    case "status":
      return taskStatusResult(projectDirectory, requireValue(input.task_id, "task_id"));
    case "result":
      return taskFinalResult(projectDirectory, requireValue(input.task_id, "task_id"));
    case "handoff": {
      const taskId = requireValue(input.task_id, "task_id");
      if (!input.handoff) {
        throw new Error("handoff is required for the handoff action");
      }
      const pack = await updateContextHandoff({
        storeDirectory: paths.contextStore,
        key: taskId,
        patch: normalizeHandoff(input.handoff),
      });
      await appendOrchestrationEvent({
        eventPath: paths.eventLog,
        event: {
          type: "handoff_updated",
          orchestrationId: `handoff-${taskId}`,
          taskId,
        },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated Context Pack ${taskId} to revision ${pack.revision}.`,
          },
        ],
        details: { taskId, revision: pack.revision, status: "updated" },
      };
    }
    case "metrics": {
      const events = await readOrchestrationEvents(paths.eventLog);
      const metrics = deriveOrchestrationMetrics({
        events,
        staleAfterMs: input.stale_after_ms,
      });
      return {
        content: [{ type: "text" as const, text: renderMetrics(metrics) }],
        details: metrics,
      };
    }
    case "doctor": {
      const result = await runOrchestrationDoctor({
        projectDirectory,
        delegationPrompt: input.delegation_prompt,
        ceremonySteps: input.ceremony_steps?.map((step) => ({
          name: step.name,
          uniqueValue: step.unique_value,
        })),
        staleAfterMs: input.stale_after_ms,
      });
      return {
        content: [{ type: "text" as const, text: renderDoctorResult(result) }],
        details: result,
      };
    }
    case "record_review": {
      const taskId = requireValue(input.task_id, "task_id");
      const findings = requireNumber(input.review_findings, "review_findings");
      const accepted = requireNumber(input.accepted_findings, "accepted_findings");
      if (accepted > findings) {
        throw new Error("accepted_findings must not exceed review_findings");
      }
      await appendOrchestrationEvent({
        eventPath: paths.eventLog,
        event: {
          type: "review_completed",
          orchestrationId: `review-${taskId}`,
          taskId,
          agentType: "reviewer",
          reviewFindings: findings,
          acceptedFindings: accepted,
        },
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Recorded review yield for ${taskId}: ${accepted}/${findings}.`,
          },
        ],
        details: { taskId, reviewFindings: findings, acceptedFindings: accepted },
      };
    }
    case "release": {
      const leaseId = requireValue(input.lease_id, "lease_id");
      const released = await releaseResourceLease({
        storePath: paths.leaseStore,
        leaseId,
      });
      if (!released) {
        return {
          content: [
            { type: "text" as const, text: `Lease ${leaseId} was not active.` },
          ],
          details: { leaseId, released: false },
        };
      }
      await appendOrchestrationEvent({
        eventPath: paths.eventLog,
        event: {
          type: "claim_released",
          orchestrationId: `manual-release-${leaseId}`,
          leaseId,
        },
      });
      return {
        content: [
          { type: "text" as const, text: `Released lease ${leaseId}.` },
        ],
        details: { leaseId, released: true },
      };
    }
  }
}

async function taskStatusResult(projectDirectory: string, taskId: string) {
    const snapshot = await getTaskSnapshot(projectDirectory, taskId);

  const lines = [
    `Task ID: ${taskId}`,
    `Status: ${snapshot.status}`,
    `Session reference: ${snapshot.sessionName}`,
  ];
  if (snapshot.sessionReference) {
    lines.push(`Session file: ${snapshot.sessionReference}`);
  }
  if (snapshot.description) {
    lines.push(`Description: ${snapshot.description}`);
  }
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: snapshot,
  };
}

async function taskFinalResult(projectDirectory: string, taskId: string) {
  const snapshot = await getTaskSnapshot(projectDirectory, taskId);
  if (!snapshot.sessionReference) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No canonical session is available for task ${taskId}.`,
        },
      ],
      details: snapshot,
      isError: true,
    };
  }
  const result = await getFinalTaskResult(snapshot);
  return {
    content: [
      {
        type: "text" as const,
        text: result ?? `Task ${taskId} has no assistant result yet.`,
      },
    ],
    details: snapshot,
    ...(result ? {} : { isError: true }),
  };
}

function renderMetrics(metrics: ReturnType<typeof deriveOrchestrationMetrics>): string {
  return [
    `Started tasks: ${metrics.tasksStarted}`,
    `Completed tasks: ${metrics.tasksCompleted}`,
    `Failed tasks: ${metrics.tasksFailed}`,
    `Stale tasks: ${metrics.staleTasks}`,
    `Retries: ${metrics.retries}`,
    `Total tokens: ${metrics.totalTokens}`,
    `Total cost: ${metrics.totalCost}`,
    `Task success rate: ${metrics.taskSuccessRate ?? "n/a"}`,
    `Tokens per completed task: ${metrics.tokensPerCompletedTask ?? "n/a"}`,
    `Cost per completed task: ${metrics.costPerCompletedTask ?? "n/a"}`,
    `Review yield: ${metrics.reviewYield ?? "n/a"}`,
  ].join("\n");
}

function renderDoctorResult(
  result: Awaited<ReturnType<typeof runOrchestrationDoctor>>,
): string {
  if (result.ok) {
    return "Orchestration doctor: healthy.";
  }
  return [
    `Orchestration doctor: ${result.issues.length} issue(s).`,
    ...result.issues.map(
      (issue) =>
        `[${issue.severity}] ${issue.code}: ${issue.message} ${issue.remediation}`,
    ),
  ].join("\n");
}

function normalizeHandoff(
  handoff: NonNullable<HerdrToolInput["handoff"]>,
): ContextHandoffPatch {
  return {
    ...(handoff.decisions
      ? { decisions: handoff.decisions.map((decision) => ({ ...decision })) }
      : {}),
    ...(handoff.evidence
      ? {
          evidence: handoff.evidence.map((evidence) => ({
            description: evidence.description,
            reference: evidence.reference,
            ...(evidence.recorded_at
              ? { recordedAt: evidence.recorded_at }
              : {}),
          })),
        }
      : {}),
    ...(handoff.unknowns ? { unknowns: [...handoff.unknowns] } : {}),
    ...(handoff.next_step ? { nextStep: handoff.next_step } : {}),
  };
}

function requireValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required for this action`);
  }
  return value;
}

function requireNumber(value: number | undefined, name: string): number {
  if (value === undefined) {
    throw new Error(`${name} is required for this action`);
  }
  return value;
}
