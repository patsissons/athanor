import { execa, type ResultPromise } from "execa";
import type { DevServerConfig } from "./eval-spec.js";

export interface DevServerHandle {
  url: string;
  stop(): Promise<void>;
}

export interface StartDevServerDeps {
  spawn(command: string, opts: { cwd: string; shell: boolean }): ResultPromise;
}

const defaultDeps: StartDevServerDeps = {
  spawn: (command, opts) => execa(command, { ...opts, reject: false, buffer: false }),
};

/**
 * Start a dev server and wait for the ready pattern to appear in stdout.
 * Returns a handle to get the URL and stop the server.
 */
export async function startDevServer(
  config: DevServerConfig,
  cwd: string,
  deps: StartDevServerDeps = defaultDeps,
): Promise<DevServerHandle> {
  const child = deps.spawn(config.command, { cwd, shell: true });

  const url = `http://localhost:${config.port}`;

  await waitForReady(child, config.readyPattern, config.timeoutMs);

  return {
    url,
    async stop() {
      if (!child.killed) {
        child.kill("SIGTERM");
        // Give 5s for graceful shutdown, then force kill
        const forceKill = setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
        try {
          await child;
        } catch {
          // Process exit is expected
        } finally {
          clearTimeout(forceKill);
        }
      }
    },
  };
}

function waitForReady(
  child: ResultPromise,
  readyPattern: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`Dev server did not emit ready pattern "${readyPattern}" within ${timeoutMs}ms`),
      );
    }, timeoutMs);

    let resolved = false;

    const onData = (chunk: Buffer) => {
      if (resolved) return;
      const text = chunk.toString();
      if (text.includes(readyPattern)) {
        resolved = true;
        clearTimeout(timer);
        // Stop listening but keep the process running
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve();
      }
    };

    child.stdout?.on("data", onData);
    // Some frameworks log ready messages to stderr
    child.stderr?.on("data", onData);

    // Handle process exiting before ready
    child.then(
      () => {
        if (!resolved) {
          clearTimeout(timer);
          reject(new Error("Dev server exited before emitting ready pattern"));
        }
      },
      (err: unknown) => {
        if (!resolved) {
          clearTimeout(timer);
          reject(new Error(`Dev server failed to start: ${String(err)}`));
        }
      },
    );
  });
}
