import { describe, expect, it } from "vitest";
import { buildPrompt } from "./prompt.js";
import { TaskSpecSchema } from "./task-spec.js";

const task = TaskSpecSchema.parse({
  id: "demo",
  title: "Add demo page",
  description: "Create a route.",
  allowedPaths: ["src/app/demo/**"],
  forbiddenPaths: ["package.json"],
  acceptanceCriteria: ["Route renders"],
  gates: [{ name: "typecheck", command: "npm run typecheck" }],
  maxAgentAttempts: 2,
  model: "sonnet",
});

describe("buildPrompt", () => {
  it("renders the core task sections", () => {
    const prompt = buildPrompt({ task, attempt: 1, priorFailure: null });

    expect(prompt).toContain("# Task: Add demo page");
    expect(prompt).toContain("## Allowed paths");
    expect(prompt).toContain("## Forbidden paths");
    expect(prompt).toContain("## Validation gates");
  });

  it("includes prior failure feedback on retries", () => {
    const prompt = buildPrompt({
      task,
      attempt: 2,
      priorFailure: "Agent modified forbidden files:\n  - package.json",
    });

    expect(prompt).toContain("## Previous attempt failed (attempt 1)");
    expect(prompt).toContain("Agent modified forbidden files");
  });

  it("includes completed tasks context when present", () => {
    const taskWithHistory = TaskSpecSchema.parse({
      ...task,
      completedTasks: "## prior-task: Prior Task\n\nDid something useful.\n",
    });
    const prompt = buildPrompt({ task: taskWithHistory, attempt: 1, priorFailure: null });

    expect(prompt).toContain("## Previously completed tasks");
    expect(prompt).toContain("## prior-task: Prior Task");
  });

  it("omits completed tasks section when not set", () => {
    const prompt = buildPrompt({ task, attempt: 1, priorFailure: null });

    expect(prompt).not.toContain("## Previously completed tasks");
  });

  it("includes task-summary instruction in rules", () => {
    const prompt = buildPrompt({ task, attempt: 1, priorFailure: null });

    expect(prompt).toContain("<task-summary>");
  });

  it("distinguishes evaluator feedback from gate failures", () => {
    const evalFeedback =
      "=== Evaluator Review ===\nIncomplete implementation.\n\nIssues found:\n  [critical] Route renders\n    Route is stubbed";
    const prompt = buildPrompt({ task, attempt: 2, priorFailure: evalFeedback });

    expect(prompt).toContain("independent evaluator reviewed your implementation");
    expect(prompt).toContain("evaluator will review your next attempt");
    expect(prompt).not.toContain("Gate output:");
  });

  it("uses gate output framing for non-evaluator failures", () => {
    const gateFailure = "=== typecheck (exit 1) ===\nbad types";
    const prompt = buildPrompt({ task, attempt: 2, priorFailure: gateFailure });

    expect(prompt).toContain("Gate output:");
    expect(prompt).not.toContain("independent evaluator");
  });
});
