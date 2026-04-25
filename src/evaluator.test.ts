import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { runEvaluator, formatEvalFeedback, type EvaluatorDeps } from "./evaluator.js";
import type { EvalResult, EvaluatorConfig } from "./eval-spec.js";
import { TaskSpecSchema } from "./task-spec.js";

function makeTask() {
  return TaskSpecSchema.parse({
    id: "demo",
    title: "Add demo page",
    description: "Create a /demo route.",
    acceptanceCriteria: ["Route renders"],
    gates: [{ name: "typecheck", command: "npm run typecheck" }],
  });
}

const evalConfig: EvaluatorConfig = { enabled: true, model: "opus" };

function makeDeps(result: { success: boolean; stdout: string; stderr: string }): EvaluatorDeps {
  return {
    invokeAgent: vi.fn(async () => ({ ...result, parsed: null })),
  };
}

describe("runEvaluator", () => {
  it("returns parsed eval result on success", async () => {
    const evalYaml: EvalResult = {
      passed: true,
      score: 90,
      issues: [],
      summary: "All criteria met.",
    };

    const deps = makeDeps({
      success: true,
      stdout: stringify(evalYaml),
      stderr: "",
    });

    const result = await runEvaluator({
      task: makeTask(),
      diff: "+code",
      evaluator: evalConfig,
      cwd: "/tmp",
      deps,
    });

    expect(result.passed).toBe(true);
    expect(result.score).toBe(90);
  });

  it("returns failed result when agent invocation fails", async () => {
    const deps = makeDeps({
      success: false,
      stdout: "",
      stderr: "agent crashed",
    });

    const result = await runEvaluator({
      task: makeTask(),
      diff: "+code",
      evaluator: evalConfig,
      cwd: "/tmp",
      deps,
    });

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("agent crashed");
  });

  it("returns failed result when output is not YAML", async () => {
    const deps = makeDeps({
      success: true,
      stdout: "This is not YAML at all, just plain text rambling",
      stderr: "",
    });

    const result = await runEvaluator({
      task: makeTask(),
      diff: "+code",
      evaluator: evalConfig,
      cwd: "/tmp",
      deps,
    });

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("unparseable");
  });

  it("returns failed result when YAML fails schema validation", async () => {
    const deps = makeDeps({
      success: true,
      stdout: stringify({ wrong: "schema" }),
      stderr: "",
    });

    const result = await runEvaluator({
      task: makeTask(),
      diff: "+code",
      evaluator: evalConfig,
      cwd: "/tmp",
      deps,
    });

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("validation");
  });

  it("invokes agent with the evaluator model", async () => {
    const deps = makeDeps({
      success: true,
      stdout: stringify({ passed: true, issues: [], summary: "ok" }),
      stderr: "",
    });

    await runEvaluator({
      task: makeTask(),
      diff: "+code",
      evaluator: { enabled: true, model: "sonnet" },
      cwd: "/tmp",
      deps,
    });

    expect(deps.invokeAgent).toHaveBeenCalledWith(expect.objectContaining({ model: "sonnet" }));
  });
});

describe("formatEvalFeedback", () => {
  it("formats passing result", () => {
    const feedback = formatEvalFeedback({
      passed: true,
      issues: [],
      summary: "All good.",
    });

    expect(feedback).toContain("=== Evaluator Review ===");
    expect(feedback).toContain("All good.");
  });

  it("formats issues with severity and suggestions", () => {
    const feedback = formatEvalFeedback({
      passed: false,
      issues: [
        {
          severity: "critical",
          criterion: "Route renders",
          description: "Route is stubbed",
          suggestion: "Implement the handler",
        },
        {
          severity: "minor",
          criterion: "Page has heading",
          description: "Heading is placeholder text",
        },
      ],
      summary: "Incomplete implementation.",
    });

    expect(feedback).toContain("[critical] Route renders");
    expect(feedback).toContain("Route is stubbed");
    expect(feedback).toContain("Fix: Implement the handler");
    expect(feedback).toContain("[minor] Page has heading");
    expect(feedback).not.toContain("Fix: undefined");
  });
});
