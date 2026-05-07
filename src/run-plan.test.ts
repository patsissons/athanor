import { describe, expect, it, vi } from "vitest";
import { runPlanExecution, type RunPlanDeps } from "./run-plan.js";
import { TaskSpecSchema, type TaskSpec } from "./task-spec.js";
import type { PlanSpec } from "./plan-spec.js";
import type { RunTaskLogger } from "./orchestrator.js";
import type { IsolationBackend, IsolationConfig } from "./isolation/index.js";

const samplePlan: PlanSpec = {
  id: "add-favorites",
  name: "Add Favorites Feature",
  tasks: [
    { id: "task-1", description: "First task" },
    { id: "task-2", description: "Second task" },
    { id: "task-3", description: "Third task" },
  ],
};

const sampleTask: TaskSpec = TaskSpecSchema.parse({
  id: "task-1",
  title: "First task",
  description: "Do the first thing.",
  acceptanceCriteria: ["Works"],
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

interface FakeBackendOpts {
  branch?: string;
  installExitCode?: number;
  installStderr?: string;
  createError?: Error;
  pushError?: Error;
}

function makeFakeBackend(opts: FakeBackendOpts = {}): IsolationBackend {
  return {
    branch: opts.branch ?? "athanor/add-favorites/20260423-120000-abcd",
    path: "/tmp/wt",
    create: vi.fn().mockImplementation(async () => {
      if (opts.createError) throw opts.createError;
      return "/tmp/wt";
    }),
    changedFiles: vi.fn().mockResolvedValue([]),
    diff: vi.fn().mockResolvedValue(""),
    commitAll: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockImplementation(async () => {
      if (opts.pushError) throw opts.pushError;
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue({ success: true, stdout: "", stderr: "", parsed: null }),
    runCommand: vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "ci") {
        return {
          exitCode: opts.installExitCode ?? 0,
          stdout: "",
          stderr: opts.installStderr ?? "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
  };
}

function makeDeps(
  overrides: Partial<RunPlanDeps> & { backend?: IsolationBackend } = {},
): RunPlanDeps & { backend: IsolationBackend } {
  const { logger } = makeLogger();
  const backend = overrides.backend ?? makeFakeBackend();

  // Strip the helper-only `backend` field before spreading into RunPlanDeps.
  const { backend: _drop, ...realOverrides } = overrides;
  void _drop;

  const deps: RunPlanDeps = {
    createIsolationBackend: vi.fn(async () => backend),
    makeRunId: vi.fn(() => "20260423-120000-abcd"),
    loadPlanSpec: vi.fn(async () => samplePlan),
    loadTaskSpec: vi.fn(async () => sampleTask),
    loadAppDefaults: vi.fn(async () => ({})),
    loadCompletedTasks: vi.fn(async () => ({ tasks: [] })),
    appendCompletedTask: vi.fn(async () => {}),
    scanGitForTaskIds: vi.fn(async () => new Map()),
    crossReferenceCompletedTasks: vi.fn(() => ({
      valid: true,
      resumeIndex: 0,
      errors: [],
    })),
    formatCompletedTasksContext: vi.fn(() => ""),
    runTaskLoop: vi.fn(async () => ({ success: true, summary: "Done." })),
    runAllGates: vi.fn(async () => []),
    runEvaluator: vi.fn(async () => ({ passed: true, issues: [], summary: "OK" })),
    readdir: vi.fn(async () => ["task-1.yaml", "task-2.yaml", "task-3.yaml"]),
    log: logger,
    harnessRoot: "/harness",
    targetRepoRoot: "/repo",
    ...realOverrides,
  };

  return Object.assign(deps, { backend });
}

const planOpts = { targetRepoRoot: "/repo", harnessRoot: "/harness" };

describe("runPlanExecution", () => {
  it("runs all tasks from start when nothing is completed", async () => {
    const deps = makeDeps();

    const ok = await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(ok).toBe(true);
    expect(deps.runTaskLoop).toHaveBeenCalledTimes(3);
    expect(deps.appendCompletedTask).toHaveBeenCalledTimes(3);
  });

  it("resumes from correct task when some are completed", async () => {
    const deps = makeDeps({
      loadCompletedTasks: vi.fn(async () => ({
        tasks: [
          { id: "task-1", title: "First" },
          { id: "task-2", title: "Second" },
        ],
      })),
      scanGitForTaskIds: vi.fn(
        async () =>
          new Map([
            ["task-1", "abc"],
            ["task-2", "def"],
          ]),
      ),
      crossReferenceCompletedTasks: vi.fn(() => ({
        valid: true,
        resumeIndex: 2,
        errors: [],
      })),
    });

    const ok = await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(ok).toBe(true);
    // Only task-3 should run
    expect(deps.runTaskLoop).toHaveBeenCalledTimes(1);
    expect(deps.appendCompletedTask).toHaveBeenCalledTimes(1);
  });

  it("returns true when all tasks already completed", async () => {
    const deps = makeDeps({
      crossReferenceCompletedTasks: vi.fn(() => ({
        valid: true,
        resumeIndex: 3,
        errors: [],
      })),
    });

    const ok = await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(ok).toBe(true);
    expect(deps.runTaskLoop).not.toHaveBeenCalled();
    expect(deps.createIsolationBackend).not.toHaveBeenCalled();
  });

  it("fails on pre-check mismatch", async () => {
    const { logger, messages } = makeLogger();
    const deps = makeDeps({
      log: logger,
      crossReferenceCompletedTasks: vi.fn(() => ({
        valid: false,
        resumeIndex: 0,
        errors: ["task-1 in YAML but not git"],
      })),
    });

    const ok = await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(ok).toBe(false);
    expect(messages.error.some((m) => m.includes("inconsistent"))).toBe(true);
  });

  it("halts on first task failure", async () => {
    const deps = makeDeps({
      runTaskLoop: vi
        .fn()
        .mockResolvedValueOnce({ success: true, summary: "Done." })
        .mockResolvedValueOnce({ success: false }),
    });

    const ok = await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(ok).toBe(false);
    expect(deps.runTaskLoop).toHaveBeenCalledTimes(2);
    expect(deps.appendCompletedTask).toHaveBeenCalledTimes(1);
  });

  it("creates one shared isolation backend per plan run with plan id", async () => {
    const deps = makeDeps();

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(deps.createIsolationBackend).toHaveBeenCalledTimes(1);
    expect(deps.createIsolationBackend).toHaveBeenCalledWith(
      { backend: "worktree" },
      expect.objectContaining({
        targetRepoRoot: "/repo",
        harnessRoot: "/harness",
        identifier: "add-favorites",
        runId: "20260423-120000-abcd",
      }),
    );
  });

  it("runs npm ci through isolation.runCommand", async () => {
    const deps = makeDeps();

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    const ciCalls = vi
      .mocked(deps.backend.runCommand)
      .mock.calls.filter((call) => call[0] === "npm" && (call[1] as string[])[0] === "ci");
    expect(ciCalls).toHaveLength(1);
  });

  it("fails when npm ci fails", async () => {
    const { logger, messages } = makeLogger();
    const backend = makeFakeBackend({ installExitCode: 1, installStderr: "install failed" });
    const deps = makeDeps({ log: logger, backend });

    const ok = await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(ok).toBe(false);
    expect(messages.error.some((m) => m.includes("npm ci failed"))).toBe(true);
  });

  it("grows completed tasks context with each task", async () => {
    const formatCalls: unknown[][] = [];
    const deps = makeDeps({
      formatCompletedTasksContext: vi.fn((...args) => {
        formatCalls.push(args);
        return "context";
      }),
    });

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    // First task has no completed tasks so formatCompletedTasksContext is not called.
    // Only task-2 and task-3 trigger the call (after 1 and 2 tasks completed respectively).
    expect(formatCalls).toHaveLength(2);
    expect(formatCalls[0][0]).toHaveLength(1); // Second task: 1 completed
    expect(formatCalls[1][0]).toHaveLength(2); // Third task: 2 completed
  });

  it("pushes when push option is set", async () => {
    const deps = makeDeps();

    await runPlanExecution("plans/test.yaml", { ...planOpts, push: true }, deps);

    expect(deps.backend.push).toHaveBeenCalled();
  });

  it("does not push by default", async () => {
    const deps = makeDeps();

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(deps.backend.push).not.toHaveBeenCalled();
  });

  it("destroys the isolation backend in finally on success", async () => {
    const deps = makeDeps();

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(deps.backend.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys the isolation backend in finally even when a task fails", async () => {
    const deps = makeDeps({
      runTaskLoop: vi.fn(async () => ({ success: false })),
    });

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(deps.backend.destroy).toHaveBeenCalledTimes(1);
  });

  it("forwards plan-level isolation config to the factory", async () => {
    const planWithIso: PlanSpec = {
      ...samplePlan,
      isolation: { backend: "sandcastle", provider: "docker" },
    };
    const deps = makeDeps({
      loadPlanSpec: vi.fn(async () => planWithIso),
    });

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(deps.createIsolationBackend).toHaveBeenCalledWith(
      { backend: "sandcastle", provider: "docker" },
      expect.objectContaining({ identifier: "add-favorites" }),
    );
  });

  it("forwards app-level isolation config when no plan-level override", async () => {
    const appIso: IsolationConfig = { backend: "sandcastle" };
    const deps = makeDeps({
      loadAppDefaults: vi.fn(async () => ({ isolation: appIso })),
    });

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(deps.createIsolationBackend).toHaveBeenCalledWith(appIso, expect.anything());
  });

  it("warns and ignores per-task isolation overrides in plan mode", async () => {
    const { logger, messages } = makeLogger();
    const taskWithIso = TaskSpecSchema.parse({
      ...sampleTask,
      isolation: { backend: "sandcastle" },
    });
    const deps = makeDeps({
      log: logger,
      loadTaskSpec: vi.fn(async () => taskWithIso),
    });

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(messages.warn.some((m) => m.includes("task-level override ignored"))).toBe(true);
    // The plan-level (default worktree) backend is still used; the factory
    // is called once with { backend: "worktree" }.
    expect(deps.createIsolationBackend).toHaveBeenCalledTimes(1);
    expect(deps.createIsolationBackend).toHaveBeenCalledWith(
      { backend: "worktree" },
      expect.anything(),
    );
  });

  it("fails when task directory does not exist", async () => {
    const { logger, messages } = makeLogger();
    const deps = makeDeps({
      log: logger,
      readdir: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    });

    const ok = await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(ok).toBe(false);
    expect(messages.error.some((m) => m.includes("Task directory not found"))).toBe(true);
  });

  it("defaults maxAgentAttempts to 3 when task evaluator is enabled", async () => {
    const taskWithEval = TaskSpecSchema.parse({
      ...sampleTask,
      evaluator: { enabled: true, model: "opus", mode: "diff-review" },
    });
    const deps = makeDeps({
      loadTaskSpec: vi.fn(async () => taskWithEval),
    });

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    const loopCalls = vi.mocked(deps.runTaskLoop).mock.calls;
    expect(loopCalls[0][1].maxAttempts).toBe(3);
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  it("handles a single-task plan", async () => {
    const onePlan: PlanSpec = {
      id: "single",
      name: "Single",
      tasks: [{ id: "only-one", description: "Just one." }],
    };
    const deps = makeDeps({
      loadPlanSpec: vi.fn(async () => onePlan),
      readdir: vi.fn(async () => ["only-one.yaml"]),
    });

    const ok = await runPlanExecution("plans/single.yaml", planOpts, deps);

    expect(ok).toBe(true);
    expect(deps.runTaskLoop).toHaveBeenCalledTimes(1);
    expect(deps.appendCompletedTask).toHaveBeenCalledTimes(1);
  });

  it("fails when a task file is missing on disk after pre-check passes", async () => {
    const { logger, messages } = makeLogger();
    const deps = makeDeps({
      log: logger,
      readdir: vi.fn(async () => ["task-1.yaml", "task-2.yaml"]),
    });

    const ok = await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(ok).toBe(false);
    expect(messages.error.some((m) => m.includes("Task file not found for task-3"))).toBe(true);
  });

  it("propagates isolation create failure", async () => {
    const failing = makeFakeBackend({
      createError: new Error("git worktree add failed: branch exists"),
    });
    const deps = makeDeps({ backend: failing });

    await expect(runPlanExecution("plans/test.yaml", planOpts, deps)).rejects.toThrow(
      /git worktree add failed/,
    );
    expect(deps.runTaskLoop).not.toHaveBeenCalled();
    expect(deps.appendCompletedTask).not.toHaveBeenCalled();
    // destroy still runs in finally even when create fails
    expect(failing.destroy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a clear error when a task is in git history but missing from completed-tasks.yaml", async () => {
    const { logger, messages } = makeLogger();
    const deps = makeDeps({
      log: logger,
      loadCompletedTasks: vi.fn(async () => ({ tasks: [{ id: "task-1", title: "First" }] })),
      scanGitForTaskIds: vi.fn(
        async () =>
          new Map([
            ["task-1", "abc"],
            ["task-2", "def"],
          ]),
      ),
      crossReferenceCompletedTasks: vi.fn(() => ({
        valid: false,
        resumeIndex: 0,
        errors: [
          'Task "task-2" found in git history but not in completed-tasks.yaml. ' +
            "Add it to completed-tasks.yaml with at least the task id.",
        ],
      })),
    });

    const ok = await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(ok).toBe(false);
    expect(deps.createIsolationBackend).not.toHaveBeenCalled();
    expect(messages.error.some((m) => m.includes("git history but not in completed-tasks"))).toBe(
      true,
    );
  });
});
