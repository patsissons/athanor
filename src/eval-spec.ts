import { z } from "zod";

export const EvalIssueSchema = z.object({
  severity: z.enum(["critical", "major", "minor"]),
  criterion: z.string().describe("Which acceptance criterion this relates to."),
  description: z.string().describe("What is wrong."),
  suggestion: z.string().optional().describe("How to fix the issue."),
});

export const EvalResultSchema = z.object({
  passed: z.boolean(),
  score: z.number().int().min(0).max(100).optional().describe("Optional 0-100 quality score."),
  issues: z.array(EvalIssueSchema).default([]),
  summary: z.string().describe("Human-readable evaluation summary."),
});

export const EvaluatorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.enum(["sonnet", "opus", "haiku"]).default("opus"),
  criteria: z
    .array(z.string())
    .optional()
    .describe("Additional evaluation criteria beyond acceptance criteria."),
});

export type EvalIssue = z.infer<typeof EvalIssueSchema>;
export type EvalResult = z.infer<typeof EvalResultSchema>;
export type EvaluatorConfig = z.infer<typeof EvaluatorConfigSchema>;
