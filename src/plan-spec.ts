import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { ValidationGateSchema } from "./task-spec.js";
import { EvaluatorConfigBaseSchema } from "./eval-spec.js";

export const PlanTaskOverridesSchema = z.object({
  allowedPaths: z.array(z.string()).optional(),
  forbiddenPaths: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  gates: z.array(ValidationGateSchema).optional(),
  guidelines: z.array(z.string()).optional(),
  maxAgentAttempts: z.number().int().min(1).max(3).optional(),
  model: z.enum(["sonnet", "opus", "haiku"]).optional(),
  evaluator: EvaluatorConfigBaseSchema.partial().optional(),
});

export const PlanTaskSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  overrides: PlanTaskOverridesSchema.optional(),
});

export const PlanSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  tasks: z
    .array(PlanTaskSchema)
    .min(1)
    .refine((tasks) => new Set(tasks.map((t) => t.id)).size === tasks.length, {
      message: "Task IDs must be unique within a plan",
    }),
});

export type PlanTaskOverrides = z.infer<typeof PlanTaskOverridesSchema>;
export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type PlanSpec = z.infer<typeof PlanSpecSchema>;

export async function loadPlanSpec(path: string): Promise<PlanSpec> {
  const raw = await readFile(path, "utf8");
  const parsed = parse(raw);
  return PlanSpecSchema.parse(parsed);
}
