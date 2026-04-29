import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildScaffold, type InitAnswers } from "./init.js";
import { AppSpecSchema } from "./app-spec.js";
import { TaskSpecSchema } from "./task-spec.js";

function fullAnswers(): InitAnswers {
  return {
    appId: "my-app",
    appTitle: "My App",
    appDescription: "A Next.js application.",
    hasDevServer: true,
    devServer: { command: "npm run dev", readyPattern: "ready on", port: 3000 },
    gates: [
      { name: "typecheck", command: "npm run typecheck" },
      { name: "lint", command: "npm run lint" },
    ],
    forbiddenPaths: ["package.json", "package-lock.json"],
  };
}

function minimalAnswers(): InitAnswers {
  return {
    appId: "simple",
    appTitle: "Simple",
    hasDevServer: false,
    gates: [],
    forbiddenPaths: [],
  };
}

describe("buildScaffold", () => {
  it("produces three files with correct paths", () => {
    const files = buildScaffold(fullAnswers());

    expect(files).toHaveLength(3);
    expect(files.map((f) => f.relativePath)).toEqual([
      ".athanor/app.yaml",
      ".athanor/task.default.yaml",
      ".athanor/tasks/example.yaml",
    ]);
  });

  it("generates valid app.yaml with all fields", () => {
    const files = buildScaffold(fullAnswers());
    const appFile = files.find((f) => f.relativePath === ".athanor/app.yaml")!;
    const parsed = parse(appFile.content);
    const result = AppSpecSchema.parse(parsed);

    expect(result.id).toBe("my-app");
    expect(result.title).toBe("My App");
    expect(result.description).toBe("A Next.js application.");
    expect(result.devServer).toEqual({
      command: "npm run dev",
      readyPattern: "ready on",
      port: 3000,
      timeoutMs: 30000,
    });
  });

  it("generates valid app.yaml without optional fields", () => {
    const files = buildScaffold(minimalAnswers());
    const appFile = files.find((f) => f.relativePath === ".athanor/app.yaml")!;
    const parsed = parse(appFile.content);
    const result = AppSpecSchema.parse(parsed);

    expect(result.id).toBe("simple");
    expect(result.title).toBe("Simple");
    expect(result.description).toBeUndefined();
    expect(result.devServer).toBeUndefined();
  });

  it("generates task.default.yaml with gates and forbidden paths", () => {
    const files = buildScaffold(fullAnswers());
    const defaultFile = files.find((f) => f.relativePath === ".athanor/task.default.yaml")!;
    const parsed = parse(defaultFile.content);

    expect(parsed.gates).toEqual([
      { name: "typecheck", command: "npm run typecheck" },
      { name: "lint", command: "npm run lint" },
    ]);
    expect(parsed.forbiddenPaths).toEqual(["package.json", "package-lock.json"]);
    expect(parsed.maxAgentAttempts).toBe(2);
    expect(parsed.model).toBe("sonnet");
  });

  it("generates task.default.yaml without gates when none selected", () => {
    const files = buildScaffold(minimalAnswers());
    const defaultFile = files.find((f) => f.relativePath === ".athanor/task.default.yaml")!;
    const parsed = parse(defaultFile.content);

    expect(parsed.gates).toBeUndefined();
    expect(parsed.forbiddenPaths).toBeUndefined();
    expect(parsed.maxAgentAttempts).toBe(2);
    expect(parsed.model).toBe("sonnet");
  });

  it("generates example.yaml with expected structure", () => {
    const files = buildScaffold(fullAnswers());
    const exampleFile = files.find((f) => f.relativePath === ".athanor/tasks/example.yaml")!;
    const parsed = parse(exampleFile.content);

    expect(parsed.id).toBe("example-task");
    expect(parsed.title).toBe("Example task");
    expect(parsed.description).toBeDefined();
    expect(parsed.allowedPaths).toEqual(["src/**"]);
    expect(parsed.acceptanceCriteria).toHaveLength(2);
  });

  it("example.yaml parses against partial TaskSpecSchema", () => {
    const files = buildScaffold(fullAnswers());
    const exampleFile = files.find((f) => f.relativePath === ".athanor/tasks/example.yaml")!;
    const parsed = parse(exampleFile.content);

    // Example doesn't have gates (they come from task defaults), so parse as partial
    expect(() => TaskSpecSchema.partial().parse(parsed)).not.toThrow();
  });

  it("prepends yaml-language-server header to all files", () => {
    const files = buildScaffold(fullAnswers());

    for (const f of files) {
      expect(f.content).toMatch(/^# yaml-language-server/);
    }
  });

  it("omits devServer from app.yaml when hasDevServer is false", () => {
    const answers = { ...fullAnswers(), hasDevServer: false, devServer: undefined };
    const files = buildScaffold(answers);
    const appFile = files.find((f) => f.relativePath === ".athanor/app.yaml")!;
    const parsed = parse(appFile.content);

    expect(parsed.devServer).toBeUndefined();
  });
});
