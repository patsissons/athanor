import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as p from "@clack/prompts";
import { stringify } from "yaml";

export interface InitAnswers {
  appId: string;
  appTitle: string;
  appDescription?: string;
  hasDevServer: boolean;
  devServer?: { command: string; readyPattern: string; port: number };
  gates: Array<{ name: string; command: string }>;
  forbiddenPaths: string[];
}

export interface ScaffoldFile {
  relativePath: string;
  content: string;
}

const YAML_HEADER = "# yaml-language-server: $schema=https://www.schemastore.org/any.json\n";

function toKebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toTitleCase(kebab: string): string {
  return kebab
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function buildScaffold(answers: InitAnswers): ScaffoldFile[] {
  const files: ScaffoldFile[] = [];

  // ── tasks/app.yaml ─────────────────────────────────────────────
  const app: Record<string, unknown> = {
    id: answers.appId,
    title: answers.appTitle,
  };
  if (answers.appDescription) {
    app.description = answers.appDescription;
  }
  if (answers.hasDevServer && answers.devServer) {
    app.devServer = answers.devServer;
  }
  files.push({
    relativePath: "tasks/app.yaml",
    content: YAML_HEADER + stringify(app),
  });

  // ── tasks/task.default.yaml ────────────────────────────────────
  const taskDefault: Record<string, unknown> = {};
  if (answers.forbiddenPaths.length > 0) {
    taskDefault.forbiddenPaths = answers.forbiddenPaths;
  }
  if (answers.gates.length > 0) {
    taskDefault.gates = answers.gates;
  }
  taskDefault.maxAgentAttempts = 2;
  taskDefault.model = "sonnet";
  files.push({
    relativePath: "tasks/task.default.yaml",
    content: YAML_HEADER + stringify(taskDefault),
  });

  // ── tasks/example.yaml ─────────────────────────────────────────
  const example = {
    id: "example-task",
    title: "Example task",
    description:
      "Describe what you want the agent to implement.\n" +
      "Be concrete — include file paths, component names, and expected behavior.\n",
    allowedPaths: ["src/**"],
    acceptanceCriteria: [
      "The feature works as described",
      "No regressions in existing functionality",
    ],
  };
  files.push({
    relativePath: "tasks/example.yaml",
    content: YAML_HEADER + stringify(example),
  });

  return files;
}

function cancelAndExit(value: unknown): asserts value is string | string[] | boolean {
  if (p.isCancel(value)) {
    p.cancel("Init cancelled.");
    process.exit(0);
  }
}

const GATE_OPTIONS = [
  {
    value: { name: "format", command: "npm run format:check" },
    label: "format (npm run format:check)",
  },
  { value: { name: "lint", command: "npm run lint" }, label: "lint (npm run lint)" },
  {
    value: { name: "typecheck", command: "npm run typecheck" },
    label: "typecheck (npm run typecheck)",
  },
  { value: { name: "test", command: "npm test" }, label: "test (npm test)" },
];

const FORBIDDEN_PATH_OPTIONS = [
  { value: "package.json", label: "package.json" },
  { value: "package-lock.json", label: "package-lock.json" },
  { value: "pnpm-lock.yaml", label: "pnpm-lock.yaml" },
  { value: "yarn.lock", label: "yarn.lock" },
  { value: ".env", label: ".env" },
];

export async function runInit(): Promise<void> {
  const cwd = process.cwd();
  const tasksDir = resolve(cwd, "tasks");
  const dirName = basename(cwd);
  const defaultId = toKebab(dirName);
  const defaultTitle = toTitleCase(defaultId);

  p.intro("athanor init");

  // Check for existing tasks/ directory
  if (existsSync(tasksDir)) {
    const overwrite = await p.confirm({
      message: "tasks/ directory already exists. Overwrite files?",
    });
    cancelAndExit(overwrite);
    if (!overwrite) {
      p.cancel("Init cancelled.");
      process.exit(0);
    }
  }

  // ── App identity ───────────────────────────────────────────────
  const appId = await p.text({
    message: "App ID (kebab-case identifier)",
    initialValue: defaultId,
    validate: (v) => {
      if (!v?.trim()) return "App ID is required";
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(v!) && v!.length > 1)
        return "Use kebab-case (e.g. my-app)";
    },
  });
  cancelAndExit(appId);

  const appTitle = await p.text({
    message: "App title",
    initialValue: defaultTitle,
    validate: (v) => {
      if (!v?.trim()) return "App title is required";
    },
  });
  cancelAndExit(appTitle);

  const appDescription = await p.text({
    message: "App description (optional, press Enter to skip)",
    initialValue: "",
  });
  cancelAndExit(appDescription);

  // ── Dev server ─────────────────────────────────────────────────
  const hasDevServer = await p.confirm({
    message: "Does this project have a dev server? (enables interactive Playwright evaluation)",
    initialValue: false,
  });
  cancelAndExit(hasDevServer);

  let devServer: InitAnswers["devServer"] | undefined;
  if (hasDevServer) {
    const devCommand = await p.text({
      message: "Dev server command",
      initialValue: "npm run dev",
      validate: (v) => {
        if (!v?.trim()) return "Command is required";
      },
    });
    cancelAndExit(devCommand);

    const readyPattern = await p.text({
      message: "Ready pattern (string in stdout that signals the server is ready)",
      initialValue: "ready on",
      validate: (v) => {
        if (!v?.trim()) return "Ready pattern is required";
      },
    });
    cancelAndExit(readyPattern);

    const portStr = await p.text({
      message: "Dev server port",
      initialValue: "3000",
      validate: (v) => {
        if (!v) return "Port is required";
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) return "Port must be a positive integer";
      },
    });
    cancelAndExit(portStr);

    devServer = {
      command: devCommand,
      readyPattern,
      port: Number(portStr),
    };
  }

  // ── Gates ──────────────────────────────────────────────────────
  const gates = await p.multiselect({
    message: "Validation gates (applied to every task by default)",
    options: GATE_OPTIONS,
    initialValues: GATE_OPTIONS.map((o) => o.value),
  });
  cancelAndExit(gates);

  // ── Forbidden paths ────────────────────────────────────────────
  const forbiddenPaths = await p.multiselect({
    message: "Forbidden paths (agents cannot modify these files)",
    options: FORBIDDEN_PATH_OPTIONS,
    initialValues: ["package.json", "package-lock.json"],
  });
  cancelAndExit(forbiddenPaths);

  // ── Build and write ────────────────────────────────────────────
  const answers: InitAnswers = {
    appId,
    appTitle,
    appDescription: appDescription || undefined,
    hasDevServer,
    devServer,
    gates: gates as Array<{ name: string; command: string }>,
    forbiddenPaths: forbiddenPaths as string[],
  };

  const files = buildScaffold(answers);

  const s = p.spinner();
  s.start("Writing scaffold files...");
  await mkdir(tasksDir, { recursive: true });
  for (const f of files) {
    await writeFile(resolve(cwd, f.relativePath), f.content, "utf8");
  }
  s.stop("Files written.");

  p.note(files.map((f) => `  ${f.relativePath}`).join("\n"), "Created files");

  p.outro(
    "Scaffolding complete! Edit tasks/example.yaml to define your first task, then run:\n" +
      "  athanor run tasks/example.yaml",
  );
}
