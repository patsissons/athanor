import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { execa } from "execa";
import { extractSummary, prettyPrintEvent, summarizeToolInput, invokeClaudeCode } from "./agent.js";

vi.mock("execa", () => ({ execa: vi.fn() }));

const mockExeca = vi.mocked(execa);

beforeEach(() => {
  // Silence chalk-formatted console.log during tests. We don't assert on it.
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockExeca.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractSummary", () => {
  it("returns the trimmed summary when <task-summary> is present", () => {
    const text = "noise <task-summary>\n  did the thing\n</task-summary> more noise";
    expect(extractSummary(text)).toBe("did the thing");
  });

  it("returns undefined when input is undefined", () => {
    expect(extractSummary(undefined)).toBeUndefined();
  });

  it("returns undefined when no <task-summary> tag is present", () => {
    expect(extractSummary("just a regular result with no summary block")).toBeUndefined();
  });

  it("captures multi-line summaries", () => {
    const text = "<task-summary>line one\nline two\nline three</task-summary>";
    expect(extractSummary(text)).toBe("line one\nline two\nline three");
  });

  it("returns empty string when summary tag is empty", () => {
    expect(extractSummary("<task-summary></task-summary>")).toBe("");
  });
});

describe("summarizeToolInput", () => {
  it("returns file_path when present", () => {
    expect(summarizeToolInput("Edit", { file_path: "src/foo.ts" })).toBe("src/foo.ts");
  });

  it("falls back to path when file_path is missing", () => {
    expect(summarizeToolInput("Read", { path: "/abs/path" })).toBe("/abs/path");
  });

  it("returns the command string for Bash inputs", () => {
    expect(summarizeToolInput("Bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("truncates long commands at 80 chars and appends an ellipsis", () => {
    const long = "echo " + "x".repeat(120);
    const out = summarizeToolInput("Bash", { command: long });
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBe(83);
  });

  it("quotes pattern for Grep inputs", () => {
    expect(summarizeToolInput("Grep", { pattern: "TODO" })).toBe('"TODO"');
  });

  it("returns empty string when input is null, undefined, or non-object", () => {
    expect(summarizeToolInput("X", null)).toBe("");
    expect(summarizeToolInput("X", undefined)).toBe("");
    expect(summarizeToolInput("X", "string")).toBe("");
  });

  it("returns empty string when no recognized field is present", () => {
    expect(summarizeToolInput("X", { unrelated: 1 })).toBe("");
  });
});

describe("prettyPrintEvent", () => {
  it("returns undefined for blank lines without throwing", () => {
    expect(prettyPrintEvent("")).toBeUndefined();
    expect(prettyPrintEvent("   \n  ")).toBeUndefined();
  });

  it("returns undefined for malformed JSON without throwing", () => {
    expect(() => prettyPrintEvent("not valid json {{{")).not.toThrow();
    expect(prettyPrintEvent("not valid json {{{")).toBeUndefined();
  });

  it("returns undefined for system/init events", () => {
    const evt = JSON.stringify({ type: "system", subtype: "init", session_id: "abc" });
    expect(prettyPrintEvent(evt)).toBeUndefined();
  });

  it("handles assistant text + tool_use blocks without throwing", () => {
    const evt = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I will edit a file." },
          { type: "tool_use", name: "Edit", input: { file_path: "src/foo.ts" } },
        ],
      },
    });
    expect(() => prettyPrintEvent(evt)).not.toThrow();
  });

  it("handles user tool_result events (both ok and error)", () => {
    const ok = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: false }] },
    });
    const err = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true }] },
    });
    expect(() => prettyPrintEvent(ok)).not.toThrow();
    expect(() => prettyPrintEvent(err)).not.toThrow();
  });

  it("returns the collected result on a result event", () => {
    const evt = JSON.stringify({
      type: "result",
      result: "all done",
      num_turns: 4,
      duration_ms: 1234,
    });

    expect(prettyPrintEvent(evt)).toEqual({
      resultText: "all done",
      numTurns: 4,
      durationMs: 1234,
    });
  });

  it("accepts the legacy 'event_type' alias for top-level events", () => {
    const evt = JSON.stringify({
      event_type: "result",
      result: "via legacy alias",
      num_turns: 1,
      duration_ms: 1,
    });

    expect(prettyPrintEvent(evt)?.resultText).toBe("via legacy alias");
  });
});

// ── invokeClaudeCode integration smoke test ────────────────────────
//
// Builds a fake `execa` child whose `stdout` is a PassThrough we feed with
// stream-json lines, and asserts the public return shape plus the MCP
// config file lifecycle (write before, unlink after).

interface FakeChildOpts {
  exitCode: number;
  events: object[];
  delayMs?: number;
}

function makeFakeChild(opts: FakeChildOpts) {
  const stdout = new PassThrough();
  const childPromise = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve) => {
      // Write events on the next tick so the listener inside invokeClaudeCode
      // is attached first, then resolve once all events are consumed.
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

describe("invokeClaudeCode", () => {
  it("returns success=true and parses the summary from the result event", async () => {
    mockExeca.mockReturnValue(
      makeFakeChild({
        exitCode: 0,
        events: [
          { type: "system", subtype: "init", session_id: "s1" },
          {
            type: "result",
            result: "ok <task-summary>shipped it</task-summary>",
            num_turns: 2,
            duration_ms: 50,
          },
        ],
      }) as never,
    );

    const result = await invokeClaudeCode({
      prompt: "hi",
      cwd: process.cwd(),
      model: "sonnet",
    });

    expect(result.success).toBe(true);
    expect(result.summary).toBe("shipped it");
    expect(result.parsed).toEqual({ result: "ok <task-summary>shipped it</task-summary>" });
  });

  it("returns success=false when the child exits non-zero", async () => {
    mockExeca.mockReturnValue(
      makeFakeChild({
        exitCode: 1,
        events: [{ type: "result", result: "failed", num_turns: 1, duration_ms: 10 }],
      }) as never,
    );

    const result = await invokeClaudeCode({
      prompt: "hi",
      cwd: process.cwd(),
      model: "sonnet",
    });

    expect(result.success).toBe(false);
  });

  it("writes the MCP config to a temp file before invocation and unlinks it after", async () => {
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

    const mcpConfig = {
      mcpServers: { foo: { command: "node", args: ["server.js"] } },
    };

    await invokeClaudeCode({
      prompt: "hi",
      cwd: process.cwd(),
      model: "sonnet",
      mcpConfig,
    });

    expect(observedPath).toBeDefined();
    expect(observedContent).toEqual(mcpConfig);
    // Cleanup: file is gone after the call returns.
    expect(existsSync(observedPath!)).toBe(false);
  });
});
