import { describe, expect, it } from "vitest";
import { PlanSpecSchema } from "./plan-spec.js";

const minimalPlan = {
  id: "add-favorites",
  tasks: [{ id: "task-1", description: "Create the favorites page." }],
};

describe("PlanSpecSchema", () => {
  it("accepts a minimal valid plan", () => {
    const plan = PlanSpecSchema.parse(minimalPlan);
    expect(plan.id).toBe("add-favorites");
    expect(plan.name).toBeUndefined();
    expect(plan.description).toBeUndefined();
    expect(plan.tasks).toHaveLength(1);
  });

  it("accepts optional metadata fields", () => {
    const plan = PlanSpecSchema.parse({
      ...minimalPlan,
      name: "Add Favorites Feature",
      description: "Allow users to mark items as favorites.",
    });
    expect(plan.name).toBe("Add Favorites Feature");
    expect(plan.description).toBe("Allow users to mark items as favorites.");
  });

  it("accepts tasks with overrides", () => {
    const plan = PlanSpecSchema.parse({
      id: "plan-1",
      tasks: [
        {
          id: "task-1",
          description: "Build the UI.",
          overrides: {
            allowedPaths: ["src/app/favorites/**"],
            model: "opus",
            maxAgentAttempts: 3,
          },
        },
      ],
    });
    expect(plan.tasks[0].overrides?.allowedPaths).toEqual(["src/app/favorites/**"]);
    expect(plan.tasks[0].overrides?.model).toBe("opus");
    expect(plan.tasks[0].overrides?.maxAgentAttempts).toBe(3);
  });

  it("rejects plans with no tasks", () => {
    expect(() => PlanSpecSchema.parse({ id: "empty", tasks: [] })).toThrow();
  });

  it("rejects plans with duplicate task IDs", () => {
    expect(() =>
      PlanSpecSchema.parse({
        id: "dupes",
        tasks: [
          { id: "same", description: "First task." },
          { id: "same", description: "Second task." },
        ],
      }),
    ).toThrow(/unique/i);
  });

  it("rejects missing id", () => {
    expect(() => PlanSpecSchema.parse({ tasks: [{ id: "t", description: "d" }] })).toThrow();
  });

  it("rejects tasks with empty id or description", () => {
    expect(() =>
      PlanSpecSchema.parse({ id: "p", tasks: [{ id: "", description: "d" }] }),
    ).toThrow();
    expect(() =>
      PlanSpecSchema.parse({ id: "p", tasks: [{ id: "t", description: "" }] }),
    ).toThrow();
  });

  it("rejects invalid override values", () => {
    expect(() =>
      PlanSpecSchema.parse({
        id: "p",
        tasks: [
          {
            id: "t",
            description: "d",
            overrides: { maxAgentAttempts: 5 },
          },
        ],
      }),
    ).toThrow();
  });
});
