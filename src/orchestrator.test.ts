import { describe, expect, it, vi } from "vitest";
import {
  runTask,
  type CommandResult,
  type RunTaskDeps,
  type RunTaskLogger,
  type WorktreeLike,
} from "./orchestrator.js";
import { TaskSpecSchema, type TaskSpec } from "./task-spec.js";
import type { IsolationBackend } from "./isolation/index.js";

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
    destroy: vi.fn().mockResolvedValue(undefined),
  };

  // The IsolationBackend mock is constructed once and injected via the
  // createIsolation factory. It delegates worktree-passthrough methods
  // to the worktree mock above so existing assertions on
  // worktree.commitAll / worktree.push keep working.
  const isolation: IsolationBackend = {
    get branch() {
      return worktree.branch;
    },
    get path() {
      return worktree.path;
    },
    create: () => worktree.create(),
    changedFiles: () => worktree.changedFiles(),
    diff: () => worktree.diff(),
    commitAll: (msg: string) => worktree.commitAll(msg),
    push: () => worktree.push(),
    destroy: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockImplementation(async () => {
      const r = agentResults.shift() ?? { success: true, stderr: "" };
      return { success: r.success, stdout: "", stderr: r.stderr, parsed: null, summary: r.summary };
    }),
    runCommand: vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      // npm install warm-up uses the install path; gate sh -c invocations
      // come through the gateRunner adapter and route through this same
      // mock. The test only cares about the install result.
      if (args[0] === "install") {
        const r = installResults.shift() ?? { exitCode: 0, stderr: "" };
        return { exitCode: r.exitCode, stdout: "", stderr: r.stderr };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
  };

  const deps: RunTaskDeps = {
    createIsolationBackend: vi.fn(async () => isolation),
    makeRunId: vi.fn(() => "20260423-120000-abcd"),
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
    log: logger,
  };

  return { worktree, isolation, deps, messages };
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
    expect(runtime.isolation.runAgent).not.toHaveBeenCalled();
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

  it("forwards baseBranch to createIsolationBackend", async () => {
    const runtime = makeRuntime({});

    await runTask(makeTask(), { ...taskOpts, baseBranch: "athanor/prev/run" }, runtime.deps);

    expect(runtime.deps.createIsolationBackend).toHaveBeenCalledWith(
      { backend: "worktree" },
      {
        targetRepoRoot: "/repo",
        harnessRoot: "/harness",
        identifier: "demo",
        runId: "20260423-120000-abcd",
        baseBranch: "athanor/prev/run",
      },
    );
  });

  it("omits baseBranch when not provided", async () => {
    const runtime = makeRuntime({});

    await runTask(makeTask(), taskOpts, runtime.deps);

    expect(runtime.deps.createIsolationBackend).toHaveBeenCalledWith(
      { backend: "worktree" },
      {
        targetRepoRoot: "/repo",
        harnessRoot: "/harness",
        identifier: "demo",
        runId: "20260423-120000-abcd",
        baseBranch: undefined,
      },
    );
  });

  it("resolves an explicit task.isolation override and passes it to createIsolationBackend", async () => {
    const runtime = makeRuntime({});

    const task = makeTask({
      isolation: { backend: "sandcastle", provider: "docker" },
    });

    await runTask(task, taskOpts, runtime.deps);

    expect(runtime.deps.createIsolationBackend).toHaveBeenCalledWith(
      { backend: "sandcastle", provider: "docker" },
      expect.objectContaining({
        targetRepoRoot: "/repo",
        harnessRoot: "/harness",
        identifier: "demo",
      }),
    );
  });

  it("calls isolation.destroy in finally on success", async () => {
    const runtime = makeRuntime({});

    await runTask(makeTask(), taskOpts, runtime.deps);

    expect(runtime.isolation.destroy).toHaveBeenCalledTimes(1);
  });

  it("calls isolation.destroy in finally even when the task fails", async () => {
    const runtime = makeRuntime({
      installResults: [{ exitCode: 1, stderr: "boom" }],
    });

    await runTask(makeTask(), taskOpts, runtime.deps);

    expect(runtime.isolation.destroy).toHaveBeenCalledTimes(1);
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
    expect(runtime.isolation.runAgent).toHaveBeenCalledTimes(3);
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
    expect(runtime.isolation.runAgent).toHaveBeenCalledTimes(1);
  });
});
