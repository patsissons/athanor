import { describe, expect, it, vi } from "vitest";
import { runTaskLoop, type TaskLoopDeps } from "./task-loop.js";
import { TaskSpecSchema, type TaskSpec } from "./task-spec.js";
import type { CommandResult, RunTaskLogger, WorktreeLike } from "./orchestrator.js";

function makeTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return TaskSpecSchema.parse({
    id: "demo",
    title: "Add demo page",
    description: "Create a route.",
    allowedPaths: ["src/**"],
    forbiddenPaths: ["package.json", "package-lock.json"],
    acceptanceCriteria: ["Route renders"],
    gates: [{ name: "typecheck", command: "npm run typecheck", maxOutputChars: 200 }],
    maxAgentAttempts: 2,
    model: "sonnet",
    ...overrides,
  });
}

function makeLogger() {
  const messages = {
    info: [] as string[],
    warn: [] as string[],
    error: [] as string[],
  };

  const logger: RunTaskLogger = {
    info: (message) => messages.info.push(message),
    warn: (message) => messages.warn.push(message),
    error: (message) => messages.error.push(message),
    debug: (message) => messages.info.push(message),
  };

  return { logger, messages };
}

function makeDeps(opts: {
  changedFiles?: string[][];
  formatResults?: CommandResult[];
  agentResults?: { success: boolean; stderr: string; summary?: string }[];
  gateResults?: Array<
    {
      name: string;
      passed: boolean;
      exitCode: number;
      output: string;
    }[]
  >;
  evalResults?: Array<{
    passed: boolean;
    score?: number;
    issues: Array<{
      severity: string;
      criterion: string;
      description: string;
      suggestion?: string;
    }>;
    summary: string;
  }>;
}) {
  const { logger, messages } = makeLogger();
  const changedFiles = [...(opts.changedFiles ?? [[]])];
  const formatResults = [...(opts.formatResults ?? [{ exitCode: 0, stderr: "" }])];
  const agentResults = [...(opts.agentResults ?? [{ success: true, stderr: "" }])];
  const gateResults = [
    ...(opts.gateResults ?? [[{ name: "typecheck", passed: true, exitCode: 0, output: "" }]]),
  ];
  const evalResults = [
    ...(opts.evalResults ?? [{ passed: true, issues: [], summary: "Approved." }]),
  ];

  const worktree: WorktreeLike = {
    branch: "athanor/demo/20260423-120000-abcd",
    path: "/tmp/wt",
    create: vi.fn().mockResolvedValue("/tmp/wt"),
    changedFiles: vi.fn().mockImplementation(async () => changedFiles.shift() ?? []),
    diff: vi.fn().mockResolvedValue("diff --git a/src/page.tsx b/src/page.tsx\n+code"),
    commitAll: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
  };

  const deps: TaskLoopDeps = {
    invokeAgent: vi
      .fn()
      .mockImplementation(async () => agentResults.shift() ?? { success: true, stderr: "" }),
    runAllGates: vi
      .fn()
      .mockImplementation(
        async () =>
          gateResults.shift() ?? [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
      ),
    runEvaluator: vi
      .fn()
      .mockImplementation(
        async () => evalResults.shift() ?? { passed: true, issues: [], summary: "Approved." },
      ),
    runCommand: vi.fn().mockImplementation(async () => {
      return formatResults.shift() ?? { exitCode: 0, stderr: "" };
    }),
    worktree,
    log: logger,
  };

  return { deps, worktree, messages };
}

describe("runTaskLoop", () => {
  it("succeeds on first attempt when everything passes", async () => {
    const { deps, worktree } = makeDeps({});

    const result = await runTaskLoop(makeTask(), { maxAttempts: 2 }, deps);

    expect(result.success).toBe(true);
    expect(deps.invokeAgent).toHaveBeenCalledTimes(1);
    expect(worktree.commitAll).toHaveBeenCalledWith("Add demo page\n\nTask: demo");
  });

  it("aborts when agent invocation fails", async () => {
    const { deps } = makeDeps({
      agentResults: [{ success: false, stderr: "claude failed" }],
    });

    const result = await runTaskLoop(makeTask(), { maxAttempts: 2 }, deps);

    expect(result.success).toBe(false);
  });

  it("retries with focused feedback when path policy fails", async () => {
    const { deps } = makeDeps({
      changedFiles: [["package.json"], ["src/page.tsx"]],
      gateResults: [[{ name: "typecheck", passed: true, exitCode: 0, output: "" }]],
      agentResults: [
        { success: true, stderr: "" },
        { success: true, stderr: "" },
      ],
    });

    const result = await runTaskLoop(makeTask(), { maxAttempts: 2 }, deps);

    expect(result.success).toBe(true);
    expect(deps.invokeAgent).toHaveBeenCalledTimes(2);
    const secondPrompt = vi.mocked(deps.invokeAgent).mock.calls[1]?.[0].prompt;
    expect(secondPrompt).toContain("Agent modified forbidden files");
  });

  it("retries with gate output when a gate fails", async () => {
    const { deps } = makeDeps({
      gateResults: [
        [{ name: "typecheck", passed: false, exitCode: 1, output: "bad types" }],
        [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
      ],
      agentResults: [
        { success: true, stderr: "" },
        { success: true, stderr: "" },
      ],
    });

    const result = await runTaskLoop(makeTask(), { maxAttempts: 2 }, deps);

    expect(result.success).toBe(true);
    const secondPrompt = vi.mocked(deps.invokeAgent).mock.calls[1]?.[0].prompt;
    expect(secondPrompt).toContain("=== typecheck (exit 1) ===");
    expect(secondPrompt).toContain("bad types");
  });

  it("commits on success", async () => {
    const { deps, worktree } = makeDeps({});

    const result = await runTaskLoop(makeTask(), { maxAttempts: 2 }, deps);

    expect(result.success).toBe(true);
    expect(worktree.commitAll).toHaveBeenCalledWith("Add demo page\n\nTask: demo");
  });

  it("does not commit after exhausting attempts", async () => {
    const { deps, worktree } = makeDeps({
      gateResults: [
        [{ name: "typecheck", passed: false, exitCode: 1, output: "bad types" }],
        [{ name: "typecheck", passed: false, exitCode: 1, output: "still bad" }],
      ],
      agentResults: [
        { success: true, stderr: "" },
        { success: true, stderr: "" },
      ],
    });

    const result = await runTaskLoop(makeTask(), { maxAttempts: 2 }, deps);

    expect(result.success).toBe(false);
    expect(worktree.commitAll).not.toHaveBeenCalled();
  });

  it("skips evaluator when not configured", async () => {
    const { deps } = makeDeps({});

    const result = await runTaskLoop(makeTask(), { maxAttempts: 2 }, deps);

    expect(result.success).toBe(true);
    expect(deps.runEvaluator).not.toHaveBeenCalled();
  });

  it("runs evaluator when enabled and commits after eval passes", async () => {
    const { deps, worktree } = makeDeps({
      evalResults: [{ passed: true, score: 90, issues: [], summary: "Approved." }],
    });

    const task = makeTask({
      evaluator: { enabled: true, model: "opus", mode: "diff-review" },
    });
    const result = await runTaskLoop(task, { maxAttempts: 2 }, deps);

    expect(result.success).toBe(true);
    expect(deps.runEvaluator).toHaveBeenCalledTimes(1);
    expect(worktree.commitAll).toHaveBeenCalled();
  });

  it("retries with evaluator feedback when evaluator rejects", async () => {
    const { deps } = makeDeps({
      evalResults: [
        {
          passed: false,
          score: 30,
          issues: [
            {
              severity: "critical",
              criterion: "Route renders",
              description: "Route handler is stubbed",
              suggestion: "Implement the handler",
            },
          ],
          summary: "Implementation is incomplete.",
        },
        { passed: true, score: 85, issues: [], summary: "Now looks good." },
      ],
      gateResults: [
        [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
        [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
      ],
      agentResults: [
        { success: true, stderr: "" },
        { success: true, stderr: "" },
      ],
    });

    const task = makeTask({
      evaluator: { enabled: true, model: "opus", mode: "diff-review" },
    });
    const result = await runTaskLoop(task, { maxAttempts: 2 }, deps);

    expect(result.success).toBe(true);
    expect(deps.runEvaluator).toHaveBeenCalledTimes(2);
    expect(deps.invokeAgent).toHaveBeenCalledTimes(2);
    const secondPrompt = vi.mocked(deps.invokeAgent).mock.calls[1]?.[0].prompt;
    expect(secondPrompt).toContain("Evaluator Review");
    expect(secondPrompt).toContain("Route handler is stubbed");
  });

  it("runs evaluator even when gates fail", async () => {
    const { deps } = makeDeps({
      gateResults: [
        [{ name: "typecheck", passed: false, exitCode: 1, output: "bad types" }],
        [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
      ],
      evalResults: [
        { passed: true, score: 70, issues: [], summary: "Looks functional." },
        { passed: true, score: 90, issues: [], summary: "Approved." },
      ],
      agentResults: [
        { success: true, stderr: "" },
        { success: true, stderr: "" },
      ],
    });

    const task = makeTask({
      evaluator: { enabled: true, model: "opus", mode: "diff-review" },
    });
    const result = await runTaskLoop(task, { maxAttempts: 2 }, deps);

    expect(result.success).toBe(true);
    expect(deps.runEvaluator).toHaveBeenCalledTimes(2);
    const secondPrompt = vi.mocked(deps.invokeAgent).mock.calls[1]?.[0].prompt;
    expect(secondPrompt).toContain("=== typecheck (exit 1) ===");
  });

  it("combines gate and evaluator failures in retry feedback", async () => {
    const { deps } = makeDeps({
      gateResults: [
        [{ name: "typecheck", passed: false, exitCode: 1, output: "bad types" }],
        [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
      ],
      evalResults: [
        { passed: false, issues: [], summary: "Missing implementation." },
        { passed: true, score: 90, issues: [], summary: "Approved." },
      ],
      agentResults: [
        { success: true, stderr: "" },
        { success: true, stderr: "" },
      ],
    });

    const task = makeTask({
      evaluator: { enabled: true, model: "opus", mode: "diff-review" },
    });
    const result = await runTaskLoop(task, { maxAttempts: 2 }, deps);

    expect(result.success).toBe(true);
    const secondPrompt = vi.mocked(deps.invokeAgent).mock.calls[1]?.[0].prompt;
    expect(secondPrompt).toContain("=== typecheck (exit 1) ===");
    expect(secondPrompt).toContain("Evaluator Review");
  });

  it("falls back to diff-review when interactive dev server fails to start", async () => {
    const { deps } = makeDeps({
      evalResults: [
        { passed: false, issues: [], summary: "Failed to start dev server: ENOENT" },
        { passed: true, score: 85, issues: [], summary: "Approved via diff-review." },
      ],
    });

    const task = makeTask({
      evaluator: { enabled: true, model: "opus", mode: "interactive" },
    });
    const result = await runTaskLoop(task, { maxAttempts: 2 }, deps);

    expect(result.success).toBe(true);
    expect(deps.runEvaluator).toHaveBeenCalledTimes(2);
    const secondCallArgs = vi.mocked(deps.runEvaluator).mock.calls[1]?.[0];
    expect(secondCallArgs?.evaluator.mode).toBe("diff-review");
  });

  it("fails after exhausting attempts with evaluator rejections", async () => {
    const { deps, worktree } = makeDeps({
      evalResults: [
        { passed: false, issues: [], summary: "Not good enough." },
        { passed: false, issues: [], summary: "Still not good enough." },
        { passed: false, issues: [], summary: "Third time not the charm." },
      ],
      gateResults: [
        [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
        [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
        [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
      ],
      agentResults: [
        { success: true, stderr: "" },
        { success: true, stderr: "" },
        { success: true, stderr: "" },
      ],
    });

    const task = makeTask({
      evaluator: { enabled: true, model: "opus", mode: "diff-review" },
    });
    const result = await runTaskLoop(task, { maxAttempts: 3 }, deps);

    expect(result.success).toBe(false);
    expect(worktree.commitAll).not.toHaveBeenCalled();
  });

  it("injects completed tasks context into agent prompt", async () => {
    const { deps } = makeDeps({});

    const result = await runTaskLoop(
      makeTask(),
      {
        maxAttempts: 2,
        completedTasks: "## prior-task: Prior Task\n\nDid something useful.\n",
      },
      deps,
    );

    expect(result.success).toBe(true);
    const firstPrompt = vi.mocked(deps.invokeAgent).mock.calls[0]?.[0].prompt;
    expect(firstPrompt).toContain("## Previously completed tasks");
    expect(firstPrompt).toContain("## prior-task: Prior Task");
  });

  it("omits completed tasks section when not provided", async () => {
    const { deps } = makeDeps({});

    const result = await runTaskLoop(makeTask(), { maxAttempts: 2 }, deps);

    expect(result.success).toBe(true);
    const firstPrompt = vi.mocked(deps.invokeAgent).mock.calls[0]?.[0].prompt;
    expect(firstPrompt).not.toContain("## Previously completed tasks");
  });

  it("returns agent summary on success", async () => {
    const { deps } = makeDeps({
      agentResults: [{ success: true, stderr: "", summary: "Added the demo page route." }],
    });

    const result = await runTaskLoop(makeTask(), { maxAttempts: 2 }, deps);

    expect(result.success).toBe(true);
    expect(result.summary).toBe("Added the demo page route.");
  });
});
