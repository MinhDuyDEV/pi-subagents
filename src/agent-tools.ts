/**
 * Shared agent tool allowlist resolution for task subagents.
 */


import { parseMergedDisallowedTools } from "./policy.js";

/** Pi built-in tools available when SDK execution disables extensions. */
const BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

const READONLY_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "websearch",
  "codesearch",
  "web_fetch",
  "get_fetch_content",
  "context7",
  "deepwiki",
  "firecrawl_scrape",
  "firecrawl_crawl",
  "ollama_web_search",
  "ollama_web_fetch",
  "semantic_query",
  "semantic_grep",
  "semantic_inspect",
  "semantic_show",
  "semantic_review",
  "dcp_recall",
]);

/**
 * Extension tools commonly granted to research / read-only subagents when
 * `tools:` is omitted. Parent may pass a wider list via parentToolNames.
 */
const TASK_DEFAULT_EXTENSION_TOOLS = [
  "websearch",
  "codesearch",
  "web_fetch",
  "context7",
  "deepwiki",
  "webclaw_scrape",
  "webclaw_batch",
  "memory-search",
  "memory-admin",
  "observation",
  "vcc_recall",
  "diagnostics",
  "compress",
  "task",
] as const;

/** @deprecated Use BUILTIN_TOOL_NAMES + TASK_DEFAULT_EXTENSION_TOOLS */
export const ALL_TOOL_NAMES = [...BUILTIN_TOOL_NAMES];

export function parseToolList(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean);
  }
  return String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export interface ResolveAgentToolsInput {
  /** Explicit `tools:` from frontmatter */
  tools?: string | string[];
  /** `disallowed_tools` from frontmatter */
  disallowedTools?: string | string[];
  /** Enforce the fail-closed read-only capability policy. */
  readonly?: boolean;
  /**
   * When set, used as base instead of default builtin+extension catalog
   * (intersection applied when agent also sets `tools:`).
   */
  parentToolNames?: string[];
  /** Name registered by pi-task in the parent session. */
  taskToolName?: string;
}

/**
 * Effective allowlist for CLI `--tools` or SDK `tools:` option.
 * Throws if the result is empty.
 */
export function resolveAgentToolAllowlist(
  input: ResolveAgentToolsInput,
): string[] {
  const disallowed = new Set(
    parseMergedDisallowedTools(parseToolList(input.disallowedTools).join(",")),
  );
  const taskToolName = input.taskToolName ?? "task";

  let base: string[];
  if (input.tools !== undefined && input.tools !== null && input.tools !== "") {
    const explicit = parseToolList(input.tools);
    if (input.parentToolNames?.length) {
      const parentSet = new Set(input.parentToolNames);
      base = explicit.filter((t) => parentSet.has(t));
    } else {
      base = explicit;
    }
  } else if (input.parentToolNames?.length) {
    base = [...input.parentToolNames];
  } else {
    base = [...BUILTIN_TOOL_NAMES, ...TASK_DEFAULT_EXTENSION_TOOLS];
  }

  const capabilityBase = input.readonly
    ? base.filter((tool) => READONLY_TOOL_NAMES.has(tool))
    : base;
  const allowed = capabilityBase.filter((tool) => !disallowed.has(tool));
  // Parent control and interactive handoff tools cannot cross a task boundary.
  const parentOnlyTools = new Set([taskToolName, "task_control", "herdr", "ask_user"]);
  const withoutTask = allowed.filter((tool) => !parentOnlyTools.has(tool));

  if (withoutTask.length === 0) {
    throw new Error(
      "Agent tool allowlist is empty after applying tools/disallowed_tools. " +
        "Add tools: or relax disallowed_tools.",
    );
  }

  return withoutTask;
}

export function buildAgentToolSelection(input: ResolveAgentToolsInput): {
  tools: string[];
  excludeTools: string[];
} {
  const taskToolName = input.taskToolName ?? "task";
  return {
    tools: resolveAgentToolAllowlist(input),
    excludeTools: [taskToolName, "task_control", "herdr"],
  };
}

export function assertSdkToolCapability(tools: readonly string[]): void {
  const builtins = new Set<string>(BUILTIN_TOOL_NAMES);
  const unavailable = tools.filter((tool) => !builtins.has(tool));
  if (unavailable.length > 0) {
    throw new Error(
      `SDK backend cannot provide selected tools while extensions are disabled: ${unavailable.join(", ")}. ` +
        "Run inside tmux/Herdr or restrict the agent to Pi built-in tools.",
    );
  }
}
