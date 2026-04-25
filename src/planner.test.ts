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
    loadAppDefaults: vi.fn(async () => ({})),
    loadTaskDefaults: vi.fn(async () => ({})),
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async () => []),
    loadPlanSpec: vi.fn(async () => samplePlan),
    loadTaskSpec: vi.fn(async () => sampleTask),
    runTask: vi.fn(async () => true),
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

    it("returns false if any task fails", async () => {
      const deps = makeDeps({
        readdir: vi.fn(async () => ["task-1.yaml"]),
        runTask: vi.fn(async () => false),
      });

      const ok = await runPlan({ fromPlan: "plans/test.yaml" }, deps);

      expect(ok).toBe(false);
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
});
