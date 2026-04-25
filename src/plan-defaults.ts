import { resolve } from "node:path";
import { AppSpecSchema, type AppSpec } from "./app-spec.js";
import { PlanSpecSchema, type PlanSpec } from "./plan-spec.js";
import { TaskSpecSchema, type TaskSpec } from "./task-spec.js";
import { loadDefaults } from "./load-defaults.js";

export function loadPlanDefaults(targetRepoRoot: string): Promise<Partial<PlanSpec>> {
  const path = resolve(targetRepoRoot, "plans", "plan.default.yaml");
  return loadDefaults(path, PlanSpecSchema.partial());
}

export function loadTaskDefaults(targetRepoRoot: string): Promise<Partial<TaskSpec>> {
  const path = resolve(targetRepoRoot, "tasks", "task.default.yaml");
  return loadDefaults(path, TaskSpecSchema.partial());
}

export function loadAppDefaults(targetRepoRoot: string): Promise<Partial<AppSpec>> {
  const path = resolve(targetRepoRoot, "tasks", "app.yaml");
  return loadDefaults(path, AppSpecSchema.partial());
}
