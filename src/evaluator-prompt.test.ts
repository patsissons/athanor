import { describe, expect, it } from "vitest";
import { buildEvaluatorPrompt, buildEnrichmentCriticPrompt } from "./evaluator-prompt.js";
import { TaskSpecSchema } from "./task-spec.js";
import type { EvaluatorConfig } from "./eval-spec.js";

function makeTask() {
  return TaskSpecSchema.parse({
    id: "demo",
    title: "Add demo page",
    description: "Create a /demo route that renders a page.",
    acceptanceCriteria: ["Route renders at /demo", "Page includes heading"],
    gates: [{ name: "typecheck", command: "npm run typecheck" }],
  });
}

const defaultEvalConfig: EvaluatorConfig = {
  enabled: true,
  model: "opus",
};

describe("buildEvaluatorPrompt", () => {
  it("includes task title and description", () => {
    const prompt = buildEvaluatorPrompt({
      task: makeTask(),
      diff: "+ new code",
      evaluator: defaultEvalConfig,
    });

    expect(prompt).toContain("Add demo page");
    expect(prompt).toContain("Create a /demo route");
  });

  it("includes acceptance criteria as a checklist", () => {
    const prompt = buildEvaluatorPrompt({
      task: makeTask(),
      diff: "+ new code",
      evaluator: defaultEvalConfig,
    });

    expect(prompt).toContain("1. Route renders at /demo");
    expect(prompt).toContain("2. Page includes heading");
  });

  it("includes the diff", () => {
    const prompt = buildEvaluatorPrompt({
      task: makeTask(),
      diff: "+++ a/src/demo.tsx\n+ export function Demo() {}",
      evaluator: defaultEvalConfig,
    });

    expect(prompt).toContain("+++ a/src/demo.tsx");
    expect(prompt).toContain("export function Demo()");
  });

  it("includes anti-pattern rules", () => {
    const prompt = buildEvaluatorPrompt({
      task: makeTask(),
      diff: "",
      evaluator: defaultEvalConfig,
    });

    expect(prompt).toContain("Do NOT approve stubbed");
    expect(prompt).toContain("Do NOT approve if any criterion is only partially met");
    expect(prompt).toContain("Do NOT talk yourself into approving");
  });

  it("includes additional criteria when configured", () => {
    const prompt = buildEvaluatorPrompt({
      task: makeTask(),
      diff: "",
      evaluator: {
        ...defaultEvalConfig,
        criteria: ["Design quality", "No placeholder text"],
      },
    });

    expect(prompt).toContain("Additional Evaluation Criteria");
    expect(prompt).toContain("Design quality");
    expect(prompt).toContain("No placeholder text");
  });

  it("omits additional criteria section when none configured", () => {
    const prompt = buildEvaluatorPrompt({
      task: makeTask(),
      diff: "",
      evaluator: defaultEvalConfig,
    });

    expect(prompt).not.toContain("Additional Evaluation Criteria");
  });

  it("frames evaluator as independent reviewer", () => {
    const prompt = buildEvaluatorPrompt({
      task: makeTask(),
      diff: "",
      evaluator: defaultEvalConfig,
    });

    expect(prompt).toContain("independent QA reviewer");
    expect(prompt).toContain("You did NOT write this code");
  });
});

describe("buildEnrichmentCriticPrompt", () => {
  it("includes the task YAML", () => {
    const prompt = buildEnrichmentCriticPrompt({
      taskYaml: "id: demo\ntitle: Demo",
      planContext: "Plan: Test Plan",
      siblingTaskIds: [],
    });

    expect(prompt).toContain("id: demo");
    expect(prompt).toContain("title: Demo");
  });

  it("includes sibling task IDs", () => {
    const prompt = buildEnrichmentCriticPrompt({
      taskYaml: "id: demo",
      planContext: "Plan: Test",
      siblingTaskIds: ["task-a", "task-b"],
    });

    expect(prompt).toContain("Sibling Tasks");
    expect(prompt).toContain("task-a");
    expect(prompt).toContain("task-b");
  });

  it("omits sibling section when no siblings", () => {
    const prompt = buildEnrichmentCriticPrompt({
      taskYaml: "id: demo",
      planContext: "Plan: Test",
      siblingTaskIds: [],
    });

    expect(prompt).not.toContain("Sibling Tasks");
  });

  it("includes the review checklist", () => {
    const prompt = buildEnrichmentCriticPrompt({
      taskYaml: "id: demo",
      planContext: "Plan: Test",
      siblingTaskIds: [],
    });

    expect(prompt).toContain("concrete and testable");
    expect(prompt).toContain("allowedPaths");
    expect(prompt).toContain("scope overlap");
  });
});
