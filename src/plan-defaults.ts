import { AppSpecSchema, type AppSpec } from "./app-spec.js";
import { PlanSpecSchema, type PlanSpec } from "./plan-spec.js";
import { TaskSpecSchema, type TaskSpec } from "./task-spec.js";
import { loadDefaults } from "./load-defaults.js";
import { resolveAthanorPath } from "./paths.js";

export function loadPlanDefaults(targetRepoRoot: string): Promise<Partial<PlanSpec>> {
  const path = resolveAthanorPath(targetRepoRoot, "plan.default.yaml");
  return loadDefaults(path, PlanSpecSchema.partial());
}

export function loadTaskDefaults(targetRepoRoot: string): Promise<Partial<TaskSpec>> {
  const path = resolveAthanorPath(targetRepoRoot, "task.default.yaml");
  return loadDefaults(path, TaskSpecSchema.partial());
}

export function loadAppDefaults(targetRepoRoot: string): Promise<Partial<AppSpec>> {
  const path = resolveAthanorPath(targetRepoRoot, "app.yaml");
  return loadDefaults(path, AppSpecSchema.partial());
}
