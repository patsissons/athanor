import type { TaskSpec } from "./task-spec.js";

export function buildPrompt(opts: {
  task: TaskSpec;
  attempt: number;
  priorFailure: string | null;
}): string {
  const { task, attempt, priorFailure } = opts;
  const lines: string[] = [];

  lines.push(`# Task: ${task.title}`, "");
  lines.push("## Description", task.description, "");

  lines.push("## Acceptance criteria");
  task.acceptanceCriteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  lines.push("");

  if (task.allowedPaths.length) {
    lines.push("## Allowed paths");
    lines.push("You may only modify files matching these globs (relative to this directory):");
    task.allowedPaths.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  if (task.forbiddenPaths.length) {
    lines.push("## Forbidden paths");
    lines.push("Do not modify these:");
    task.forbiddenPaths.forEach((p) => lines.push(`- ${p}`));
    lines.push("");
  }

  lines.push("## Validation gates");
  lines.push(
    "Your work will be validated by running these commands in this directory. They must all exit 0.",
  );
  task.gates.forEach((g) => lines.push(`- \`${g.command}\` (gate: ${g.name})`));
  lines.push("");

  if (task.completedTasks) {
    lines.push("## Previously completed tasks");
    lines.push(task.completedTasks);
    lines.push("");
  }

  if (priorFailure) {
    lines.push(`## Previous attempt failed (attempt ${attempt - 1})`);
    lines.push("Gate output:");
    lines.push("```");
    lines.push(priorFailure);
    lines.push("```");
    lines.push("Fix the specific issue shown above. Do not rewrite unrelated code.");
    lines.push("");
  }

  lines.push("## Rules");
  lines.push("- Follow conventions in CLAUDE.md.");
  lines.push("- Make the minimum change needed. Do not refactor unrelated code.");
  lines.push("- When finished, your code must pass all gates above.");
  lines.push("- Do not run the gates yourself; the harness will run them.");
  lines.push(
    "- When you are done, conclude your response with a concise summary of what you implemented inside <task-summary>...</task-summary> XML tags.",
  );

  return lines.join("\n");
}
