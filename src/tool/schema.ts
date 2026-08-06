import { Type } from "typebox";

export function taskParametersSchema() {
  return Type.Object({
    agent_type: Type.String({
      description: "The type of specialist agent to use for this task",
    }),
    prompt: Type.String({
      description:
        "The complete task for the agent to perform. Self-contained about context, not pre-solved about solution. State the governed outcome (observable behavior, not an implementation), the frontier the agent owns deciding, locked decisions (each with rationale and an unlock condition), acceptance (what evidence would convince a skeptic), non-goals, and write/read policy.",
    }),
        description: Type.String({
          description: "A short (3-5 word) summary of the task",
        }),
        workspace_group: Type.Optional(Type.String({
          description: "Shared terminal workspace group. HerdR creates a dedicated workspace by default.",
        })),
        herdr_layout: Type.Optional(Type.Literal("attached", {
          description: "With workspace_group on HerdR, keep the parent in the left half and grid children in the right half; ignored by tmux and SDK backends.",
        })),
        isolation: Type.Optional(Type.Literal("worktree", {
          description: "Run writes in an isolated Git worktree. Changed worktrees are retained and returned; unchanged worktrees are removed.",
        })),
        cwd: Type.Optional(Type.String({
          description: "Absolute existing directory used as the child execution root. Defaults to the parent cwd; resumed tasks reuse their persisted cwd. With isolation: worktree, the worktree is created from the Git repository containing this directory.",
        })),

    task_id: Type.Optional(
      Type.String({
        description:
          "Resume an existing background task by id instead of starting a new task.",
      }),
    ),
    conversation_id: Type.Optional(
      Type.String({
        description:
          "Durable specialist conversation id. Reuses .pi/artifacts/task-<id>/sessions when called again.",
      }),
    ),
    __pi_subagents_invocation_id: Type.Optional(Type.String()),
    background: Type.Optional(
      Type.Boolean({
        description:
          "Run in background (async). You will be notified when it completes. DO NOT sleep, poll, ask the task for status, or duplicate its work while it runs in background.",
        default: true,
      }),
    ),
  });
}
