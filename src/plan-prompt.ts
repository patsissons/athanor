import type { AppSpec } from "./app-spec.js";
import type { PlanSpec } from "./plan-spec.js";
import type { TaskSpec } from "./task-spec.js";

const PLAN_SPEC_SHAPE = `\
id: kebab-case-plan-id
name: Optional human-readable name
description: |
  Optional longer description of the overall plan.
tasks:
  - id: kebab-case-task-id
    description: |
      Detailed description of what this task should accomplish.
      Be specific enough that a coding agent can implement it in isolation.
    overrides:  # optional — only when non-obvious defaults are needed
      allowedPaths: ["src/app/example/**"]
      forbiddenPaths: ["package.json"]
      acceptanceCriteria: ["Criterion 1", "Criterion 2"]
      guidelines: ["Task-specific guideline"]
      gates:
        - name: typecheck
          command: "npm run typecheck"
      maxAgentAttempts: 2
      model: sonnet
      evaluator:
        enabled: true
        mode: diff-review  # or "interactive"
        model: opus`;

const TASK_SPEC_SHAPE = `\
id: kebab-case-task-id
title: Short display title
description: |
  Concrete description of what to build.
allowedPaths: ["src/app/example/**"]
forbiddenPaths: ["package-lock.json", "package.json"]
acceptanceCriteria:
  - "Concrete, testable criterion 1"
  - "Concrete, testable criterion 2"
guidelines:  # optional — task-specific guidelines appended to app-level guidelines
  - "Task-specific guideline"
gates:
  - name: format
    command: "npm run format:check"
  - name: lint
    command: "npm run lint"
  - name: typecheck
    command: "npm run typecheck"
  - name: test
    command: "npm test -- --passWithNoTests"
maxAgentAttempts: 2
model: sonnet
# Optional: evaluator for adversarial review after gates pass
# evaluator:
#   enabled: true
#   mode: diff-review       # or "interactive"
#   model: opus`;

export function buildPlanPrompt(userPrompt: string, app?: Partial<AppSpec>): string {
  const lines: string[] = [];

  lines.push("# Objective");
  lines.push("");
  lines.push(
    "You are a technical architect. Decompose the following user request into a structured plan.",
  );
  lines.push(
    "Each task in the plan will be implemented by a separate coding agent working in its own git branch.",
  );
  lines.push("");

  if (app && (app.description || app.guidelines?.length || app.devServer)) {
    lines.push("## App Context");
    lines.push("");
    if (app.title) {
      lines.push(`App: ${app.title}`);
      lines.push("");
    }
    if (app.description) {
      lines.push(app.description);
      lines.push("");
    }
    if (app.guidelines?.length) {
      lines.push("App guidelines:");
      for (const g of app.guidelines) {
        lines.push(`- ${g}`);
      }
      lines.push("");
    }
    if (app.devServer) {
      lines.push("This project has a dev server configured for interactive testing.");
      lines.push("");
    }
  }

  lines.push("## User Request");
  lines.push("");
  lines.push(userPrompt);
  lines.push("");

  lines.push("## Output Format");
  lines.push("");
  lines.push("Output ONLY valid YAML conforming to this shape (no markdown fences, no preamble):");
  lines.push("");
  lines.push("```");
  lines.push(PLAN_SPEC_SHAPE);
  lines.push("```");
  lines.push("");

  lines.push("## Guidelines");
  lines.push("");
  lines.push("- Decompose into independent, parallelizable tasks where possible.");
  lines.push("- Each task must be self-contained — implementable in isolation on its own branch.");
  lines.push(
    "- Task descriptions must be detailed enough that a less capable model (Sonnet) can implement them.",
  );
  lines.push("- Include file paths and component names when you know them.");
  lines.push("- Use kebab-case for all IDs.");
  lines.push(
    "- The `overrides` field is optional. Only include it when there is a strong, " +
      "non-obvious reason to override the default task configuration (e.g., a task " +
      "needs Opus instead of Sonnet, or must be restricted to specific file paths).",
  );
  lines.push("- Order tasks logically — foundational tasks first, dependent tasks after.");

  if (app?.devServer) {
    lines.push(
      "- This project has a dev server. For tasks that produce user-facing UI (pages, " +
        "components, visual changes), include `evaluator: { enabled: true, mode: interactive }` " +
        "in overrides. For non-UI tasks (utilities, config, API-only, data models), either omit " +
        "the evaluator or use `evaluator: { enabled: true, mode: diff-review }`. " +
        "Do NOT include devServer in the evaluator — the harness injects it automatically.",
    );
  }

  lines.push(
    "- Do NOT output anything before or after the YAML. Your entire response must be valid YAML.",
  );

  return lines.join("\n");
}

export interface TaskEnrichmentContext {
  /** App-level configuration (from tasks/app.yaml). */
  app: Partial<AppSpec>;
  /** The full plan spec (all tasks, name, description). */
  plan: PlanSpec;
  /** The ID of the specific task to enrich. */
  targetTaskId: string;
  /** Default values for TaskSpec fields. */
  taskDefaults: Partial<TaskSpec>;
  /** Optional named assets (e.g., codebase analysis, file listings). */
  assets?: Record<string, string>;
}

export function buildTaskEnrichmentPrompt(context: TaskEnrichmentContext): string {
  const { app, plan, targetTaskId, taskDefaults, assets } = context;

  const targetTask = plan.tasks.find((t) => t.id === targetTaskId);
  if (!targetTask) {
    throw new Error(
      `Task "${targetTaskId}" not found in plan "${plan.id}". ` +
        `Available tasks: ${plan.tasks.map((t) => t.id).join(", ")}`,
    );
  }

  const lines: string[] = [];

  lines.push("# Task Enrichment");
  lines.push("");
  lines.push(
    "You are a task specification writer. Convert the following task description into a " +
      "complete task YAML file for a coding agent harness.",
  );
  lines.push("");

  // ─── Plan Context ──────────────────────────────────────────────
  lines.push("## Plan Context");
  lines.push("");
  if (plan.name) {
    lines.push(`Plan: ${plan.name}`);
    lines.push("");
  }
  if (plan.description) {
    lines.push(plan.description);
    lines.push("");
  }
  lines.push("Tasks in this plan (in execution order):");
  lines.push("");
  for (let i = 0; i < plan.tasks.length; i++) {
    const t = plan.tasks[i];
    const marker = t.id === targetTaskId ? " **(this task)**" : "";
    const firstLine = t.description.split("\n")[0].trim();
    lines.push(`${i + 1}. \`${t.id}\` — ${firstLine}${marker}`);
  }
  lines.push("");

  // ─── Task Description ─────────────────────────────────────────
  lines.push("## Task Description");
  lines.push("");
  lines.push(`Task ID: ${targetTask.id}`);
  lines.push("");
  lines.push(targetTask.description);
  lines.push("");

  // ─── Overrides ─────────────────────────────────────────────────
  if (targetTask.overrides) {
    lines.push("## Overrides (use these values as-is)");
    lines.push("");
    const entries = Object.entries(targetTask.overrides).filter(([, v]) => v !== undefined);
    for (const [key, value] of entries) {
      lines.push(`- ${key}: ${JSON.stringify(value)}`);
    }
    lines.push("");
  }

  // ─── Default Values ────────────────────────────────────────────
  if (Object.keys(taskDefaults).length > 0) {
    lines.push("## Default Values (use these unless overridden above or clearly inappropriate)");
    lines.push("");
    const entries = Object.entries(taskDefaults).filter(([, v]) => v !== undefined);
    for (const [key, value] of entries) {
      lines.push(`- ${key}: ${JSON.stringify(value)}`);
    }
    lines.push("");
  }

  // ─── Assets ────────────────────────────────────────────────────
  if (assets && Object.keys(assets).length > 0) {
    lines.push("## Assets");
    lines.push("");
    for (const [label, content] of Object.entries(assets)) {
      lines.push(`### ${label}`);
      lines.push("");
      lines.push(content);
      lines.push("");
    }
  }

  // ─── Output Format ─────────────────────────────────────────────
  lines.push("## Output Format");
  lines.push("");
  lines.push("Output ONLY valid YAML conforming to this shape (no markdown fences, no preamble):");
  lines.push("");
  lines.push("```");
  lines.push(TASK_SPEC_SHAPE);
  lines.push("```");
  lines.push("");

  // ─── Guidelines ────────────────────────────────────────────────
  lines.push("## Guidelines");
  lines.push("");

  // App-level guidelines
  if (app.guidelines?.length) {
    for (const g of app.guidelines) {
      lines.push(`- ${g}`);
    }
  }

  // Harness-level guidelines
  lines.push("- Use the task ID from the description above as the `id` field.");
  lines.push("- Write a clear, concise `title` summarizing the task.");
  lines.push("- Expand the description into concrete implementation instructions.");
  lines.push(
    "- Generate appropriate `allowedPaths` globs based on which files the task will likely touch.",
  );
  lines.push("- Write specific, testable acceptance criteria.");
  lines.push("- Use the default gates and settings unless overrides specify otherwise.");
  lines.push(
    "- Consider the full plan context above. Scope this task to avoid overlap with sibling tasks.",
  );

  if (app.devServer) {
    lines.push(
      "- If the task overrides include `evaluator.mode: interactive`, include " +
        "`evaluator: { enabled: true, mode: interactive }` in the output YAML. " +
        "Do NOT include devServer — the harness injects it automatically from app config.",
    );
  }

  lines.push(
    "- Do NOT output anything before or after the YAML. Your entire response must be valid YAML.",
  );

  return lines.join("\n");
}
