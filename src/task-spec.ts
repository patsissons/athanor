import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { resolve } from "node:path";
import { loadDefaults } from "./load-defaults.js";

export const ValidationGateSchema = z.object({
  name: z.string(),
  command: z.string(),
  // How much of a failure is shown back to the agent. Keep this small.
  maxOutputChars: z.number().int().positive().default(4000),
});

export const TaskSpecSchema = z.object({
  // Identity
  id: z.string().min(1).describe("Short stable id, e.g. 'add-items-list'"),
  title: z.string(),
  description: z.string().describe("What to build. Be concrete."),

  // Scope. Globs are evaluated relative to `appSubdir`.
  allowedPaths: z
    .array(z.string())
    .default([])
    .describe("Glob patterns. If set, agent may only modify matching files."),
  forbiddenPaths: z
    .array(z.string())
    .default([])
    .describe("Glob patterns. If set, agent may not modify matching files."),

  // Acceptance criteria
  acceptanceCriteria: z.array(z.string()).min(1).describe("Concrete, testable bullet points."),
  gates: z.array(ValidationGateSchema).min(1),

  // Task-specific guidelines (appended to app-level guidelines).
  guidelines: z.array(z.string()).optional(),

  // Retry budget.
  maxAgentAttempts: z.number().int().min(1).default(2),

  // Model
  model: z.enum(["sonnet", "opus", "haiku"]).default("sonnet"),

  // Previously completed tasks summary (injected by the harness at runtime).
  completedTasks: z.string().optional(),
});

export type ValidationGate = z.infer<typeof ValidationGateSchema>;
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export async function loadTaskSpec(path: string, targetRepoRoot?: string): Promise<TaskSpec> {
  const raw = await readFile(path, "utf8");
  const parsed = parse(raw);
  if (targetRepoRoot) {
    const defaultsPath = resolve(targetRepoRoot, "tasks", "task.default.yaml");
    const defaults = await loadDefaults(defaultsPath, TaskSpecSchema.partial());
    const merged = { ...defaults, ...parsed };
    return TaskSpecSchema.parse(merged);
  }
  return TaskSpecSchema.parse(parsed);
}
