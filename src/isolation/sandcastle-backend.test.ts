import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptSandcastleSandbox, SandcastleBackend } from "./sandcastle-backend.js";
import type { WorktreeLike } from "./index.js";
import type { BindMountSandboxHandle } from "@ai-hero/sandcastle";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeMockWorktree(opts: { path?: string } = {}): WorktreeLike & { [k: string]: unknown } {
  return {
    branch: "athanor/demo/run",
    path: opts.path ?? "/tmp/wt",
    create: vi.fn().mockResolvedValue(opts.path ?? "/tmp/wt"),
    changedFiles: vi.fn().mockResolvedValue([]),
    diff: vi.fn().mockResolvedValue(""),
    commitAll: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

interface FakeSandboxHandle extends BindMountSandboxHandle {
  closed: boolean;
  execCalls: Array<{ command: string; opts: Parameters<BindMountSandboxHandle["exec"]>[1] }>;
  emitLines?: (onLine: ((l: string) => void) | undefined) => void;
}

function makeFakeSandbox(
  opts: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    emitLines?: string[];
  } = {},
): FakeSandboxHandle {
  const handle: FakeSandboxHandle = {
    closed: false,
    execCalls: [],
    worktreePath: "/sandbox/wt",
    async exec(command, options) {
      handle.execCalls.push({ command, opts: options });
      if (options?.onLine && opts.emitLines) {
        for (const line of opts.emitLines) {
          options.onLine(line);
        }
      }
      return {
        stdout: opts.stdout ?? "",
        stderr: opts.stderr ?? "",
        exitCode: opts.exitCode ?? 0,
      };
    },
    async copyFileIn() {},
    async copyFileOut() {},
    async close() {
      handle.closed = true;
    },
  };
  return handle;
}

describe("adaptSandcastleSandbox", () => {
  it("converts a BindMountSandboxHandle to a ContainerLike that exec-routes commands", async () => {
    const handle = makeFakeSandbox({ exitCode: 0, stdout: "hi", stderr: "" });
    const container = adaptSandcastleSandbox(handle);
    const result = await container.exec("npm", ["ci"], { timeoutMs: 60_000 });
    expect(result).toEqual({ exitCode: 0, stdout: "hi", stderr: "" });
    expect(handle.execCalls[0].command).toBe("npm ci");
  });

  it("forwards stdoutLine to the sandcastle onLine callback", async () => {
    const handle = makeFakeSandbox({ exitCode: 0, emitLines: ["line one", "line two"] });
    const container = adaptSandcastleSandbox(handle);
    const captured: string[] = [];
    await container.exec("echo", ["hi"], {
      timeoutMs: 1000,
      stdoutLine: (line) => captured.push(line),
    });
    expect(captured).toEqual(["line one", "line two"]);
  });

  it("shell-quotes args containing whitespace or shell metacharacters", async () => {
    const handle = makeFakeSandbox();
    const container = adaptSandcastleSandbox(handle);
    await container.exec("sh", ["-c", "echo $HOME"], { timeoutMs: 1000 });
    expect(handle.execCalls[0].command).toBe("sh -c 'echo $HOME'");
  });

  it("destroy() closes the underlying sandcastle handle", async () => {
    const handle = makeFakeSandbox();
    const container = adaptSandcastleSandbox(handle);
    await container.destroy();
    expect(handle.closed).toBe(true);
  });
});

describe("SandcastleBackend (delegation)", () => {
  it("delegates branch/path/changedFiles/diff/commitAll/push to the wrapped worktree", async () => {
    const wt = makeMockWorktree();
    const backend = new SandcastleBackend({ backend: "sandcastle" }, wt, "/repo");
    expect(backend.branch).toBe("athanor/demo/run");
    expect(backend.path).toBe("/tmp/wt");
    await backend.changedFiles();
    await backend.diff();
    await backend.commitAll("msg");
    await backend.push();
    expect(wt.changedFiles).toHaveBeenCalledTimes(1);
    expect(wt.diff).toHaveBeenCalledTimes(1);
    expect(wt.commitAll).toHaveBeenCalledWith("msg");
    expect(wt.push).toHaveBeenCalledTimes(1);
  });

  it("does NOT propagate destroy() to the wrapped worktree", async () => {
    const wt = makeMockWorktree();
    const backend = new SandcastleBackend({ backend: "sandcastle" }, wt, "/repo");
    await backend.destroy();
    expect(wt.destroy).not.toHaveBeenCalled();
  });
});

describe("SandcastleBackend.runCommand", () => {
  it("throws when called before create()", async () => {
    const backend = new SandcastleBackend({ backend: "sandcastle" }, makeMockWorktree(), "/repo");
    await expect(backend.runCommand("ls", [], { timeoutMs: 1000 })).rejects.toThrow(
      /called before create/,
    );
  });

  it("once attached, routes runCommand through the container", async () => {
    const handle = makeFakeSandbox({ exitCode: 0, stdout: "ok", stderr: "" });
    const wt = makeMockWorktree();
    const backend = new SandcastleBackend({ backend: "sandcastle" }, wt, "/repo");
    // Bypass create()'s sandcastle provider call by attaching the
    // adapter manually — same code path runCommand consumes.
    (backend as unknown as { container: unknown }).container = adaptSandcastleSandbox(handle);
    const result = await backend.runCommand("npm", ["run", "format"], { timeoutMs: 60_000 });
    expect(result).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(handle.execCalls[0].command).toBe("npm run format");
  });
});

describe("SandcastleBackend.runAgent", () => {
  it("throws when called before create()", async () => {
    const backend = new SandcastleBackend({ backend: "sandcastle" }, makeMockWorktree(), "/repo");
    await expect(backend.runAgent({ prompt: "hi", model: "sonnet" })).rejects.toThrow(
      /called before create/,
    );
  });

  it("writes mcpConfig inside wt.path and unlinks on success", async () => {
    const tmpWt = mkdtempSync(join(tmpdir(), "athanor-sandcastle-test-"));
    try {
      const handle = makeFakeSandbox({
        exitCode: 0,
        emitLines: [JSON.stringify({ type: "result", result: "ok", num_turns: 1, duration_ms: 5 })],
      });
      const wt = makeMockWorktree({ path: tmpWt });
      const backend = new SandcastleBackend({ backend: "sandcastle" }, wt, "/repo");
      (backend as unknown as { container: unknown }).container = adaptSandcastleSandbox(handle);

      let observedPath: string | undefined;
      let observedContent: unknown;
      // Wrap exec to capture the mcpConfigPath that buildClaudeArgs
      // emits via --mcp-config.
      const origExec = handle.exec.bind(handle);
      handle.exec = async (command, options) => {
        const match = command.match(/--mcp-config (\S+)/);
        if (match) {
          observedPath = match[1];
          observedContent = JSON.parse(readFileSync(observedPath, "utf8"));
        }
        return origExec(command, options);
      };

      const mcpConfig = { mcpServers: { foo: { command: "node", args: ["s.js"] } } };
      const result = await backend.runAgent({ prompt: "hi", model: "sonnet", mcpConfig });

      expect(result.success).toBe(true);
      expect(observedPath).toBeDefined();
      // The tempfile lives inside the bind-mounted worktree, NOT
      // os.tmpdir() — the in-container CLI cannot see paths outside.
      expect(observedPath!.startsWith(tmpWt)).toBe(true);
      expect(observedContent).toEqual(mcpConfig);
      // Tempfile is unlinked after the call returns.
      expect(existsSync(observedPath!)).toBe(false);
    } finally {
      rmSync(tmpWt, { recursive: true, force: true });
    }
  });

  it("does not write a tempfile when mcpConfig is omitted", async () => {
    const handle = makeFakeSandbox({
      exitCode: 0,
      emitLines: [JSON.stringify({ type: "result", result: "ok", num_turns: 1, duration_ms: 1 })],
    });
    const backend = new SandcastleBackend({ backend: "sandcastle" }, makeMockWorktree(), "/repo");
    (backend as unknown as { container: unknown }).container = adaptSandcastleSandbox(handle);

    await backend.runAgent({ prompt: "hi", model: "sonnet" });

    const sawMcpFlag = handle.execCalls.some((c) => c.command.includes("--mcp-config"));
    expect(sawMcpFlag).toBe(false);
  });

  it("unlinks the mcpConfig tempfile on failure too", async () => {
    const tmpWt = mkdtempSync(join(tmpdir(), "athanor-sandcastle-test-"));
    try {
      const handle = makeFakeSandbox();
      let capturedPath: string | undefined;
      handle.exec = async (command) => {
        const match = command.match(/--mcp-config (\S+)/);
        if (match) capturedPath = match[1];
        throw new Error("simulated agent failure");
      };

      const wt = makeMockWorktree({ path: tmpWt });
      const backend = new SandcastleBackend({ backend: "sandcastle" }, wt, "/repo");
      (backend as unknown as { container: unknown }).container = adaptSandcastleSandbox(handle);

      const mcpConfig = { mcpServers: {} };
      await expect(backend.runAgent({ prompt: "hi", model: "sonnet", mcpConfig })).rejects.toThrow(
        /simulated agent failure/,
      );

      // Tempfile is still cleaned up on the failure path.
      expect(capturedPath).toBeDefined();
      expect(existsSync(capturedPath!)).toBe(false);
    } finally {
      rmSync(tmpWt, { recursive: true, force: true });
    }
  });
});

describe("SandcastleBackend.destroy", () => {
  it("closes the container handle without touching the worktree", async () => {
    const handle = makeFakeSandbox();
    const wt = makeMockWorktree();
    const backend = new SandcastleBackend({ backend: "sandcastle" }, wt, "/repo");
    (backend as unknown as { container: unknown }).container = adaptSandcastleSandbox(handle);
    await backend.destroy();
    expect(handle.closed).toBe(true);
    expect(wt.destroy).not.toHaveBeenCalled();
  });

  it("is a no-op when create() has not been called", async () => {
    const wt = makeMockWorktree();
    const backend = new SandcastleBackend({ backend: "sandcastle" }, wt, "/repo");
    await backend.destroy();
    expect(wt.destroy).not.toHaveBeenCalled();
  });
});
