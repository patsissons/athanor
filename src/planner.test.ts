import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { runPlan, renderUnresolvedCriticHeader, type PlanDeps } from "./planner.js";
import type { PlanSpec } from "./plan-spec.js";
import type { TaskSpec } from "./task-spec.js";
import { TaskSpecSchema } from "./task-spec.js";
import type { AgentResult } from "./agent.js";
import type { RunTaskLogger } from "./orchestrator.js";

const samplePlan: PlanSpec = {
  id: "add-favorites",
  name: "Add Favorites Feature",
  tasks: [
    { id: "add-favorites-page", description: "Create a /favorites route." },
    { id: "add-favorites-button", description: "Add a favorite button to the items list." },
  ],
};

const sampleTask: TaskSpec = TaskSpecSchema.parse({
  id: "add-favorites-page",
  title: "Add favorites page",
  description: "Create a /favorites route.",
  acceptanceCriteria: ["Route renders"],
  gates: [{ name: "typecheck", command: "npm run typecheck" }],
});

function makeLogger() {
  const messages = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const logger: RunTaskLogger = {
    info: (m) => messages.info.push(m),
    warn: (m) => messages.warn.push(m),
    error: (m) => messages.error.push(m),
    debug: (m) => messages.info.push(m),
  };
  return { logger, messages };
}

function agentReturning(yaml: string): () => Promise<AgentResult> {
  return async () => ({ success: true, stdout: yaml, stderr: "", parsed: null });
}

function makeDeps(overrides: Partial<PlanDeps> = {}): PlanDeps {
  const { logger } = makeLogger();
  return {
    invokeAgent: vi.fn(agentReturning(stringify(samplePlan))),
    critiqueTaskSpec: vi.fn(async () => ({ passed: true, issues: [], summary: "Approved." })),
    loadAppDefaults: vi.fn(async () => ({})),
    loadTaskDefaults: vi.fn(async () => ({})),
    loadPlanFile: vi.fn(async () => samplePlan),
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async () => []),
    log: logger,
    harnessRoot: "/harness",
    targetRepoRoot: "/repo",
    ...overrides,
  };
}

describe("runPlan", () => {
  describe("Phase 1: Plan Generation", () => {
    it("generates a plan from a prompt", async () => {
      const deps = makeDeps();
      const result = await runPlan({ prompt: "Add favorites", stopAfter: "plan" }, deps);

      expect(result.success).toBe(true);
      expect(result.planPath).toBeDefined();
      expect(deps.invokeAgent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(deps.invokeAgent).mock.calls[0][0].model).toBe("opus");
      expect(deps.writeFile).toHaveBeenCalled();
    });

    it("loads app defaults before plan generation", async () => {
      const deps = makeDeps();
      await runPlan({ prompt: "Add favorites", stopAfter: "plan" }, deps);

      expect(deps.loadAppDefaults).toHaveBeenCalledWith("/repo");
    });

    it("fails when no prompt provided", async () => {
      const { logger, messages } = makeLogger();
      const deps = makeDeps({ log: logger });
      const result = await runPlan({}, deps);

      expect(result.success).toBe(false);
      expect(messages.error.some((m) => m.includes("No prompt"))).toBe(true);
    });

    it("fails when agent invocation fails", async () => {
      const { logger, messages } = makeLogger();
      const deps = makeDeps({
        log: logger,
        invokeAgent: vi.fn(async () => ({
          success: false,
          stdout: "",
          stderr: "agent error",
          parsed: null,
        })),
      });
      const result = await runPlan({ prompt: "test", stopAfter: "plan" }, deps);

      expect(result.success).toBe(false);
      expect(messages.error.some((m) => m.includes("failed"))).toBe(true);
    });

    it("fails when agent returns invalid YAML", async () => {
      const { logger, messages } = makeLogger();
      const deps = makeDeps({
        log: logger,
        invokeAgent: vi.fn(async () => ({
          success: true,
          stdout: "not yaml at all []",
          stderr: "",
          parsed: null,
        })),
      });
      const result = await runPlan({ prompt: "test", stopAfter: "plan" }, deps);

      expect(result.success).toBe(false);
      expect(messages.error.some((m) => m.includes("extract YAML"))).toBe(true);
    });
  });

  describe("Phase 2: Task Generation", () => {
    it("generates task files from a plan", async () => {
      let callCount = 0;
      const deps = makeDeps({
        invokeAgent: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
        }),
      });

      const result = await runPlan({ prompt: "Add favorites", stopAfter: "tasks" }, deps);

      expect(result.success).toBe(true);
      expect(result.planPath).toBeDefined();
      // 1 plan + 2 task enrichments
      expect(deps.invokeAgent).toHaveBeenCalledTimes(3);
      // Plan write + 2 task writes
      expect(deps.writeFile).toHaveBeenCalledTimes(3);
    });

    it("uses sonnet model for task enrichment", async () => {
      let callCount = 0;
      const deps = makeDeps({
        invokeAgent: vi.fn(async (opts) => {
          callCount++;
          if (callCount === 1) {
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          expect(opts.model).toBe("sonnet");
          return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
        }),
      });

      await runPlan({ prompt: "test", stopAfter: "tasks" }, deps);
    });

    it("skips tasks that already have YAML files", async () => {
      let callCount = 0;
      const deps = makeDeps({
        invokeAgent: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
        }),
        readdir: vi.fn(async () => ["add-favorites-page.yaml"]),
      });

      const result = await runPlan({ prompt: "Add favorites", stopAfter: "tasks" }, deps);

      expect(result.success).toBe(true);
      // 1 plan + 1 task enrichment (second task only, first skipped)
      expect(deps.invokeAgent).toHaveBeenCalledTimes(2);
      // Plan write + 1 task write
      expect(deps.writeFile).toHaveBeenCalledTimes(2);
    });

    it("fails if any task enrichment fails after retries", async () => {
      let callCount = 0;
      const { logger, messages } = makeLogger();
      const deps = makeDeps({
        log: logger,
        invokeAgent: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          return { success: false, stdout: "", stderr: "enrichment failed", parsed: null };
        }),
      });

      const result = await runPlan({ prompt: "test", stopAfter: "tasks" }, deps);

      expect(result.success).toBe(false);
      // Final error is logged when all parse/agent retries are exhausted.
      expect(messages.error.some((m) => m.includes("parse attempts exhausted"))).toBe(true);
    });

    it("retries enrichment when YAML parsing fails", async () => {
      let callCount = 0;
      const deps = makeDeps({
        invokeAgent: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            // Phase 1 plan
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          if (callCount === 2) {
            // First task enrichment: garbage output → YAML extract should fail.
            return { success: true, stdout: "this is not yaml", stderr: "", parsed: null };
          }
          // Subsequent calls return a valid task spec.
          return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
        }),
      });

      const result = await runPlan({ prompt: "test", stopAfter: "tasks" }, deps);

      expect(result.success).toBe(true);
      // 1 plan + 2 enrichments for task 1 (first failed parse, retry succeeded) + 1 for task 2
      expect(deps.invokeAgent).toHaveBeenCalledTimes(4);
    });
  });

  describe("stop-after behavior", () => {
    it("stops after plan and does not generate tasks", async () => {
      const deps = makeDeps();
      await runPlan({ prompt: "test", stopAfter: "plan" }, deps);

      // Only plan generation call, no task enrichment
      expect(deps.invokeAgent).toHaveBeenCalledTimes(1);
    });

    it("returns planPath on success", async () => {
      const deps = makeDeps();
      const result = await runPlan({ prompt: "test", stopAfter: "plan" }, deps);

      expect(result.success).toBe(true);
      expect(result.planPath).toContain("add-favorites.yaml");
    });
  });

  describe("Enrichment Critic", () => {
    it("skips critic when not enabled", async () => {
      let callCount = 0;
      const deps = makeDeps({
        invokeAgent: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
        }),
      });

      await runPlan({ prompt: "test", stopAfter: "tasks" }, deps);

      expect(deps.critiqueTaskSpec).not.toHaveBeenCalled();
    });

    it("runs critic when enabled and approves good specs", async () => {
      let callCount = 0;
      const deps = makeDeps({
        invokeAgent: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
        }),
      });

      await runPlan(
        { prompt: "test", stopAfter: "tasks", enrichmentCritic: { enabled: true } },
        deps,
      );

      // 2 tasks in the plan = 2 critic calls
      expect(deps.critiqueTaskSpec).toHaveBeenCalledTimes(2);
    });

    it("re-enriches task when critic rejects", async () => {
      let callCount = 0;
      const deps = makeDeps({
        invokeAgent: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
        }),
        critiqueTaskSpec: vi
          .fn()
          .mockResolvedValueOnce({
            passed: false,
            issues: [
              {
                severity: "critical",
                criterion: "Acceptance criteria quality",
                description: "Too vague",
              },
            ],
            summary: "Needs improvement.",
          })
          .mockResolvedValue({ passed: true, issues: [], summary: "Approved." }),
      });

      const result = await runPlan(
        { prompt: "test", stopAfter: "tasks", enrichmentCritic: { enabled: true } },
        deps,
      );

      expect(result.success).toBe(true);
      // 1 plan + 2 enrichments + 1 re-enrichment (for the rejected task)
      expect(deps.invokeAgent).toHaveBeenCalledTimes(4);
    });

    it("re-runs the critic on the re-enriched spec", async () => {
      let callCount = 0;
      const critic = vi
        .fn()
        .mockResolvedValueOnce({
          passed: false,
          issues: [],
          summary: "First-pass spec was bad.",
        })
        .mockResolvedValue({ passed: true, issues: [], summary: "OK." });

      const deps = makeDeps({
        invokeAgent: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
        }),
        critiqueTaskSpec: critic,
      });

      const result = await runPlan(
        { prompt: "test", stopAfter: "tasks", enrichmentCritic: { enabled: true } },
        deps,
      );

      expect(result.success).toBe(true);
      // 2 tasks: task1 → critic(reject) → re-enrich → critic(approve);
      // task2 → critic(approve). Total critic calls = 3.
      expect(critic).toHaveBeenCalledTimes(3);
    });

    it("gives up after maxRetries re-enrichments and keeps the last spec", async () => {
      let callCount = 0;
      const critic = vi.fn().mockResolvedValue({ passed: false, issues: [], summary: "still bad" });

      const { logger, messages } = makeLogger();
      const deps = makeDeps({
        log: logger,
        invokeAgent: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
        }),
        critiqueTaskSpec: critic,
      });

      const result = await runPlan(
        {
          prompt: "test",
          stopAfter: "tasks",
          enrichmentCritic: { enabled: true, maxRetries: 1 },
        },
        deps,
      );

      expect(result.success).toBe(true);
      // Per task: critic(reject) → re-enrich → critic(reject again, give up).
      // Two tasks × 2 critic calls = 4.
      expect(critic).toHaveBeenCalledTimes(4);
      expect(messages.warn.some((m) => m.includes("still rejected"))).toBe(true);
    });

    it("uses original spec when re-enrichment fails", async () => {
      let callCount = 0;
      const deps = makeDeps({
        invokeAgent: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          if (callCount === 2) {
            return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
          }
          if (callCount === 3) {
            return { success: false, stdout: "", stderr: "agent died", parsed: null };
          }
          return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
        }),
        critiqueTaskSpec: vi
          .fn()
          .mockResolvedValueOnce({
            passed: false,
            issues: [],
            summary: "Needs work.",
          })
          .mockResolvedValue({ passed: true, issues: [], summary: "OK." }),
      });

      const result = await runPlan(
        { prompt: "test", stopAfter: "tasks", enrichmentCritic: { enabled: true } },
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.writeFile).toHaveBeenCalled();
    });
  });

  describe("--from-plan (skip Phase 1)", () => {
    it("loads an existing plan and skips Phase 1 plan generation", async () => {
      const deps = makeDeps({
        invokeAgent: vi.fn(agentReturning(stringify(sampleTask))),
      });

      const result = await runPlan(
        { planPath: "/repo/.athanor/plans/add-favorites.yaml", stopAfter: "tasks" },
        deps,
      );

      expect(result.success).toBe(true);
      expect(deps.loadPlanFile).toHaveBeenCalledWith("/repo/.athanor/plans/add-favorites.yaml");
      // Only task enrichment calls; plan generation is skipped.
      expect(deps.invokeAgent).toHaveBeenCalledTimes(2);
      // No plan file is written when loading from disk; only the 2 task files.
      expect(deps.writeFile).toHaveBeenCalledTimes(2);
      expect(result.planPath).toBe("/repo/.athanor/plans/add-favorites.yaml");
    });

    it("returns the supplied planPath when stopping after plan load", async () => {
      const deps = makeDeps();
      const result = await runPlan({ planPath: "/repo/plans/x.yaml", stopAfter: "plan" }, deps);

      expect(result.success).toBe(true);
      expect(result.planPath).toBe("/repo/plans/x.yaml");
      expect(deps.invokeAgent).not.toHaveBeenCalled();
    });

    it("rejects when both prompt and planPath are supplied", async () => {
      const { logger, messages } = makeLogger();
      const deps = makeDeps({ log: logger });
      const result = await runPlan(
        { prompt: "test", planPath: "/x.yaml", stopAfter: "plan" },
        deps,
      );

      expect(result.success).toBe(false);
      expect(messages.error.some((m) => m.includes("not both"))).toBe(true);
    });

    it("fails cleanly when the plan file cannot be loaded", async () => {
      const { logger, messages } = makeLogger();
      const deps = makeDeps({
        log: logger,
        loadPlanFile: vi.fn(async () => {
          throw new Error("ENOENT");
        }),
      });
      const result = await runPlan({ planPath: "/missing.yaml" }, deps);

      expect(result.success).toBe(false);
      expect(messages.error.some((m) => m.includes("Failed to load plan"))).toBe(true);
    });
  });

  describe("unresolved critic header", () => {
    it("prepends a critic comment block when retries are exhausted", async () => {
      let callCount = 0;
      const critic = vi.fn().mockResolvedValue({
        passed: false,
        issues: [
          {
            severity: "critical",
            criterion: "Cross-task consistency",
            description: "Path src/foo disagrees with sibling src/bar",
            suggestion: "Use src/bar",
          },
        ],
        summary: "Still bad after retry.",
      });

      let lastWrite: { path: string; content: string } | undefined;
      const deps = makeDeps({
        invokeAgent: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
        }),
        critiqueTaskSpec: critic,
        writeFile: vi.fn(async (path, content) => {
          // Capture the LAST task write; plan write happens first.
          if (path.endsWith("add-favorites-button.yaml")) {
            lastWrite = { path, content };
          }
        }),
      });

      await runPlan(
        {
          prompt: "test",
          stopAfter: "tasks",
          enrichmentCritic: { enabled: true, maxRetries: 1 },
        },
        deps,
      );

      expect(lastWrite).toBeDefined();
      expect(lastWrite!.content).toMatch(/^# ── CRITIC OVERRIDDEN/);
      expect(lastWrite!.content).toContain("Still bad after retry.");
      expect(lastWrite!.content).toContain("[critical] Cross-task consistency");
      expect(lastWrite!.content).toContain("Path src/foo disagrees");
      expect(lastWrite!.content).toContain("suggestion: Use src/bar");
      // The spec body must still parse — i.e. comments are followed by valid YAML.
      const yamlOnly = lastWrite!.content
        .split("\n")
        .filter((l) => !l.startsWith("#"))
        .join("\n");
      expect(yamlOnly).toContain("id: add-favorites-page");
    });

    it("renderUnresolvedCriticHeader handles missing fields gracefully", () => {
      const header = renderUnresolvedCriticHeader({
        passed: false,
        issues: [],
        summary: "Just a summary, no issues.",
      });
      expect(header).toContain("CRITIC OVERRIDDEN");
      expect(header).toContain("Just a summary, no issues.");
      expect(header).not.toContain("Unresolved issues");
    });
  });

  describe("--re-critic (audit mode)", () => {
    it("rejects when --re-critic is supplied without --from-plan", async () => {
      const { logger, messages } = makeLogger();
      const deps = makeDeps({ log: logger });
      const result = await runPlan({ prompt: "x", reCritic: true }, deps);

      expect(result.success).toBe(false);
      expect(messages.error.some((m) => m.includes("--re-critic requires --from-plan"))).toBe(true);
    });
  });
});
