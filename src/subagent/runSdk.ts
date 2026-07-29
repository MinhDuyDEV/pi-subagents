import type {
  AgentSession,
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../helpers.js";

export interface RunSdkSubagentOptions {
  prompt: string;
  agent: AgentConfig;
  cwd: string;
  ctx: ExtensionContext;
  model?: string;
  thinkingLevel?: string;
  tools?: string[];
  excludeTools?: string[];
  systemPrompt?: string;
  /** Called after session creation and before prompt(). */
  onSession?: (session: AgentSession) => () => void;
}

export async function resolveSdkModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  requested?: string,
): Promise<ExtensionContext["model"]> {
  const registry: ModelRegistry = ctx.modelRegistry;
  if (requested) {
    const [provider, ...rest] = requested.split("/");
    const modelId = rest.join("/");
    if (modelId) {
      const exact = registry.find(provider, modelId);
      if (exact) return exact;
    }
  } else if (ctx.model) {
    return ctx.model;
  }

  const all = registry.getAll();
  const available = all.length > 0 ? all : registry.getAvailable();
  if (requested) {
    const byId = available.find(
      (model) =>
        model.id === requested ||
        `${model.provider}/${model.id}` === requested ||
        model.name === requested,
    );
    if (byId) return byId;
    throw new Error(`Requested subagent model "${requested}" is not available`);
  }
  return available[0];
}

export async function runSdkSubagent(options: RunSdkSubagentOptions): Promise<{
  output: string;
  sessionPath?: string;
}> {
  const model = await resolveSdkModel(
    options.ctx,
    options.model ?? options.agent.model,
  );
  if (!model) {
    throw new Error("No model available for SDK subagent execution");
  }

  const { createAgentSession, DefaultResourceLoader, getAgentDir } =
    await import("@earendil-works/pi-coding-agent");
  let session: AgentSession | undefined;
  let unsubSession: (() => void) | undefined;
  try {
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      systemPrompt: options.systemPrompt,
      noExtensions: true,
    });

    await resourceLoader.reload();

    ({ session } = await createAgentSession({
      cwd: options.cwd,
      agentDir,
      model,
      thinkingLevel: normalizeThinkingLevel(options.thinkingLevel),
      tools: options.tools,
      excludeTools: options.excludeTools,
      resourceLoader,
    }));

    if (options.onSession) {
      unsubSession = options.onSession(session);
    }

    await session.prompt(options.prompt);

    const sessionPath = session.sessionFile;
    const output = getLastAssistantText(session.messages);
    return { output: output.trim(), sessionPath };
  } finally {
    unsubSession?.();
    session?.dispose();
  }
}

type ThinkingLevel = Parameters<AgentSession["setThinkingLevel"]>[0];

function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
}

function getLastAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (isRecord(part) && typeof part.text === "string") return part.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
