import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type TaskCwdResolution =
  | { kind: "resolved"; cwd: string }
  | { kind: "invalid"; message: string };

/** Resolve a child execution directory without changing the parent control root. */
export function resolveTaskCwd(
  callerCwd: string,
  requestedCwd: unknown,
  persistedCwd?: string,
): TaskCwdResolution {
  const candidate = requestedCwd === undefined
    ? (persistedCwd ?? callerCwd)
    : requestedCwd;
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 4096 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(candidate) ||
    !isAbsolute(candidate)
  ) {
    return invalidTaskCwd();
  }

  try {
    if (!statSync(candidate).isDirectory()) return invalidTaskCwd();
    const cwd = realpathSync(candidate);
    if (persistedCwd !== undefined && requestedCwd !== undefined) {
      const persisted = realpathSync(persistedCwd);
      if (persisted !== cwd) {
        return {
          kind: "invalid",
          message: "A resumed task must use its persisted cwd; start a new durable identity to change repositories.",
        };
      }
    }
    return { kind: "resolved", cwd };
  } catch {
    return invalidTaskCwd();
  }
}

function invalidTaskCwd(): TaskCwdResolution {
  return {
    kind: "invalid",
    message: "Task cwd must be an absolute path to an existing directory.",
  };
}
