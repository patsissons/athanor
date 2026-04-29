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

export const DevServerConfigSchema = z.object({
  command: z.string().describe("Command to start the dev server, e.g. 'npm run dev'."),
  readyPattern: z
    .string()
    .describe("String to watch for in stdout that signals the server is ready."),
  port: z.number().int().positive().describe("Port the dev server listens on."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe("Max ms to wait for the ready pattern before aborting."),
});

export const EvaluatorConfigBaseSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["diff-review", "interactive"]).default("diff-review"),
  model: z.enum(["sonnet", "opus", "haiku"]).default("opus"),
  criteria: z
    .array(z.string())
    .optional()
    .describe("Additional evaluation criteria beyond acceptance criteria."),
  devServer: DevServerConfigSchema.optional(),
});

export const EvaluatorConfigSchema = EvaluatorConfigBaseSchema.refine(
  (cfg) => cfg.mode !== "interactive" || cfg.devServer !== undefined,
  {
    message: "devServer is required when mode is 'interactive'",
    path: ["devServer"],
  },
);

export type EvalIssue = z.infer<typeof EvalIssueSchema>;
export type EvalResult = z.infer<typeof EvalResultSchema>;
export type DevServerConfig = z.infer<typeof DevServerConfigSchema>;
export type EvaluatorConfig = z.infer<typeof EvaluatorConfigSchema>;
