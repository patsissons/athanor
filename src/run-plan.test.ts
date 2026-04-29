import { describe, expect, it, vi } from "vitest";
import { runPlanExecution, type RunPlanDeps } from "./run-plan.js";
import { TaskSpecSchema, type TaskSpec } from "./task-spec.js";
import type { PlanSpec } from "./plan-spec.js";
import type { WorktreeLike, RunTaskLogger } from "./orchestrator.js";

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

function makeDeps(overrides: Partial<RunPlanDeps> = {}): RunPlanDeps {
  const { logger } = makeLogger();
  const worktree: WorktreeLike = {
    branch: "athanor/add-favorites/20260423-120000-abcd",
    path: "/tmp/wt",
    create: vi.fn().mockResolvedValue("/tmp/wt"),
    changedFiles: vi.fn().mockResolvedValue([]),
    diff: vi.fn().mockResolvedValue(""),
    commitAll: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
  };

  return {
    createWorktree: vi.fn(() => worktree),
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
    invokeAgent: vi.fn(async () => ({ success: true, stderr: "" })),
    runAllGates: vi.fn(async () => []),
    runEvaluator: vi.fn(async () => ({ passed: true, issues: [], summary: "OK" })),
    runCommand: vi.fn(async () => ({ exitCode: 0, stderr: "" })),
    readdir: vi.fn(async () => ["task-1.yaml", "task-2.yaml", "task-3.yaml"]),
    log: logger,
    harnessRoot: "/harness",
    targetRepoRoot: "/repo",
    ...overrides,
  };
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
    expect(deps.createWorktree).not.toHaveBeenCalled();
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

  it("creates worktree with plan id", async () => {
    const deps = makeDeps();

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(deps.createWorktree).toHaveBeenCalledWith(
      "/repo",
      "/harness",
      "add-favorites",
      "20260423-120000-abcd",
    );
  });

  it("runs npm ci in worktree", async () => {
    const deps = makeDeps();

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    const ciCalls = vi
      .mocked(deps.runCommand)
      .mock.calls.filter((call) => call[0] === "npm" && call[1][0] === "ci");
    expect(ciCalls).toHaveLength(1);
  });

  it("fails when npm ci fails", async () => {
    const { logger, messages } = makeLogger();
    const deps = makeDeps({
      log: logger,
      runCommand: vi.fn(async () => ({ exitCode: 1, stderr: "install failed" })),
    });

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
    const worktree: WorktreeLike = {
      branch: "athanor/add-favorites/run",
      path: "/tmp/wt",
      create: vi.fn().mockResolvedValue("/tmp/wt"),
      changedFiles: vi.fn().mockResolvedValue([]),
      diff: vi.fn().mockResolvedValue(""),
      commitAll: vi.fn().mockResolvedValue(undefined),
      push: vi.fn().mockResolvedValue(undefined),
    };
    const deps = makeDeps({
      createWorktree: vi.fn(() => worktree),
    });

    await runPlanExecution("plans/test.yaml", { ...planOpts, push: true }, deps);

    expect(worktree.push).toHaveBeenCalled();
  });

  it("does not push by default", async () => {
    const worktree: WorktreeLike = {
      branch: "athanor/add-favorites/run",
      path: "/tmp/wt",
      create: vi.fn().mockResolvedValue("/tmp/wt"),
      changedFiles: vi.fn().mockResolvedValue([]),
      diff: vi.fn().mockResolvedValue(""),
      commitAll: vi.fn().mockResolvedValue(undefined),
      push: vi.fn().mockResolvedValue(undefined),
    };
    const deps = makeDeps({
      createWorktree: vi.fn(() => worktree),
    });

    await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(worktree.push).not.toHaveBeenCalled();
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
    // The plan lists three tasks but only two YAML files exist on disk.
    const { logger, messages } = makeLogger();
    const deps = makeDeps({
      log: logger,
      readdir: vi.fn(async () => ["task-1.yaml", "task-2.yaml"]),
    });

    const ok = await runPlanExecution("plans/test.yaml", planOpts, deps);

    expect(ok).toBe(false);
    expect(messages.error.some((m) => m.includes("Task file not found for task-3"))).toBe(true);
  });

  it("propagates worktree creation failure", async () => {
    const failingWorktree: WorktreeLike = {
      branch: "athanor/x/y",
      path: "/tmp/wt",
      create: vi.fn().mockRejectedValue(new Error("git worktree add failed: branch exists")),
      changedFiles: vi.fn().mockResolvedValue([]),
      diff: vi.fn().mockResolvedValue(""),
      commitAll: vi.fn().mockResolvedValue(undefined),
      push: vi.fn().mockResolvedValue(undefined),
    };
    const deps = makeDeps({
      createWorktree: vi.fn(() => failingWorktree),
    });

    // run-plan does not catch wt.create errors; the rejection should surface.
    await expect(runPlanExecution("plans/test.yaml", planOpts, deps)).rejects.toThrow(
      /git worktree add failed/,
    );
    // No tasks should have been appended to completed-tasks because we failed
    // before the loop started.
    expect(deps.runTaskLoop).not.toHaveBeenCalled();
    expect(deps.appendCompletedTask).not.toHaveBeenCalled();
  });

  it("surfaces a clear error when a task is in git history but missing from completed-tasks.yaml", async () => {
    // Realistic resume corruption: a previous run committed task-2 but its
    // process died before writing the YAML entry. Pre-check must reject this.
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
    expect(deps.createWorktree).not.toHaveBeenCalled();
    expect(messages.error.some((m) => m.includes("git history but not in completed-tasks"))).toBe(
      true,
    );
  });
});
