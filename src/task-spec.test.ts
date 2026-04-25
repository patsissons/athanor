import { describe, expect, it } from "vitest";
import { TaskSpecSchema } from "./task-spec.js";

describe("TaskSpecSchema", () => {
  it("applies defaults for optional fields", () => {
    const task = TaskSpecSchema.parse({
      id: "demo",
      title: "Add demo page",
      description: "Create a route.",
      acceptanceCriteria: ["Route renders"],
      gates: [{ name: "typecheck", command: "npm run typecheck" }],
    });

    expect(task.allowedPaths).toEqual([]);
    expect(task.forbiddenPaths).toEqual([]);
    expect(task.maxAgentAttempts).toBe(2);
    expect(task.model).toBe("sonnet");
    expect(task.completedTasks).toBeUndefined();
  });
});
