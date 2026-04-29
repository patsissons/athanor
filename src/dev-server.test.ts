import { describe, expect, it, vi } from "vitest";
import { startDevServer, type StartDevServerDeps } from "./dev-server.js";
import { EventEmitter } from "node:events";
import type { DevServerConfig } from "./eval-spec.js";

const config: DevServerConfig = {
  command: "npm run dev",
  readyPattern: "ready on",
  port: 3000,
  timeoutMs: 500,
};

function makeMockChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let killed = false;
  let resolveProcess: (value: unknown) => void;
  let rejectProcess: (reason: unknown) => void;

  const processPromise = new Promise((resolve, reject) => {
    resolveProcess = resolve;
    rejectProcess = reject;
  });

  const child = Object.assign(processPromise, {
    stdout,
    stderr,
    killed,
    kill: vi.fn((signal?: string) => {
      killed = true;
      child.killed = true;
      // Simulate process exit
      if (signal === "SIGKILL" || signal === "SIGTERM") {
        resolveProcess!({ exitCode: null });
      }
    }),
  });

  return {
    child,
    emitStdout: (data: string) => stdout.emit("data", Buffer.from(data)),
    emitStderr: (data: string) => stderr.emit("data", Buffer.from(data)),
    resolve: resolveProcess!,
    reject: rejectProcess!,
  };
}

describe("startDevServer", () => {
  it("resolves when ready pattern is found in stdout", async () => {
    const mock = makeMockChild();
    const deps: StartDevServerDeps = {
      spawn: vi.fn(() => mock.child as never),
    };

    const promise = startDevServer(config, "/tmp/wt", deps);

    // Emit the ready pattern
    mock.emitStdout("Starting dev server...\n");
    mock.emitStdout("ready on http://localhost:3000\n");

    const handle = await promise;
    expect(handle.url).toBe("http://localhost:3000");

    // Cleanup
    await handle.stop();
  });

  it("resolves when ready pattern is found in stderr", async () => {
    const mock = makeMockChild();
    const deps: StartDevServerDeps = {
      spawn: vi.fn(() => mock.child as never),
    };

    const promise = startDevServer(config, "/tmp/wt", deps);

    mock.emitStderr("ready on http://localhost:3000\n");

    const handle = await promise;
    expect(handle.url).toBe("http://localhost:3000");

    await handle.stop();
  });

  it("rejects when timeout is exceeded", async () => {
    const mock = makeMockChild();
    const deps: StartDevServerDeps = {
      spawn: vi.fn(() => mock.child as never),
    };

    const promise = startDevServer({ ...config, timeoutMs: 50 }, "/tmp/wt", deps);

    await expect(promise).rejects.toThrow("did not emit ready pattern");
  });

  it("rejects when process exits before ready", async () => {
    const mock = makeMockChild();
    const deps: StartDevServerDeps = {
      spawn: vi.fn(() => mock.child as never),
    };

    const promise = startDevServer(config, "/tmp/wt", deps);

    // Process exits immediately
    mock.resolve({ exitCode: 1 });

    await expect(promise).rejects.toThrow("exited before emitting ready pattern");
  });

  it("stop() kills the process", async () => {
    const mock = makeMockChild();
    const deps: StartDevServerDeps = {
      spawn: vi.fn(() => mock.child as never),
    };

    const promise = startDevServer(config, "/tmp/wt", deps);
    mock.emitStdout("ready on http://localhost:3000\n");
    const handle = await promise;

    await handle.stop();
    expect(mock.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("force-kills with SIGKILL when graceful shutdown does not complete in time", async () => {
    vi.useFakeTimers();
    try {
      const mock = makeMockChild();
      // Override the default kill behavior so SIGTERM does NOT auto-resolve
      // the process promise — we want to simulate a hung child that ignores
      // graceful shutdown.
      mock.child.kill = vi.fn((signal?: string) => {
        if (signal === "SIGKILL") {
          mock.child.killed = true;
          mock.resolve({ exitCode: null });
        }
      });

      const deps: StartDevServerDeps = {
        spawn: vi.fn(() => mock.child as never),
      };

      const startPromise = startDevServer(config, "/tmp/wt", deps);
      mock.emitStdout("ready on http://localhost:3000\n");
      const handle = await startPromise;

      const stopPromise = handle.stop();

      // First kill is SIGTERM, queued before the timer fires.
      expect(mock.child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

      // Advance past the 5s grace period; the force-kill timer should fire.
      await vi.advanceTimersByTimeAsync(5000);

      expect(mock.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

      await stopPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes command and cwd to spawn", async () => {
    const mock = makeMockChild();
    const deps: StartDevServerDeps = {
      spawn: vi.fn(() => mock.child as never),
    };

    const promise = startDevServer(config, "/my/project", deps);
    mock.emitStdout("ready on\n");
    await promise;

    expect(deps.spawn).toHaveBeenCalledWith("npm run dev", {
      cwd: "/my/project",
      shell: true,
    });
  });
});
