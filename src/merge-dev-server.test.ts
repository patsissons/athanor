import { describe, expect, it } from "vitest";
import { mergeAppDevServer } from "./merge-dev-server.js";
import { TaskSpecSchema } from "./task-spec.js";

function makeTask(evaluator?: Record<string, unknown>) {
  return TaskSpecSchema.parse({
    id: "demo",
    title: "Demo",
    description: "Create a demo page.",
    acceptanceCriteria: ["Page renders"],
    gates: [{ name: "typecheck", command: "npm run typecheck" }],
    ...(evaluator !== undefined ? { evaluator } : {}),
  });
}

const appDevServer = {
  command: "npm run dev",
  readyPattern: "ready on",
  port: 3000,
  timeoutMs: 30000,
};

describe("mergeAppDevServer", () => {
  it("injects app devServer when task has interactive mode without devServer", () => {
    const task = makeTask({ enabled: true, mode: "interactive" });
    const result = mergeAppDevServer(task, { devServer: appDevServer });

    expect(result.evaluator?.devServer).toEqual(appDevServer);
    expect(result.evaluator?.mode).toBe("interactive");
  });

  it("does not override task-level devServer", () => {
    const taskDevServer = {
      command: "npm run start",
      readyPattern: "listening",
      port: 8080,
      timeoutMs: 10000,
    };
    const task = makeTask({
      enabled: true,
      mode: "interactive",
      devServer: taskDevServer,
    });
    const result = mergeAppDevServer(task, { devServer: appDevServer });

    expect(result.evaluator?.devServer).toEqual(taskDevServer);
  });

  it("returns task unchanged when mode is diff-review", () => {
    const task = makeTask({ enabled: true, mode: "diff-review" });
    const result = mergeAppDevServer(task, { devServer: appDevServer });

    expect(result).toBe(task);
    expect(result.evaluator?.devServer).toBeUndefined();
  });

  it("returns task unchanged when no evaluator configured", () => {
    const task = makeTask();
    const result = mergeAppDevServer(task, { devServer: appDevServer });

    expect(result).toBe(task);
  });

  it("returns task unchanged when app has no devServer", () => {
    const task = makeTask({ enabled: true, mode: "interactive" });
    const result = mergeAppDevServer(task, {});

    expect(result).toBe(task);
    expect(result.evaluator?.devServer).toBeUndefined();
  });
});
