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
  installResults?: CommandResult[];
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
}) {
  const { logger, messages } = makeLogger();
  const installResults = [...(opts.installResults ?? [{ exitCode: 0, stderr: "" }])];
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
    changedFiles: vi.fn().mockResolvedValue([]),
    diff: vi.fn().mockResolvedValue("diff --git a/src/page.tsx b/src/page.tsx\n+code"),
    commitAll: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockImplementation(async () => {
      if (opts.pushError) {
        throw opts.pushError;
      }
    }),
  };

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
      return { exitCode: 0, stderr: "" };
    }),
    log: logger,
  };

  return { worktree, deps, messages };
}

const taskOpts = { targetRepoRoot: "/repo", harnessRoot: "/harness" };

describe("runTask", () => {
  it("aborts when install fails", async () => {
    const runtime = makeRuntime({
      installResults: [{ exitCode: 1, stderr: "boom" }],
    });

    const result = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(result.success).toBe(false);
    expect(runtime.messages.error).toContain("npm install failed:\nboom");
    expect(runtime.deps.invokeAgent).not.toHaveBeenCalled();
  });

  it("commits and pushes on success", async () => {
    const runtime = makeRuntime({});

    const result = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(result.success).toBe(true);
    expect(runtime.worktree.commitAll).toHaveBeenCalledWith("Add demo page\n\nTask: demo");
    expect(runtime.worktree.push).toHaveBeenCalled();
  });

  it("warns when push fails but still returns success", async () => {
    const runtime = makeRuntime({
      pushError: new Error("no remote"),
    });

    const result = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(result.success).toBe(true);
    expect(runtime.messages.warn.some((message) => message.includes("Push failed"))).toBe(true);
  });

  it("returns branch in result on success", async () => {
    const runtime = makeRuntime({});

    const result = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(result).toEqual({
      success: true,
      branch: "athanor/demo/20260423-120000-abcd",
    });
  });

  it("returns branch in result on failure", async () => {
    const runtime = makeRuntime({
      gateResults: [
        [{ name: "typecheck", passed: false, exitCode: 1, output: "bad" }],
        [{ name: "typecheck", passed: false, exitCode: 1, output: "bad" }],
      ],
      agentResults: [
        { success: true, stderr: "" },
        { success: true, stderr: "" },
      ],
    });

    const result = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(result).toEqual({
      success: false,
      branch: "athanor/demo/20260423-120000-abcd",
    });
  });

  it("forwards baseBranch to createWorktree", async () => {
    const runtime = makeRuntime({});

    await runTask(makeTask(), { ...taskOpts, baseBranch: "athanor/prev/run" }, runtime.deps);

    expect(runtime.deps.createWorktree).toHaveBeenCalledWith(
      "/repo",
      "/harness",
      "demo",
      "20260423-120000-abcd",
      "athanor/prev/run",
    );
  });

  it("omits baseBranch when not provided", async () => {
    const runtime = makeRuntime({});

    await runTask(makeTask(), taskOpts, runtime.deps);

    expect(runtime.deps.createWorktree).toHaveBeenCalledWith(
      "/repo",
      "/harness",
      "demo",
      "20260423-120000-abcd",
      undefined,
    );
  });

  it("skips push when push option is false", async () => {
    const runtime = makeRuntime({});

    const result = await runTask(makeTask(), { ...taskOpts, push: false }, runtime.deps);

    expect(result.success).toBe(true);
    expect(runtime.worktree.commitAll).toHaveBeenCalled();
    expect(runtime.worktree.push).not.toHaveBeenCalled();
  });

  it("pushes by default when push option is not set", async () => {
    const runtime = makeRuntime({});

    const result = await runTask(makeTask(), taskOpts, runtime.deps);

    expect(result.success).toBe(true);
    expect(runtime.worktree.push).toHaveBeenCalled();
  });

  it("defaults maxAgentAttempts to 3 when evaluator is enabled", async () => {
    const runtime = makeRuntime({
      evalResults: [
        { passed: false, issues: [], summary: "Not good enough." },
        { passed: false, issues: [], summary: "Still not good enough." },
        { passed: true, score: 80, issues: [], summary: "Now approved." },
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
    const result = await runTask(task, taskOpts, runtime.deps);

    expect(result.success).toBe(true);
    expect(runtime.deps.invokeAgent).toHaveBeenCalledTimes(3);
  });

  it("does not override maxAgentAttempts when explicitly set", async () => {
    const runtime = makeRuntime({
      evalResults: [{ passed: false, issues: [], summary: "Not good enough." }],
      gateResults: [[{ name: "typecheck", passed: true, exitCode: 0, output: "" }]],
      agentResults: [{ success: true, stderr: "" }],
    });

    const task = makeTask({
      evaluator: { enabled: true, model: "opus", mode: "diff-review" },
      maxAgentAttempts: 1,
    });
    const result = await runTask(task, taskOpts, runtime.deps);

    expect(result.success).toBe(false);
    expect(runtime.deps.invokeAgent).toHaveBeenCalledTimes(1);
  });
});
