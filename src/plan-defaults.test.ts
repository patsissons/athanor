import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadAppDefaults, loadPlanDefaults, loadTaskDefaults } from "./plan-defaults.js";

describe("plan-defaults loaders", () => {
  let tmp: string;
  let athanor: string;

  beforeEach(async () => {
    tmp = await mkdtemp(resolve(tmpdir(), "athanor-defaults-"));
    athanor = resolve(tmp, ".athanor");
    await mkdir(athanor, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("loadAppDefaults", () => {
    it("returns parsed values when app.yaml is present", async () => {
      await writeFile(
        resolve(athanor, "app.yaml"),
        "id: my-app\ntitle: My App\ndescription: hello\n",
      );

      const result = await loadAppDefaults(tmp);

      expect(result).toMatchObject({ id: "my-app", title: "My App", description: "hello" });
    });

    it("returns an empty object when app.yaml is missing", async () => {
      await expect(loadAppDefaults(tmp)).resolves.toEqual({});
    });

    it("rejects when app.yaml contains invalid types", async () => {
      // `id` must be a string per AppSpecSchema; passing a number must fail validation.
      await writeFile(resolve(athanor, "app.yaml"), "id: 42\ntitle: ok\n");

      await expect(loadAppDefaults(tmp)).rejects.toThrow();
    });
  });

  describe("loadTaskDefaults", () => {
    it("returns parsed values when task.default.yaml is present", async () => {
      await writeFile(
        resolve(athanor, "task.default.yaml"),
        [
          "forbiddenPaths:",
          "  - package.json",
          "gates:",
          "  - name: typecheck",
          "    command: npm run typecheck",
          "model: sonnet",
        ].join("\n"),
      );

      const result = await loadTaskDefaults(tmp);

      expect(result.forbiddenPaths).toEqual(["package.json"]);
      expect(result.gates).toEqual([
        { name: "typecheck", command: "npm run typecheck", maxOutputChars: 4000 },
      ]);
      expect(result.model).toBe("sonnet");
    });

    it("returns schema defaults when task.default.yaml is missing", async () => {
      // TaskSpecSchema declares field-level defaults (e.g. `model: "sonnet"`,
      // empty path arrays) that survive `.partial()`. A missing config file
      // therefore yields these baseline values rather than a bare `{}`.
      const result = await loadTaskDefaults(tmp);

      expect(result).toMatchObject({
        allowedPaths: [],
        forbiddenPaths: [],
        model: "sonnet",
      });
    });
  });

  describe("loadPlanDefaults", () => {
    it("returns parsed values when plan.default.yaml is present", async () => {
      // PlanSpec.partial allows leaving fields off; `name` is a sensible thing to default.
      await writeFile(resolve(athanor, "plan.default.yaml"), "name: A default plan name\n");

      const result = await loadPlanDefaults(tmp);

      expect(result.name).toBe("A default plan name");
    });

    it("returns an empty object when plan.default.yaml is missing", async () => {
      await expect(loadPlanDefaults(tmp)).resolves.toEqual({});
    });
  });
});
