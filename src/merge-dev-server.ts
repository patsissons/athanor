import type { AppSpec } from "./app-spec.js";
import type { TaskSpec } from "./task-spec.js";

/**
 * If the task has an interactive evaluator without devServer config,
 * inherit devServer from the app-level config.
 */
export function mergeAppDevServer(task: TaskSpec, app: Partial<AppSpec>): TaskSpec {
  if (task.evaluator?.mode === "interactive" && !task.evaluator.devServer && app.devServer) {
    return {
      ...task,
      evaluator: { ...task.evaluator, devServer: app.devServer },
    };
  }
  return task;
}
