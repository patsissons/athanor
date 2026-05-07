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
  });

  it("accepts a task-level isolation config", () => {
    const task = TaskSpecSchema.parse({
      id: "demo",
      title: "T",
      description: "D",
      acceptanceCriteria: ["x"],
      gates: [{ name: "typecheck", command: "npm run typecheck" }],
      isolation: { backend: "sandcastle", provider: "podman" },
    });
    expect(task.isolation).toEqual({ backend: "sandcastle", provider: "podman" });
  });

  it("rejects an unknown isolation backend on a task", () => {
    expect(() =>
      TaskSpecSchema.parse({
        id: "demo",
        title: "T",
        description: "D",
        acceptanceCriteria: ["x"],
        gates: [{ name: "typecheck", command: "npm run typecheck" }],
        isolation: { backend: "vm" },
      }),
    ).toThrow();
  });

  it("treats task-level isolation as optional", () => {
    const task = TaskSpecSchema.parse({
      id: "demo",
      title: "T",
      description: "D",
      acceptanceCriteria: ["x"],
      gates: [{ name: "typecheck", command: "npm run typecheck" }],
    });
    expect(task.isolation).toBeUndefined();
  });
});
