import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { execa } from "execa";
import { WorktreeBackend } from "./worktree-backend.js";
import type { WorktreeLike } from "./index.js";

vi.mock("execa", () => ({ execa: vi.fn() }));

const mockExeca = vi.mocked(execa);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockExeca.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeMockWorktree(): WorktreeLike & { [k: string]: unknown } {
  return {
    branch: "athanor/demo/run",
    path: "/tmp/wt",
    create: vi.fn().mockResolvedValue("/tmp/wt"),
    changedFiles: vi.fn().mockResolvedValue(["src/foo.ts"]),
    diff: vi.fn().mockResolvedValue("diff --git a/foo b/foo"),
    commitAll: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

describe("WorktreeBackend (delegation)", () => {
  it("delegates branch and path to the wrapped worktree", () => {
    const wt = makeMockWorktree();
    const backend = new WorktreeBackend(wt);
    expect(backend.branch).toBe("athanor/demo/run");
    expect(backend.path).toBe("/tmp/wt");
  });

  it("delegates create/changedFiles/diff/commitAll/push to the wrapped worktree", async () => {
    const wt = makeMockWorktree();
    const backend = new WorktreeBackend(wt);
    await backend.create();
    await backend.changedFiles();
    await backend.diff();
    await backend.commitAll("msg");
    await backend.push();
    expect(wt.create).toHaveBeenCalledTimes(1);
    expect(wt.changedFiles).toHaveBeenCalledTimes(1);
    expect(wt.diff).toHaveBeenCalledTimes(1);
    expect(wt.commitAll).toHaveBeenCalledWith("msg");
    expect(wt.push).toHaveBeenCalledTimes(1);
  });

  it("does NOT propagate destroy() to the wrapped worktree", async () => {
    // destroy() on the backend is a no-op — the host worktree is
    // intentionally left on disk for human inspection; `athanor clean`
    // is the explicit path for removing it.
    const wt = makeMockWorktree();
    const backend = new WorktreeBackend(wt);
    await backend.destroy();
    expect(wt.destroy).not.toHaveBeenCalled();
  });
});

describe("WorktreeBackend.runCommand", () => {
  it("invokes execa with cwd: wt.path and timeout: timeoutMs", async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "out", stderr: "err" } as never);
    const wt = makeMockWorktree();
    const backend = new WorktreeBackend(wt);
    await backend.runCommand("npm", ["run", "format"], { timeoutMs: 60_000 });
    const call = mockExeca.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(call[0]).toBe("npm");
    expect(call[1]).toEqual(["run", "format"]);
    expect(call[2]).toMatchObject({ cwd: "/tmp/wt", timeout: 60_000 });
  });

  it("returns the captured stdout and stderr alongside exitCode", async () => {
    mockExeca.mockResolvedValue({ exitCode: 1, stdout: "out", stderr: "err" } as never);
    const wt = makeMockWorktree();
    const backend = new WorktreeBackend(wt);
    const result = await backend.runCommand("x", [], { timeoutMs: 1000 });
    expect(result).toEqual({ exitCode: 1, stdout: "out", stderr: "err" });
  });

  it("merges opts.env over process.env when env is provided", async () => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    const wt = makeMockWorktree();
    const backend = new WorktreeBackend(wt);
    process.env.PRESERVED = "yes";
    await backend.runCommand("x", [], {
      timeoutMs: 1000,
      env: { CUSTOM: "set" },
    });
    const call = mockExeca.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    const env = call[2].env;
    expect(env.CUSTOM).toBe("set");
    expect(env.PRESERVED).toBe("yes");
    delete process.env.PRESERVED;
  });

  it("surfaces a signal-killed exit as exitCode: null", async () => {
    mockExeca.mockResolvedValue({ exitCode: undefined, stdout: "", stderr: "" } as never);
    const wt = makeMockWorktree();
    const backend = new WorktreeBackend(wt);
    const result = await backend.runCommand("x", [], { timeoutMs: 1000 });
    expect(result.exitCode).toBeNull();
  });
});

interface FakeChildOpts {
  exitCode: number;
  events: object[];
}

function makeFakeChild(opts: FakeChildOpts) {
  const stdout = new PassThrough();
  const childPromise = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve) => {
      setImmediate(() => {
        for (const evt of opts.events) {
          stdout.write(JSON.stringify(evt) + "\n");
        }
        stdout.end();
        setImmediate(() => resolve({ exitCode: opts.exitCode, stdout: "", stderr: "" }));
      });
    },
  );
  return Object.assign(childPromise, { stdout }) as unknown;
}

describe("WorktreeBackend.runAgent", () => {
  it("runs claude through execaClaudeExec(wt.path) and returns an AgentResult", async () => {
    mockExeca.mockReturnValue(
      makeFakeChild({
        exitCode: 0,
        events: [
          {
            type: "result",
            result: "all done <task-summary>shipped</task-summary>",
            num_turns: 1,
            duration_ms: 5,
          },
        ],
      }) as never,
    );
    const wt = makeMockWorktree();
    const backend = new WorktreeBackend(wt);
    const result = await backend.runAgent({ prompt: "hi", model: "sonnet" });
    expect(result.success).toBe(true);
    expect(result.summary).toBe("shipped");
    // claude is invoked with cwd: wt.path
    const call = mockExeca.mock.calls[0] as unknown as [string, string[], { cwd: string }];
    expect(call[0]).toBe("claude");
    expect(call[2].cwd).toBe("/tmp/wt");
  });

  it("materialises mcpConfig to a tempfile, threads its path into args, and unlinks after", async () => {
    let observedPath: string | undefined;
    let observedContent: unknown;

    mockExeca.mockImplementation(((_cmd: string, args: string[]) => {
      const idx = args.indexOf("--mcp-config");
      if (idx !== -1) {
        observedPath = args[idx + 1];
        observedContent = JSON.parse(readFileSync(observedPath, "utf8"));
      }
      return makeFakeChild({
        exitCode: 0,
        events: [{ type: "result", result: "done", num_turns: 1, duration_ms: 1 }],
      });
    }) as never);

    const mcpConfig = { mcpServers: { foo: { command: "node", args: ["server.js"] } } };
    const backend = new WorktreeBackend(makeMockWorktree());
    await backend.runAgent({ prompt: "hi", model: "sonnet", mcpConfig });

    expect(observedPath).toBeDefined();
    expect(observedContent).toEqual(mcpConfig);
    // Tempfile is unlinked after the call returns.
    expect(existsSync(observedPath!)).toBe(false);
  });

  it("does not write a tempfile when mcpConfig is omitted", async () => {
    let sawMcpFlag = false;
    mockExeca.mockImplementation(((_cmd: string, args: string[]) => {
      if (args.includes("--mcp-config")) sawMcpFlag = true;
      return makeFakeChild({
        exitCode: 0,
        events: [{ type: "result", result: "done", num_turns: 1, duration_ms: 1 }],
      });
    }) as never);

    const backend = new WorktreeBackend(makeMockWorktree());
    await backend.runAgent({ prompt: "hi", model: "sonnet" });
    expect(sawMcpFlag).toBe(false);
  });
});
