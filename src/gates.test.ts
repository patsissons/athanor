import { describe, expect, it } from "vitest";
import { runAllGates, runGate, truncateOutput } from "./gates.js";

describe("truncateOutput", () => {
  it("keeps short output intact", () => {
    expect(truncateOutput("hello", 10)).toBe("hello");
  });

  it("keeps the tail of long output", () => {
    expect(truncateOutput("abcdefghij", 4)).toBe("...[truncated]...\nghij");
  });
});

describe("runGate", () => {
  it("builds a failing gate result with truncated output", async () => {
    const result = await runGate(
      { name: "test", command: "npm test", maxOutputChars: 5 },
      "/tmp/project",
      async () => ({
        exitCode: 1,
        output: "0123456789",
      }),
    );

    expect(result).toEqual({
      name: "test",
      passed: false,
      exitCode: 1,
      output: "...[truncated]...\n56789",
    });
  });
});

describe("runAllGates", () => {
  it("runs gates sequentially in definition order", async () => {
    const calls: string[] = [];

    const results = await runAllGates(
      [
        { name: "format", command: "npm run format:check", maxOutputChars: 100 },
        { name: "typecheck", command: "npm run typecheck", maxOutputChars: 100 },
      ],
      "/tmp/project",
      async (command) => {
        calls.push(command);
        return {
          exitCode: 0,
          output: `${command} ok`,
        };
      },
    );

    expect(calls).toEqual(["npm run format:check", "npm run typecheck"]);
    expect(results.map((result) => result.name)).toEqual(["format", "typecheck"]);
  });
});
