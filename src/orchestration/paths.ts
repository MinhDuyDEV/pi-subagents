import { join } from "node:path";

export interface OrchestrationPaths {
  root: string;
  leaseStore: string;
  runStore: string;
  eventLog: string;
  metricsLog: string;
  contextStore: string;
  evidenceStore: string;
  scheduleStore: string;
}

export function getOrchestrationPaths(
  projectDirectory: string,
): OrchestrationPaths {
  const root = join(
    projectDirectory,
    ".pi",
    "artifacts",
    "tasks",
    "orchestration",
  );
  return {
    root,
    leaseStore: join(root, "leases.json"),
    runStore: join(root, "runs.json"),
    eventLog: join(root, "events.jsonl"),
    metricsLog: join(root, "metrics.jsonl"),
    contextStore: join(root, "contexts"),
    evidenceStore: join(root, "evidence"),
    scheduleStore: join(root, "schedules.json"),
  };
}
