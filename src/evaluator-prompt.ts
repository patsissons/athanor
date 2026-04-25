import type { TaskSpec } from "./task-spec.js";
import type { EvaluatorConfig } from "./eval-spec.js";

export function buildEvaluatorPrompt(opts: {
  task: TaskSpec;
  diff: string;
  evaluator: EvaluatorConfig;
}): string {
  const { task, diff, evaluator } = opts;
  const lines: string[] = [];

  lines.push("# Independent Code Review");
  lines.push("");
  lines.push(
    "You are an independent QA reviewer. You did NOT write this code. " +
      "Your job is to rigorously evaluate whether the implementation meets " +
      "every acceptance criterion. Be skeptical — look for gaps, stubs, and " +
      "partial implementations.",
  );
  lines.push("");

  // ─── Task Context ──────────────────────────────────────────────
  lines.push("## Task");
  lines.push("");
  lines.push(`**${task.title}**`);
  lines.push("");
  lines.push(task.description);
  lines.push("");

  // ─── Acceptance Criteria Checklist ─────────────────────────────
  lines.push("## Acceptance Criteria");
  lines.push("");
  lines.push(
    "Verify each criterion independently. For each one, state whether " +
      "it is **met**, **partially met**, or **not met**, and cite specific " +
      "evidence from the diff.",
  );
  lines.push("");
  task.acceptanceCriteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  lines.push("");

  // ─── Additional Evaluation Criteria ────────────────────────────
  if (evaluator.criteria?.length) {
    lines.push("## Additional Evaluation Criteria");
    lines.push("");
    evaluator.criteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
    lines.push("");
  }

  // ─── The Diff ──────────────────────────────────────────────────
  lines.push("## Code Changes (git diff)");
  lines.push("");
  lines.push("```diff");
  lines.push(diff);
  lines.push("```");
  lines.push("");

  // ─── Anti-Patterns ─────────────────────────────────────────────
  lines.push("## Review Rules");
  lines.push("");
  lines.push("- Do NOT approve stubbed, placeholder, or TODO implementations.");
  lines.push("- Do NOT approve if any criterion is only partially met.");
  lines.push("- Do NOT talk yourself into approving marginal work. When in doubt, reject.");
  lines.push("- A criterion is met only when you can point to specific code that satisfies it.");
  lines.push("- If the diff is empty or trivially small relative to the task, that is a red flag.");
  lines.push("");

  // ─── Output Format ─────────────────────────────────────────────
  lines.push("## Output Format");
  lines.push("");
  lines.push("Output ONLY valid YAML conforming to this shape (no markdown fences, no preamble):");
  lines.push("");
  lines.push("```");
  lines.push(EVAL_RESULT_SHAPE);
  lines.push("```");
  lines.push("");
  lines.push("- Set `passed: true` ONLY if every acceptance criterion is fully met.");
  lines.push("- Include an issue for every criterion that is not met or partially met.");
  lines.push("- `severity` must be exactly one of: `critical`, `major`, or `minor`.");
  lines.push("- The `criterion` field must quote the acceptance criterion text verbatim.");
  lines.push(
    "- Do NOT output anything before or after the YAML. Your entire response must be valid YAML.",
  );

  return lines.join("\n");
}

export function buildInteractiveEvaluatorPrompt(opts: {
  task: TaskSpec;
  diff: string;
  evaluator: EvaluatorConfig;
  appUrl: string;
}): string {
  const { task, diff, evaluator, appUrl } = opts;
  const lines: string[] = [];

  lines.push("# Interactive QA Review");
  lines.push("");
  lines.push(
    "You are an independent QA tester. You have access to a running application " +
      "via Playwright browser tools. Your job is to interact with the app like a " +
      "real user and verify that every acceptance criterion is met.",
  );
  lines.push("");

  // ─── App URL ───────────────────────────────────────────────────
  lines.push("## Running Application");
  lines.push("");
  lines.push(`The application is running at: ${appUrl}`);
  lines.push("");
  lines.push(
    "Use Playwright tools to navigate to the app, interact with it, " +
      "and verify each criterion below.",
  );
  lines.push("");

  // ─── Task Context ──────────────────────────────────────────────
  lines.push("## Task");
  lines.push("");
  lines.push(`**${task.title}**`);
  lines.push("");
  lines.push(task.description);
  lines.push("");

  // ─── Acceptance Criteria ───────────────────────────────────────
  lines.push("## Acceptance Criteria");
  lines.push("");
  lines.push(
    "Test each criterion by performing real user actions in the browser. " +
      "For each one, state whether it is **met**, **partially met**, or " +
      "**not met**, and describe what you observed.",
  );
  lines.push("");
  task.acceptanceCriteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  lines.push("");

  // ─── Additional Criteria ───────────────────────────────────────
  if (evaluator.criteria?.length) {
    lines.push("## Additional Evaluation Criteria");
    lines.push("");
    evaluator.criteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
    lines.push("");
  }

  // ─── Diff for Context ─────────────────────────────────────────
  lines.push("## Code Changes (for reference)");
  lines.push("");
  lines.push("```diff");
  lines.push(diff);
  lines.push("```");
  lines.push("");

  // ─── Testing Instructions ──────────────────────────────────────
  lines.push("## Testing Instructions");
  lines.push("");
  lines.push("1. Navigate to the application URL.");
  lines.push("2. For each acceptance criterion, perform the user actions needed to verify it.");
  lines.push("3. Take screenshots when you find issues.");
  lines.push("4. Test edge cases (empty states, invalid input, navigation).");
  lines.push("5. After testing all criteria, produce your evaluation.");
  lines.push("");

  // ─── Anti-Patterns ────────────────────────────────────────────
  lines.push("## Review Rules");
  lines.push("");
  lines.push("- Do NOT approve without actually interacting with the application.");
  lines.push("- Do NOT approve if any criterion is only partially met.");
  lines.push("- Do NOT talk yourself into approving marginal work. When in doubt, reject.");
  lines.push("- If the page fails to load or shows errors, that is an automatic rejection.");
  lines.push("");

  // ─── Output Format ─────────────────────────────────────────────
  lines.push("## Output Format");
  lines.push("");
  lines.push(
    "After completing your testing, output ONLY valid YAML conforming to " +
      "this shape (no markdown fences, no preamble):",
  );
  lines.push("");
  lines.push("```");
  lines.push(EVAL_RESULT_SHAPE);
  lines.push("```");
  lines.push("");
  lines.push("- Set `passed: true` ONLY if every acceptance criterion is fully met.");
  lines.push("- Include an issue for every criterion that is not met or partially met.");
  lines.push("- `severity` must be exactly one of: `critical`, `major`, or `minor`.");
  lines.push("- The `criterion` field must quote the acceptance criterion text verbatim.");
  lines.push(
    "- Do NOT output anything before or after the YAML. Your entire response must be valid YAML.",
  );

  return lines.join("\n");
}

const EVAL_RESULT_SHAPE = `\
passed: false
score: 65
issues:
  - severity: critical   # must be one of: critical, major, minor
    criterion: "The exact acceptance criterion text"
    description: "What is wrong or missing"
    suggestion: "How to fix it"
  - severity: minor
    criterion: "Another criterion"
    description: "A minor issue"
summary: |
  One-paragraph summary of the evaluation.`;

export function buildEnrichmentCriticPrompt(opts: {
  taskYaml: string;
  planContext: string;
  siblingTaskIds: string[];
}): string {
  const { taskYaml, planContext, siblingTaskIds } = opts;
  const lines: string[] = [];

  lines.push("# Task Specification Critic");
  lines.push("");
  lines.push(
    "You are a QA critic reviewing a task specification before it is sent to a " +
      "coding agent. Your goal is to catch problems in the spec that would waste " +
      "execution tokens — vague criteria, missing paths, scope overlap.",
  );
  lines.push("");

  lines.push("## Plan Context");
  lines.push("");
  lines.push(planContext);
  lines.push("");

  if (siblingTaskIds.length > 0) {
    lines.push("## Sibling Tasks");
    lines.push("");
    lines.push("These other tasks exist in the same plan (check for scope overlap):");
    siblingTaskIds.forEach((id) => lines.push(`- ${id}`));
    lines.push("");
  }

  lines.push("## Task Specification to Review");
  lines.push("");
  lines.push("```yaml");
  lines.push(taskYaml);
  lines.push("```");
  lines.push("");

  lines.push("## Review Checklist");
  lines.push("");
  lines.push("1. Are acceptance criteria concrete and testable (not vague)?");
  lines.push("2. Do allowedPaths cover all files the task will realistically need?");
  lines.push("3. Is there scope overlap with sibling tasks?");
  lines.push("4. Are there obvious missing acceptance criteria?");
  lines.push("5. Is the description detailed enough for a coding agent to implement?");
  lines.push("");

  lines.push("## Output Format");
  lines.push("");
  lines.push("Output ONLY valid YAML conforming to this shape (no markdown fences, no preamble):");
  lines.push("");
  lines.push("```");
  lines.push(CRITIC_RESULT_SHAPE);
  lines.push("```");
  lines.push("");
  lines.push("- Set `passed: true` if the spec is good enough to send to a coding agent as-is.");
  lines.push("- `severity` must be exactly one of: `critical`, `major`, or `minor`.");
  lines.push(
    "- Do NOT output anything before or after the YAML. Your entire response must be valid YAML.",
  );

  return lines.join("\n");
}

const CRITIC_RESULT_SHAPE = `\
passed: false
issues:
  - severity: critical   # must be one of: critical, major, minor
    criterion: "Acceptance criteria quality"
    description: "Criterion 2 is vague — 'works correctly' is not testable"
    suggestion: "Rewrite as: 'Returns a 200 status with JSON body containing items array'"
summary: |
  One-paragraph summary of the review.`;
