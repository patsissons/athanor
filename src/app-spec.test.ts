import { describe, expect, it } from "vitest";
import { AppSpecSchema } from "./app-spec.js";

describe("AppSpecSchema", () => {
  it("parses a valid full spec", () => {
    const result = AppSpecSchema.parse({
      id: "my-app",
      title: "My App",
      description: "A Next.js app.",
      guidelines: ["Use TypeScript.", "Use Tailwind CSS."],
    });
    expect(result.id).toBe("my-app");
    expect(result.title).toBe("My App");
    expect(result.description).toBe("A Next.js app.");
    expect(result.guidelines).toEqual(["Use TypeScript.", "Use Tailwind CSS."]);
  });

  it("parses a minimal spec with only required fields", () => {
    const result = AppSpecSchema.parse({ id: "my-app", title: "My App" });
    expect(result.id).toBe("my-app");
    expect(result.title).toBe("My App");
    expect(result.description).toBeUndefined();
    expect(result.guidelines).toBeUndefined();
  });

  it("rejects a spec missing id", () => {
    expect(() => AppSpecSchema.parse({ title: "My App" })).toThrow();
  });

  it("rejects a spec missing title", () => {
    expect(() => AppSpecSchema.parse({ id: "my-app" })).toThrow();
  });

  it("rejects empty id", () => {
    expect(() => AppSpecSchema.parse({ id: "", title: "My App" })).toThrow();
  });

  it("rejects empty title", () => {
    expect(() => AppSpecSchema.parse({ id: "my-app", title: "" })).toThrow();
  });

  it("parses partial schema for defaults loading", () => {
    const result = AppSpecSchema.partial().parse({
      guidelines: ["Use server components."],
    });
    expect(result.guidelines).toEqual(["Use server components."]);
    expect(result.id).toBeUndefined();
  });

  it("parses empty object as partial", () => {
    const result = AppSpecSchema.partial().parse({});
    expect(result).toEqual({});
  });

  it("parses a spec with devServer", () => {
    const result = AppSpecSchema.parse({
      id: "my-app",
      title: "My App",
      devServer: {
        command: "npm run dev",
        readyPattern: "ready on",
        port: 3000,
      },
    });
    expect(result.devServer).toEqual({
      command: "npm run dev",
      readyPattern: "ready on",
      port: 3000,
      timeoutMs: 30000,
    });
  });

  it("parses a spec without devServer", () => {
    const result = AppSpecSchema.parse({ id: "my-app", title: "My App" });
    expect(result.devServer).toBeUndefined();
  });
});
