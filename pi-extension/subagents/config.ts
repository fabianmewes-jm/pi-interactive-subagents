import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TEAM_THREAD_CAP } from "./team.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const EXAMPLE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json.example");

export interface TeamConfig {
  maxThreads: number;
}

export function parseTeamConfig(raw: unknown, source = "config.json"): TeamConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid subagent config in ${source}: root must be an object`);
  }
  const team = (raw as Record<string, unknown>).team;
  if (team === undefined) return { maxThreads: DEFAULT_TEAM_THREAD_CAP };
  if (team == null || typeof team !== "object" || Array.isArray(team)) {
    throw new Error(`Invalid subagent config in ${source}: team must be an object`);
  }
  const values = team as Record<string, unknown>;
  const unsupported = Object.keys(values).filter((key) => key !== "maxThreads");
  if (unsupported.length > 0) {
    throw new Error(`Invalid subagent config in ${source}: team has unsupported key(s): ${unsupported.join(", ")}`);
  }
  const maxThreads = values.maxThreads;
  if (typeof maxThreads !== "number" || !Number.isSafeInteger(maxThreads) || maxThreads < 1) {
    throw new Error(`Invalid subagent config in ${source}: team.maxThreads must be a positive integer`);
  }
  return { maxThreads };
}

export function loadTeamConfig(
  configPath = DEFAULT_CONFIG_PATH,
  examplePath = EXAMPLE_CONFIG_PATH,
): TeamConfig {
  let source = configPath;
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    source = examplePath;
    text = readFileSync(examplePath, "utf8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in subagent config ${source}: ${(error as Error).message}`);
  }
  return parseTeamConfig(raw, source);
}
