import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { critiqueTaskSpec, type CriticDeps } from "./enrichment-critic.js";
import type { EvalResult } from "./eval-spec.js";
import type { PlanSpec } from "./plan-spec.js";
import { TaskSpecSchema } from "./task-spec.js";

function makeTask() {
  return TaskSpecSchema.parse({
    id: "add-page",
    title: "Add page",
    description: "Create a new page.",
    acceptanceCriteria: ["Page renders"],
    gates: [{ name: "typecheck", command: "npm run typecheck" }],
  });
}

const samplePlan: PlanSpec = {
  id: "test-plan",
  name: "Test Plan",
  tasks: [
    { id: "add-page", description: "Create a new page." },
    { id: "add-styles", description: "Style the page." },
  ],
};

function makeDeps(result: { success: boolean; stdout: string; stderr: string }): CriticDeps {
  return {
    invokeAgent: vi.fn(async () => ({ ...result, parsed: null })),
  };
}

describe("critiqueTaskSpec", () => {
  it("returns parsed critic result on success", async () => {
    const criticResult: EvalResult = {
      passed: true,
      issues: [],
      summary: "Spec looks good.",
    };

    const deps = makeDeps({
      success: true,
      stdout: stringify(criticResult),
      stderr: "",
    });

    const result = await critiqueTaskSpec({
      taskSpec: makeTask(),
      plan: samplePlan,
      cwd: "/repo",
      model: "opus",
      deps,
    });

    expect(result.passed).toBe(true);
  });

  it("returns failed result when agent fails", async () => {
    const deps = makeDeps({
      success: false,
      stdout: "",
      stderr: "agent error",
    });

    const result = await critiqueTaskSpec({
      taskSpec: makeTask(),
      plan: samplePlan,
      cwd: "/repo",
      model: "opus",
      deps,
    });

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("agent error");
  });

  it("returns failed result when output is unparseable", async () => {
    const deps = makeDeps({
      success: true,
      stdout: "not yaml content here",
      stderr: "",
    });

    const result = await critiqueTaskSpec({
      taskSpec: makeTask(),
      plan: samplePlan,
      cwd: "/repo",
      model: "opus",
      deps,
    });

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("unparseable");
  });

  it("passes sibling task IDs excluding the target task", async () => {
    const deps = makeDeps({
      success: true,
      stdout: stringify({ passed: true, issues: [], summary: "ok" }),
      stderr: "",
    });

    await critiqueTaskSpec({
      taskSpec: makeTask(),
      plan: samplePlan,
      cwd: "/repo",
      model: "opus",
      deps,
    });

    const prompt = vi.mocked(deps.invokeAgent).mock.calls[0][0].prompt;
    // Sibling section should list add-styles but not add-page
    expect(prompt).toContain("## Sibling Tasks");
    const siblingSection = prompt.split("## Sibling Tasks")[1].split("##")[0];
    expect(siblingSection).toContain("add-styles");
    expect(siblingSection).not.toContain("add-page");
  });

  it("uses the specified model", async () => {
    const deps = makeDeps({
      success: true,
      stdout: stringify({ passed: true, issues: [], summary: "ok" }),
      stderr: "",
    });

    await critiqueTaskSpec({
      taskSpec: makeTask(),
      plan: samplePlan,
      cwd: "/repo",
      model: "sonnet",
      deps,
    });

    expect(deps.invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ model: "sonnet" }));
  });
});
