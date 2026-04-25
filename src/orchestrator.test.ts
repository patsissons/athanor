import { describe, expect, it, vi } from "vitest";
import {
  runTask,
  type CommandResult,
  type RunTaskDeps,
  type RunTaskLogger,
  type WorktreeLike,
} from "./orchestrator.js";
import { TaskSpecSchema, type TaskSpec } from "./task-spec.js";

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

function makeRuntime(opts: {
  changedFiles?: string[][];
  installResults?: CommandResult[];
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
  pushError?: Error;
  existingCompletedTasks?: string;
}) {
  const { logger, messages } = makeLogger();
  const changedFiles = [...(opts.changedFiles ?? [[]])];
  const installResults = [...(opts.installResults ?? [{ exitCode: 0, stderr: "" }])];
  const formatResults = [...(opts.formatResults ?? [{ exitCode: 0, stderr: "" }])];
  const agentResults = [...(opts.agentResults ?? [{ success: true, stderr: "" }])];
  const gateResults = [
    ...(opts.gateResults ?? [[{ name: "typecheck", passed: true, exitCode: 0, output: "" }]]),
  ];

  const worktree: WorktreeLike = {
    branch: "athanor/demo/20260423-120000-abcd",
    path: "/tmp/wt",
    create: vi.fn().mockResolvedValue("/tmp/wt"),
    changedFiles: vi.fn().mockImplementation(async () => changedFiles.shift() ?? []),
    diff: vi.fn().mockResolvedValue("diff --git a/src/page.tsx b/src/page.tsx\n+code"),
    commitAll: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockImplementation(async () => {
      if (opts.pushError) {
        throw opts.pushError;
      }
    }),
  };

  const evalResults = [
    ...(opts.evalResults ?? [{ passed: true, issues: [], summary: "Approved." }]),
  ];

  const appendedSummaries: { taskId: string; taskTitle: string; summary: string }[] = [];

  const deps: RunTaskDeps = {
    createWorktree: vi.fn(() => worktree),
    makeRunId: vi.fn(() => "20260423-120000-abcd"),
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
    runCommand: vi.fn().mockImplementation(async (_command, args) => {
      if (args[0] === "install") {
        return installResults.shift() ?? { exitCode: 0, stderr: "" };
      }

      return formatResults.shift() ?? { exitCode: 0, stderr: "" };
    }),
    loadCompletedTasks: vi.fn().mockResolvedValue(opts.existingCompletedTasks),
    appendCompletedTask: vi
      .fn()
      .mockImplementation(
        async (_root: string, taskId: string, taskTitle: string, summary: string) => {
          appendedSummaries.push({ taskId, taskTitle, summary });
        },
      ),
    log: logger,
  };

  return { worktree, deps, messages, appendedSummaries };
}

const taskOpts = { targetRepoRoot: "/repo", harnessRoot: "/harness" };

describe("runTask", () => {
  it("aborts when install fails", async () => {
    const runtime = makeRuntime({
      installResults: [{ exitCode: 1, stderr: "boom" }],
    });

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(false);
    expect(runtime.messages.error).toContain("npm install failed:\nboom");
    expect(runtime.deps.invokeAgent).not.toHaveBeenCalled();
  });

  it("aborts when agent invocation fails", async () => {
    const runtime = makeRuntime({
      agentResults: [{ success: false, stderr: "claude failed" }],
    });

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(false);
    expect(runtime.messages.error).toContain("Agent invocation failed: claude failed");
  });

  it("retries with focused feedback when path policy fails", async () => {
    const runtime = makeRuntime({
      changedFiles: [["package.json"], ["src/page.tsx"]],
      gateResults: [[{ name: "typecheck", passed: true, exitCode: 0, output: "" }]],
      agentResults: [
        { success: true, stderr: "" },
        { success: true, stderr: "" },
      ],
    });

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(true);
    expect(runtime.deps.invokeAgent).toHaveBeenCalledTimes(2);
    const secondPrompt = vi.mocked(runtime.deps.invokeAgent).mock.calls[1]?.[0].prompt;
    expect(secondPrompt).toContain("Agent modified forbidden files");
  });

  it("retries with gate output when a gate fails", async () => {
    const runtime = makeRuntime({
      gateResults: [
        [{ name: "typecheck", passed: false, exitCode: 1, output: "bad types" }],
        [{ name: "typecheck", passed: true, exitCode: 0, output: "" }],
      ],
      agentResults: [
        { success: true, stderr: "" },
        { success: true, stderr: "" },
      ],
    });

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(true);
    const secondPrompt = vi.mocked(runtime.deps.invokeAgent).mock.calls[1]?.[0].prompt;
    expect(secondPrompt).toContain("=== typecheck (exit 1) ===");
    expect(secondPrompt).toContain("bad types");
  });

  it("commits and pushes on success", async () => {
    const runtime = makeRuntime({});

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(true);
    expect(runtime.worktree.commitAll).toHaveBeenCalledWith("Add demo page\n\nTask: demo");
    expect(runtime.worktree.push).toHaveBeenCalled();
  });

  it("warns when push fails but still returns success", async () => {
    const runtime = makeRuntime({
      pushError: new Error("no remote"),
    });

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(true);
    expect(runtime.messages.warn.some((message) => message.includes("Push failed"))).toBe(true);
  });

  it("returns false after exhausting attempts without committing", async () => {
    const runtime = makeRuntime({
      gateResults: [
        [{ name: "typecheck", passed: false, exitCode: 1, output: "bad types" }],
        [{ name: "typecheck", passed: false, exitCode: 1, output: "still bad" }],
      ],
      agentResults: [
        { success: true, stderr: "" },
        { success: true, stderr: "" },
      ],
    });

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(false);
    expect(runtime.worktree.commitAll).not.toHaveBeenCalled();
  });

  it("appends agent summary to completed-tasks on success", async () => {
    const runtime = makeRuntime({
      agentResults: [{ success: true, stderr: "", summary: "Added the demo page route." }],
    });

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(true);
    expect(runtime.appendedSummaries).toHaveLength(1);
    expect(runtime.appendedSummaries[0]).toEqual({
      taskId: "demo",
      taskTitle: "Add demo page",
      summary: "Added the demo page route.",
    });
  });

  it("uses fallback summary when agent provides none", async () => {
    const runtime = makeRuntime({
      agentResults: [{ success: true, stderr: "" }],
    });

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(true);
    expect(runtime.appendedSummaries[0]?.summary).toBe("Completed task: Add demo page");
  });

  it("does not append summary when task fails", async () => {
    const runtime = makeRuntime({
      gateResults: [
        [{ name: "typecheck", passed: false, exitCode: 1, output: "bad types" }],
        [{ name: "typecheck", passed: false, exitCode: 1, output: "still bad" }],
      ],
      agentResults: [
        { success: true, stderr: "" },
        { success: true, stderr: "" },
      ],
    });

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(false);
    expect(runtime.appendedSummaries).toHaveLength(0);
  });

  it("includes previously completed tasks in prompt when they exist", async () => {
    const runtime = makeRuntime({
      existingCompletedTasks: "## prior-task: Prior Task\n\nDid something useful.\n",
    });

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(true);
    const firstPrompt = vi.mocked(runtime.deps.invokeAgent).mock.calls[0]?.[0].prompt;
    expect(firstPrompt).toContain("## Previously completed tasks");
    expect(firstPrompt).toContain("## prior-task: Prior Task");
  });

  it("omits previously completed tasks section when none exist", async () => {
    const runtime = makeRuntime({});

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(true);
    const firstPrompt = vi.mocked(runtime.deps.invokeAgent).mock.calls[0]?.[0].prompt;
    expect(firstPrompt).not.toContain("## Previously completed tasks");
  });

  it("skips evaluator when not configured", async () => {
    const runtime = makeRuntime({});

    const ok = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(ok).toBe(true);
    expect(runtime.deps.runEvaluator).not.toHaveBeenCalled();
  });

  it("runs evaluator after gates pass when enabled", async () => {
    const runtime = makeRuntime({
      evalResults: [{ passed: true, score: 90, issues: [], summary: "Approved." }],
    });

    const task = makeTask({
      evaluator: { enabled: true, model: "opus", mode: "diff-review" },
    });
    const ok = await runTask(task, taskOpts, runtime.deps);

    expect(ok).toBe(true);
    expect(runtime.deps.runEvaluator).toHaveBeenCalledTimes(1);
    expect(runtime.worktree.commitAll).toHaveBeenCalled();
  });

  it("retries with evaluator feedback when evaluator rejects", async () => {
    const runtime = makeRuntime({
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
    const ok = await runTask(task, taskOpts, runtime.deps);

    expect(ok).toBe(true);
    expect(runtime.deps.runEvaluator).toHaveBeenCalledTimes(2);
    expect(runtime.deps.invokeAgent).toHaveBeenCalledTimes(2);
    const secondPrompt = vi.mocked(runtime.deps.invokeAgent).mock.calls[1]?.[0].prompt;
    expect(secondPrompt).toContain("Evaluator Review");
    expect(secondPrompt).toContain("Route handler is stubbed");
  });

  it("does not run evaluator when gates fail", async () => {
    const runtime = makeRuntime({
      gateResults: [
        [{ name: "typecheck", passed: false, exitCode: 1, output: "bad types" }],
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
    const ok = await runTask(task, taskOpts, runtime.deps);

    expect(ok).toBe(true);
    // Evaluator should only run on the second attempt (when gates pass)
    expect(runtime.deps.runEvaluator).toHaveBeenCalledTimes(1);
  });

  it("fails after exhausting attempts with evaluator rejections", async () => {
    const runtime = makeRuntime({
      evalResults: [
        { passed: false, issues: [], summary: "Not good enough." },
        { passed: false, issues: [], summary: "Still not good enough." },
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
    const ok = await runTask(task, taskOpts, runtime.deps);

    expect(ok).toBe(false);
    expect(runtime.worktree.commitAll).not.toHaveBeenCalled();
  });
});
