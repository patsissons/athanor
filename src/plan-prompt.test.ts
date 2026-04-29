import { describe, expect, it } from "vitest";
import {
  buildPlanPrompt,
  buildTaskEnrichmentPrompt,
  type TaskEnrichmentContext,
} from "./plan-prompt.js";
import type { PlanSpec } from "./plan-spec.js";

const basePlan: PlanSpec = {
  id: "add-favorites",
  name: "Add Favorites Feature",
  description: "Allow users to favorite items and view them on a dedicated page.",
  tasks: [
    {
      id: "add-favorites-page",
      description: "Create a /favorites route that displays favorited items.",
    },
    {
      id: "add-favorites-button",
      description: "Add a favorite button to the items list.",
    },
  ],
};

function makeContext(overrides: Partial<TaskEnrichmentContext> = {}): TaskEnrichmentContext {
  return {
    app: {},
    plan: basePlan,
    targetTaskId: "add-favorites-page",
    taskDefaults: {},
    ...overrides,
  };
}

describe("buildPlanPrompt", () => {
  it("includes the user prompt", () => {
    const prompt = buildPlanPrompt("Add a favorites feature");
    expect(prompt).toContain("Add a favorites feature");
  });

  it("includes the plan spec shape", () => {
    const prompt = buildPlanPrompt("Build something");
    expect(prompt).toContain("kebab-case-plan-id");
    expect(prompt).toContain("tasks:");
    expect(prompt).toContain("overrides:");
  });

  it("includes guidelines in plan spec shape", () => {
    const prompt = buildPlanPrompt("Build something");
    expect(prompt).toContain("guidelines:");
  });

  it("includes output and decomposition guidelines", () => {
    const prompt = buildPlanPrompt("Build something");
    expect(prompt).toContain("ONLY valid YAML");
    expect(prompt).toContain("independent, parallelizable");
    expect(prompt).toContain("self-contained");
  });

  it("includes app context when app has description", () => {
    const prompt = buildPlanPrompt("Build something", {
      title: "My App",
      description: "A Next.js app with TypeScript.",
    });
    expect(prompt).toContain("App Context");
    expect(prompt).toContain("My App");
    expect(prompt).toContain("A Next.js app with TypeScript.");
  });

  it("includes app context when app has guidelines", () => {
    const prompt = buildPlanPrompt("Build something", {
      guidelines: ["Use Tailwind CSS for styling."],
    });
    expect(prompt).toContain("App Context");
    expect(prompt).toContain("Use Tailwind CSS for styling.");
  });

  it("omits app context when app is empty", () => {
    const prompt = buildPlanPrompt("Build something", {});
    expect(prompt).not.toContain("App Context");
  });

  it("omits app context when app is undefined", () => {
    const prompt = buildPlanPrompt("Build something");
    expect(prompt).not.toContain("App Context");
  });

  it("includes app context when app has devServer", () => {
    const prompt = buildPlanPrompt("Build something", {
      devServer: { command: "npm run dev", readyPattern: "ready on", port: 3000, timeoutMs: 30000 },
    });
    expect(prompt).toContain("App Context");
    expect(prompt).toContain("dev server configured for interactive testing");
  });

  it("includes evaluator guidance when app has devServer", () => {
    const prompt = buildPlanPrompt("Build something", {
      devServer: { command: "npm run dev", readyPattern: "ready on", port: 3000, timeoutMs: 30000 },
    });
    expect(prompt).toContain("evaluator");
    expect(prompt).toContain("user-facing UI");
    expect(prompt).toContain("Do NOT include devServer");
  });

  it("omits evaluator guidance when app has no devServer", () => {
    const prompt = buildPlanPrompt("Build something", {
      description: "A web app.",
    });
    expect(prompt).not.toContain("Do NOT include devServer");
  });

  it("includes forbidden paths guidance when taskDefaults has forbiddenPaths", () => {
    const prompt = buildPlanPrompt(
      "Build something",
      {},
      {
        forbiddenPaths: ["package.json", "package-lock.json"],
      },
    );
    expect(prompt).toContain("forbidden by default");
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("forbiddenPaths: []");
  });

  it("omits forbidden paths guidance when taskDefaults has no forbiddenPaths", () => {
    const prompt = buildPlanPrompt("Build something", {}, {});
    expect(prompt).not.toContain("forbidden by default");
  });

  it("omits forbidden paths guidance when taskDefaults is undefined", () => {
    const prompt = buildPlanPrompt("Build something", {});
    expect(prompt).not.toContain("forbidden by default");
  });
});

describe("buildTaskEnrichmentPrompt", () => {
  it("includes the task description and ID", () => {
    const prompt = buildTaskEnrichmentPrompt(makeContext());
    expect(prompt).toContain("add-favorites-page");
    expect(prompt).toContain("Create a /favorites route");
  });

  it("includes the task spec shape", () => {
    const prompt = buildTaskEnrichmentPrompt(makeContext());
    expect(prompt).toContain("acceptanceCriteria:");
    expect(prompt).toContain("gates:");
    expect(prompt).toContain("maxAgentAttempts:");
  });

  it("includes guidelines in task spec shape", () => {
    const prompt = buildTaskEnrichmentPrompt(makeContext());
    expect(prompt).toContain("guidelines:");
  });

  it("includes the plan name and description", () => {
    const prompt = buildTaskEnrichmentPrompt(makeContext());
    expect(prompt).toContain("Add Favorites Feature");
    expect(prompt).toContain("Allow users to favorite items");
  });

  it("lists all tasks with the target task marked", () => {
    const prompt = buildTaskEnrichmentPrompt(makeContext());
    expect(prompt).toContain("`add-favorites-page`");
    expect(prompt).toContain("`add-favorites-button`");
    expect(prompt).toContain("**(this task)**");
    // The marker should be on the target task line
    const lines = prompt.split("\n");
    const markedLine = lines.find((l) => l.includes("(this task)"));
    expect(markedLine).toContain("add-favorites-page");
  });

  it("includes overrides when present", () => {
    const planWithOverrides: PlanSpec = {
      ...basePlan,
      tasks: [
        {
          id: "add-favorites-page",
          description: "Create a /favorites route that displays favorited items.",
          overrides: {
            allowedPaths: ["src/app/favorites/**"],
            model: "opus",
          },
        },
        basePlan.tasks[1],
      ],
    };
    const prompt = buildTaskEnrichmentPrompt(makeContext({ plan: planWithOverrides }));
    expect(prompt).toContain("Overrides");
    expect(prompt).toContain("allowedPaths");
    expect(prompt).toContain("src/app/favorites/**");
    expect(prompt).toContain("opus");
  });

  it("omits overrides section when none present", () => {
    const prompt = buildTaskEnrichmentPrompt(makeContext());
    expect(prompt).not.toContain("Overrides");
  });

  it("includes defaults when provided", () => {
    const prompt = buildTaskEnrichmentPrompt(
      makeContext({
        taskDefaults: { model: "sonnet", maxAgentAttempts: 2 },
      }),
    );
    expect(prompt).toContain("Default Values");
    expect(prompt).toContain("sonnet");
  });

  it("omits defaults section when empty", () => {
    const prompt = buildTaskEnrichmentPrompt(makeContext());
    expect(prompt).not.toContain("Default Values");
  });

  it("includes app guidelines when provided", () => {
    const prompt = buildTaskEnrichmentPrompt(
      makeContext({
        app: {
          guidelines: [
            "The app is a Next.js project using TypeScript and Tailwind CSS.",
            "Use server components by default.",
          ],
        },
      }),
    );
    expect(prompt).toContain("The app is a Next.js project using TypeScript and Tailwind CSS.");
    expect(prompt).toContain("Use server components by default.");
  });

  it("renders assets when provided", () => {
    const prompt = buildTaskEnrichmentPrompt(
      makeContext({
        assets: {
          "File listing": "src/app/\nsrc/lib/",
          "API schema": "GET /favorites\nPOST /favorites",
        },
      }),
    );
    expect(prompt).toContain("## Assets");
    expect(prompt).toContain("### File listing");
    expect(prompt).toContain("src/app/");
    expect(prompt).toContain("### API schema");
    expect(prompt).toContain("GET /favorites");
  });

  it("omits assets section when none provided", () => {
    const prompt = buildTaskEnrichmentPrompt(makeContext());
    expect(prompt).not.toContain("Assets");
  });

  it("throws if targetTaskId is not found in plan", () => {
    expect(() =>
      buildTaskEnrichmentPrompt(makeContext({ targetTaskId: "nonexistent-task" })),
    ).toThrow(/not found in plan/);
  });

  it("includes harness guidelines about plan context", () => {
    const prompt = buildTaskEnrichmentPrompt(makeContext());
    expect(prompt).toContain("plan context");
    expect(prompt).toContain("sibling tasks");
  });

  it("includes evaluator guidance when app has devServer", () => {
    const prompt = buildTaskEnrichmentPrompt(
      makeContext({
        app: {
          devServer: {
            command: "npm run dev",
            readyPattern: "ready on",
            port: 3000,
            timeoutMs: 30000,
          },
        },
      }),
    );
    expect(prompt).toContain("Do NOT include devServer");
    expect(prompt).toContain("harness injects it automatically");
  });

  it("omits evaluator guidance when app has no devServer", () => {
    const prompt = buildTaskEnrichmentPrompt(makeContext());
    expect(prompt).not.toContain("Do NOT include devServer");
  });
});
