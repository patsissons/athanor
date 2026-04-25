import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

// This file lives at <harnessRoot>/src/paths.ts
// So harnessRoot is one directory up.
const here = dirname(fileURLToPath(import.meta.url));
export const harnessRoot = resolve(here, "..");

export async function resolveTargetRepoRoot(cwd: string): Promise<string> {
  const result = await execa("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    reject: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(`athanor must be run from within a git repository (${cwd} is not inside one)`);
  }
  return result.stdout.trim();
}
