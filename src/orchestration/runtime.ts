import { randomUUID } from "node:crypto";
import type { TSchema } from "@sinclair/typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  acquireResourceLease,
  transferResourceLeaseOwnership,
  type ResourceLease,
} from "./claims.js";
import {
  buildContextPack,
  loadContextPack,
  renderContextPackForPrompt,
  saveContextPack,
  type ContextPack,
} from "./context.js";
import {
  recordBackgroundCompletion,
  recordForegroundCompletion,
  releaseLeaseAndRecord,
  type ActiveRun,
} from "./completion.js";
import {
  OrchestrationRequestSchema,
  parseOrchestrationRequest,
} from "./contract.js";
import {
  renderBackgroundReceipt,
  resolveTaskSessionReference,
} from "./lifecycle.js";
import { getOrchestrationPaths } from "./paths.js";
import { appendOrchestrationEvent } from "./telemetry.js";
import { seedResumeRegistry } from "./task-state.js";
import { registerHerdrTool } from "./tool.js";

interface RuntimeState {
  activeRuns: Map<string, ActiveRun>;
}

class EvidenceOnlyProofError extends Error {
  constructor(taskId: string, issues: readonly string[]) {
    super(`Evidence-only review failed for ${taskId}: ${issues.join(" ")}`);
    this.name = "EvidenceOnlyProofError";
  }
}

export type UpstreamTaskExtension = (pi: ExtensionAPI) => void;

export function resolveUpstreamTaskExtension(
  moduleValue: unknown,
): UpstreamTaskExtension {
  if (typeof moduleValue === "function") {
    return moduleValue as UpstreamTaskExtension;
  }
  if (isRecord(moduleValue) && typeof moduleValue.default === "function") {
    return moduleValue.default as UpstreamTaskExtension;
  }
  throw new Error("The upstream task package does not export a valid default extension");
}

export function createTaskRuntime(
  upstreamTaskExtension: UpstreamTaskExtension,
): UpstreamTaskExtension {
  return (pi) => {
    const state: RuntimeState = { activeRuns: new Map() };
    upstreamTaskExtension(createTaskExtensionProxy(pi, state));
    registerHerdrTool(pi);
  };
}

function createTaskExtensionProxy(
  pi: ExtensionAPI,
  state: RuntimeState,
): ExtensionAPI {
  const registerTool = ((definition: ToolDefinition<TSchema, unknown>) => {
    if (definition.name === "task") {
      pi.registerTool(createOrchestratedTaskTool(definition, state));
      return;
    }
    pi.registerTool(definition);
  }) as ExtensionAPI["registerTool"];

  const sendMessage = ((message: Parameters<ExtensionAPI["sendMessage"]>[0], options?: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
    pi.sendMessage(message, options);
    const messageValue: unknown = message;
    if (isRecord(messageValue) && messageValue.customType === "task-complete") {
      void recordBackgroundCompletion(pi, state.activeRuns, messageValue).catch((error: unknown) => {
        pi.sendMessage(
          {
            customType: "orchestration-hook-failed",
            content: `Orchestration completion hook failed: ${errorMessage(error)}`,
            display: true,
          },
          { triggerTurn: false },
        );
      });
    }
  }) as ExtensionAPI["sendMessage"];

  return new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") {
        return registerTool;
      }
      if (property === "sendMessage") {
        return sendMessage;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createOrchestratedTaskTool(
  upstreamTool: ToolDefinition<TSchema, unknown>,
  state: RuntimeState,
): ToolDefinition<TSchema, unknown> {
  const parameters = extendTaskParameterSchema(upstreamTool.parameters);

  return {
    ...upstreamTool,
    description: `${upstreamTool.description}\n\nOptional orchestration adds resource claims and leases, a provenance-aware Context Pack, and evidence-only proof policy. Use the herdr tool for canonical status, result, handoff, metrics, and doctor actions.`,
    parameters: parameters as TSchema,
    async execute(toolCallId, parametersValue, signal, onUpdate, ctx) {
      const rawParameters = toRecord(parametersValue);
      const orchestration = parseOrchestrationRequest(rawParameters.orchestration);
      const orchestrationId = orchestration?.id ?? `run-${randomUUID()}`;
      const paths = getOrchestrationPaths(ctx.cwd);
      const agentType = stringValue(rawParameters.agent_type);
      const isBackground = rawParameters.background === true;
      const resumedTaskId = stringValue(rawParameters.task_id);
      let canonicalTaskId = resumedTaskId;
      let lease: ResourceLease | undefined;
      let contextPack: ContextPack | undefined;
      const startedAt = new Date().toISOString();

      try {
        if (orchestration?.claims && orchestration.claims.length > 0 && process.env.PI_SUBAGENTS_NO_CLAIMS !== "1") {
          lease = await acquireResourceLease({
            storePath: paths.leaseStore,
            owner: orchestrationId,
            claims: orchestration.claims,
            ttlMs: orchestration.leaseTtlMs,
          });
          await appendOrchestrationEvent({
            eventPath: paths.eventLog,
            event: {
              type: "claim_acquired",
              orchestrationId,
              leaseId: lease.id,
              agentType,
            },
          });
        }

        if (resumedTaskId) {
          await seedResumeRegistry(ctx.cwd, resumedTaskId);
        }

        if (orchestration?.context) {
          contextPack = await buildContextPack({
            projectDirectory: ctx.cwd,
            input: orchestration.context,
          });
        } else if (resumedTaskId) {
          contextPack = await loadContextPack({
            storeDirectory: paths.contextStore,
            key: resumedTaskId,
          });
        }

        const upstreamParametersValue = structuredClone(parametersValue);
        const upstreamParameters = toRecord(upstreamParametersValue);
        delete upstreamParameters.orchestration;
        if (contextPack) {
          const prompt = stringValue(upstreamParameters.prompt) ?? "";
          upstreamParameters.prompt = `${prompt.trim()}\n\n${renderContextPackForPrompt(contextPack)}`;
        }

        const upstreamResult = await upstreamTool.execute(
          toolCallId,
          upstreamParametersValue,
          signal,
          onUpdate,
          ctx,
        );
        canonicalTaskId = taskIdFromResult(upstreamResult) ?? resumedTaskId;
        if (!canonicalTaskId) {
          throw new Error("Upstream task result did not include a task ID");
        }
        const taskId = canonicalTaskId;

        if (lease) {
          lease =
            (await transferResourceLeaseOwnership({
              storePath: paths.leaseStore,
              leaseId: lease.id,
              owner: taskId,
            })) ?? lease;
        }
        if (contextPack) {
          await saveContextPack({
            storeDirectory: paths.contextStore,
            key: taskId,
            pack: contextPack,
          });
        }
        await appendOrchestrationEvent({
          eventPath: paths.eventLog,
          event: {
            type: resumedTaskId ? "task_resumed" : "task_started",
            orchestrationId,
            taskId,
            agentType,
            timestamp: startedAt,
          },
        });

        const activeRun: ActiveRun = {
          orchestrationId,
          taskId,
          agentType,
          startedAt,
          lease,
          contextPack,
          proof: orchestration?.proof,
          projectDirectory: ctx.cwd,
        };
        if (isBackground) {
          state.activeRuns.set(taskId, activeRun);
          return normalizeTaskReceipt(upstreamResult, {
            projectDirectory: ctx.cwd,
            taskId,
          });
        }

        const proof =
          process.env.PI_SUBAGENTS_NO_PROOF === "1"
            ? undefined
            : await recordForegroundCompletion(activeRun, paths);
        if (proof && !proof.valid) {
          throw new EvidenceOnlyProofError(taskId, proof.issues);
        }
        return upstreamResult;
      } catch (error) {
        if (error instanceof EvidenceOnlyProofError) {
          throw error;
        }
        if (lease) {
          await releaseLeaseAndRecord(paths, orchestrationId, lease);
        }
        await appendOrchestrationEvent({
          eventPath: paths.eventLog,
          event: {
            type: "task_failed",
            orchestrationId,
            taskId: canonicalTaskId,
            agentType,
            reason: errorMessage(error),
          },
        });
        throw error;
      }
    },
  };
}

async function normalizeTaskReceipt(
  result: AgentToolResult<unknown>,
  input: { projectDirectory: string; taskId: string },
): Promise<AgentToolResult<unknown>> {
  const sessionName = `task-${input.taskId}`;
  const sessionReference = await resolveTaskSessionReference({
    projectDirectory: input.projectDirectory,
    taskId: input.taskId,
    sessionName,
  });
  const receipt = renderBackgroundReceipt({
    taskId: input.taskId,
    sessionName,
    sessionReference,
  });
  const content = result.content.map((item, index) => {
    if (index !== 0 || item.type !== "text") {
      return item;
    }
    const retained = item.text
      .split("\n")
      .filter((line) => !line.startsWith("Subagent session:"))
      .join("\n")
      .trim();
    return { ...item, text: `${retained}\n${receipt}` };
  });
  return { ...result, content };
}

function extendTaskParameterSchema(schema: TSchema): TSchema {
  if (!isRecord(schema.properties)) {
    throw new Error("The upstream task tool must use an object parameter schema");
  }
  return {
    ...schema,
    properties: {
      ...schema.properties,
      orchestration: OrchestrationRequestSchema,
    },
  };
}

function taskIdFromResult(
  result: AgentToolResult<unknown>,
): string | undefined {
  if (isRecord(result.details)) {
    const fromDetails =
      stringValue(result.details.taskId) ?? stringValue(result.details.task_id);
    if (fromDetails) {
      return fromDetails;
    }
  }
  for (const item of result.content) {
    if (item.type !== "text") {
      continue;
    }
    const match = item.text.match(/(?:Task ID:|Started task)\s+([A-Za-z0-9_-]+)/u);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Task parameters must be an object");
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
