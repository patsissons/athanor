import { execa } from "execa";
import chalk from "chalk";
import type { ValidationGate } from "./task-spec.js";

export interface GateResult {
  name: string;
  passed: boolean;
  exitCode: number;
  output: string; // combined stdout + stderr, tail-truncated
}

export function summarize(r: GateResult): string {
  const tag = r.passed ? chalk.green("PASS") : chalk.red("FAIL");
  return `[${tag}] ${r.name} (exit ${r.exitCode})`;
}

export interface GateCommandResult {
  exitCode: number | null;
  output: string;
}

export type GateCommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<GateCommandResult>;

export function truncateOutput(output: string, maxOutputChars: number): string {
  const trimmed = output.trim();
  if (trimmed.length <= maxOutputChars) {
    return trimmed;
  }

  // Keep the tail; error messages usually live at the end.
  return "...[truncated]...\n" + trimmed.slice(-maxOutputChars);
}

export async function executeGateCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<GateCommandResult> {
  const result = await execa(command, {
    cwd,
    shell: true,
    reject: false,
    timeout: timeoutMs,
    all: true,
  });

  return {
    exitCode: result.exitCode ?? null,
    output: result.all ?? "",
  };
}

export async function runGate(
  gate: ValidationGate,
  cwd: string,
  runCommand: GateCommandRunner = executeGateCommand,
): Promise<GateResult> {
  const result = await runCommand(gate.command, cwd, 5 * 60 * 1000);
  const combined = truncateOutput(result.output, gate.maxOutputChars);

  return {
    name: gate.name,
    passed: result.exitCode === 0,
    exitCode: result.exitCode ?? -1,
    output: combined,
  };
}

export async function runAllGates(
  gates: ValidationGate[],
  cwd: string,
  runCommand: GateCommandRunner = executeGateCommand,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const g of gates) {
    results.push(await runGate(g, cwd, runCommand));
  }
  return results;
}
