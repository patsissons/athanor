import { describe, expect, it } from "vitest";
import { EvalResultSchema, EvaluatorConfigSchema } from "./eval-spec.js";

describe("EvalResultSchema", () => {
  it("parses a passing result", () => {
    const result = EvalResultSchema.parse({
      passed: true,
      score: 95,
      issues: [],
      summary: "All criteria met.",
    });

    expect(result.passed).toBe(true);
    expect(result.score).toBe(95);
    expect(result.issues).toEqual([]);
  });

  it("parses a failing result with issues", () => {
    const result = EvalResultSchema.parse({
      passed: false,
      score: 40,
      issues: [
        {
          severity: "critical",
          criterion: "Route renders",
          description: "Route handler is stubbed with TODO comment",
          suggestion: "Implement the actual route handler",
        },
        {
          severity: "minor",
          criterion: "Tests pass",
          description: "No tests added",
        },
      ],
      summary: "Implementation is incomplete.",
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].severity).toBe("critical");
    expect(result.issues[1].suggestion).toBeUndefined();
  });

  it("defaults issues to empty array", () => {
    const result = EvalResultSchema.parse({
      passed: true,
      summary: "Looks good.",
    });

    expect(result.issues).toEqual([]);
  });

  it("rejects score outside 0-100", () => {
    expect(() => EvalResultSchema.parse({ passed: true, score: 101, summary: "ok" })).toThrow();
  });

  it("rejects invalid severity", () => {
    expect(() =>
      EvalResultSchema.parse({
        passed: false,
        issues: [{ severity: "blocker", criterion: "x", description: "y" }],
        summary: "bad",
      }),
    ).toThrow();
  });
});

describe("EvaluatorConfigSchema", () => {
  it("defaults to disabled with opus model", () => {
    const config = EvaluatorConfigSchema.parse({});

    expect(config.enabled).toBe(false);
    expect(config.model).toBe("opus");
  });

  it("parses enabled config with criteria", () => {
    const config = EvaluatorConfigSchema.parse({
      enabled: true,
      model: "sonnet",
      criteria: ["No stubbed implementations"],
    });

    expect(config.enabled).toBe(true);
    expect(config.model).toBe("sonnet");
    expect(config.criteria).toEqual(["No stubbed implementations"]);
  });
});
