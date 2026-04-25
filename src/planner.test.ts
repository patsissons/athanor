import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { runPlan, type PlanDeps } from "./planner.js";
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
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async () => []),
    loadPlanSpec: vi.fn(async () => samplePlan),
    loadTaskSpec: vi.fn(async () => sampleTask),
    runTask: vi.fn(async () => ({ success: true, branch: "athanor/task/run" })),
    fastForwardDefaultBranch: vi.fn(async () => true),
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
      const ok = await runPlan({ prompt: "Add favorites", stopAfter: "plan" }, deps);

      expect(ok).toBe(true);
      expect(deps.invokeAgent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(deps.invokeAgent).mock.calls[0][0].model).toBe("opus");
      expect(deps.writeFile).toHaveBeenCalled();
    });

    it("loads app defaults before plan generation", async () => {
      const deps = makeDeps();
      await runPlan({ prompt: "Add favorites", stopAfter: "plan" }, deps);

      expect(deps.loadAppDefaults).toHaveBeenCalledWith("/repo");
    });

    it("skips generation when --from-plan is provided", async () => {
      const deps = makeDeps();
      const ok = await runPlan({ fromPlan: "plans/existing.yaml", stopAfter: "plan" }, deps);

      expect(ok).toBe(true);
      expect(deps.invokeAgent).not.toHaveBeenCalled();
      expect(deps.loadPlanSpec).toHaveBeenCalledWith("plans/existing.yaml");
    });

    it("fails when no prompt and no --from-plan", async () => {
      const { logger, messages } = makeLogger();
      const deps = makeDeps({ log: logger });
      const ok = await runPlan({}, deps);

      expect(ok).toBe(false);
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
      const ok = await runPlan({ prompt: "test", stopAfter: "plan" }, deps);

      expect(ok).toBe(false);
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
      const ok = await runPlan({ prompt: "test", stopAfter: "plan" }, deps);

      expect(ok).toBe(false);
      expect(messages.error.some((m) => m.includes("extract YAML"))).toBe(true);
    });
  });

  describe("Phase 2: Task Generation", () => {
    it("generates task files from a plan", async () => {
      let callCount = 0;
      const deps = makeDeps({
        invokeAgent: vi.fn(async () => {
          callCount++;
          // First call is plan generation (opus), rest are task enrichment (sonnet)
          if (callCount === 1) {
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
        }),
      });

      const ok = await runPlan({ prompt: "Add favorites", stopAfter: "tasks" }, deps);

      expect(ok).toBe(true);
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
        // First task already exists on disk
        readdir: vi.fn(async () => ["add-favorites-page.yaml"]),
      });

      const ok = await runPlan({ prompt: "Add favorites", stopAfter: "tasks" }, deps);

      expect(ok).toBe(true);
      // 1 plan + 1 task enrichment (second task only, first skipped)
      expect(deps.invokeAgent).toHaveBeenCalledTimes(2);
      // Plan write + 1 task write
      expect(deps.writeFile).toHaveBeenCalledTimes(2);
    });

    it("fails if any task enrichment fails", async () => {
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

      const ok = await runPlan({ prompt: "test", stopAfter: "tasks" }, deps);

      expect(ok).toBe(false);
      expect(messages.error.some((m) => m.includes("enrichment agent failed"))).toBe(true);
    });
  });

  describe("Phase 3: Task Execution", () => {
    it("runs tasks from --from-plan and executes them", async () => {
      const deps = makeDeps({
        invokeAgent: vi.fn(agentReturning(stringify(sampleTask))),
        readdir: vi.fn(async () => ["task-1.yaml", "task-2.yaml"]),
      });

      const ok = await runPlan({ fromPlan: "plans/test.yaml" }, deps);

      expect(ok).toBe(true);
      expect(deps.runTask).toHaveBeenCalledTimes(2);
    });

    it("halts on first task failure", async () => {
      const deps = makeDeps({
        invokeAgent: vi.fn(agentReturning(stringify(sampleTask))),
        readdir: vi.fn(async () => ["task-1.yaml", "task-2.yaml"]),
        runTask: vi.fn(async () => ({ success: false, branch: "athanor/task/run" })),
      });

      const ok = await runPlan({ fromPlan: "plans/test.yaml" }, deps);

      expect(ok).toBe(false);
      // Should stop after first failure, not continue to second task
      expect(deps.runTask).toHaveBeenCalledTimes(1);
    });

    it("chains baseBranch from previous task", async () => {
      let callCount = 0;
      const deps = makeDeps({
        invokeAgent: vi.fn(agentReturning(stringify(sampleTask))),
        readdir: vi.fn(async () => ["task-1.yaml", "task-2.yaml"]),
        runTask: vi.fn(async () => {
          callCount++;
          return { success: true, branch: `athanor/task-${callCount}/run` };
        }),
      });

      await runPlan({ fromPlan: "plans/test.yaml" }, deps);

      const calls = vi.mocked(deps.runTask).mock.calls;
      // First task: no baseBranch
      expect(calls[0][1].baseBranch).toBeUndefined();
      // Second task: baseBranch from first task
      expect(calls[1][1].baseBranch).toBe("athanor/task-1/run");
    });

    it("passes push: false to all tasks", async () => {
      const deps = makeDeps({
        invokeAgent: vi.fn(agentReturning(stringify(sampleTask))),
        readdir: vi.fn(async () => ["task-1.yaml", "task-2.yaml"]),
      });

      await runPlan({ fromPlan: "plans/test.yaml" }, deps);

      const calls = vi.mocked(deps.runTask).mock.calls;
      expect(calls[0][1].push).toBe(false);
      expect(calls[1][1].push).toBe(false);
    });

    it("calls fastForwardDefaultBranch after each success", async () => {
      let callCount = 0;
      const deps = makeDeps({
        invokeAgent: vi.fn(agentReturning(stringify(sampleTask))),
        readdir: vi.fn(async () => ["task-1.yaml", "task-2.yaml"]),
        runTask: vi.fn(async () => {
          callCount++;
          return { success: true, branch: `athanor/task-${callCount}/run` };
        }),
      });

      await runPlan({ fromPlan: "plans/test.yaml" }, deps);

      expect(deps.fastForwardDefaultBranch).toHaveBeenCalledTimes(2);
      expect(deps.fastForwardDefaultBranch).toHaveBeenCalledWith("/repo", "athanor/task-1/run");
      expect(deps.fastForwardDefaultBranch).toHaveBeenCalledWith("/repo", "athanor/task-2/run");
    });

    it("continues when fast-forward fails", async () => {
      const deps = makeDeps({
        invokeAgent: vi.fn(agentReturning(stringify(sampleTask))),
        readdir: vi.fn(async () => ["task-1.yaml", "task-2.yaml"]),
        fastForwardDefaultBranch: vi.fn(async () => false),
      });

      const ok = await runPlan({ fromPlan: "plans/test.yaml" }, deps);

      expect(ok).toBe(true);
      expect(deps.runTask).toHaveBeenCalledTimes(2);
    });

    it("--start-at skips preceding tasks", async () => {
      const deps = makeDeps({
        invokeAgent: vi.fn(agentReturning(stringify(sampleTask))),
        readdir: vi.fn(async () => ["task-1.yaml", "task-2.yaml", "task-3.yaml"]),
      });

      const ok = await runPlan({ fromPlan: "plans/test.yaml", startAt: "task-2" }, deps);

      expect(ok).toBe(true);
      // Should only run task-2 and task-3
      expect(deps.runTask).toHaveBeenCalledTimes(2);
    });

    it("--start-at skips Phase 2 entirely", async () => {
      const deps = makeDeps({
        readdir: vi.fn(async () => ["task-1.yaml"]),
        runTask: vi.fn(async () => ({ success: true, branch: "athanor/task/run" })),
      });

      await runPlan({ fromPlan: "plans/test.yaml", startAt: "task-1" }, deps);

      // No enrichment agent calls — only Phase 3 runs
      expect(deps.invokeAgent).not.toHaveBeenCalled();
    });

    it("--start-at with unknown task returns false", async () => {
      const { logger, messages } = makeLogger();
      const deps = makeDeps({
        log: logger,
        invokeAgent: vi.fn(agentReturning(stringify(sampleTask))),
        readdir: vi.fn(async () => ["task-1.yaml"]),
      });

      const ok = await runPlan({ fromPlan: "plans/test.yaml", startAt: "nonexistent" }, deps);

      expect(ok).toBe(false);
      expect(messages.error.some((m) => m.includes("--start-at"))).toBe(true);
    });
  });

  describe("stop-after behavior", () => {
    it("stops after plan and does not generate tasks", async () => {
      const deps = makeDeps();
      await runPlan({ prompt: "test", stopAfter: "plan" }, deps);

      // Only plan generation call, no task enrichment
      expect(deps.invokeAgent).toHaveBeenCalledTimes(1);
      expect(deps.runTask).not.toHaveBeenCalled();
    });

    it("stops after tasks and does not execute", async () => {
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

      expect(deps.runTask).not.toHaveBeenCalled();
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

      const ok = await runPlan(
        { prompt: "test", stopAfter: "tasks", enrichmentCritic: { enabled: true } },
        deps,
      );

      expect(ok).toBe(true);
      // 1 plan + 2 enrichments + 1 re-enrichment (for the rejected task)
      expect(deps.invokeAgent).toHaveBeenCalledTimes(4);
    });

    it("uses original spec when re-enrichment fails", async () => {
      let callCount = 0;
      const deps = makeDeps({
        invokeAgent: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            // Plan generation
            return { success: true, stdout: stringify(samplePlan), stderr: "", parsed: null };
          }
          if (callCount === 2) {
            // First enrichment of task 1 succeeds
            return { success: true, stdout: stringify(sampleTask), stderr: "", parsed: null };
          }
          if (callCount === 3) {
            // Re-enrichment of task 1 fails
            return { success: false, stdout: "", stderr: "agent died", parsed: null };
          }
          // Enrichment of task 2 succeeds
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

      const ok = await runPlan(
        { prompt: "test", stopAfter: "tasks", enrichmentCritic: { enabled: true } },
        deps,
      );

      expect(ok).toBe(true);
      // Task file should still be written (with original spec)
      expect(deps.writeFile).toHaveBeenCalled();
    });
  });
});
