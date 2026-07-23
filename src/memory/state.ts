import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-file.js";
import { statePath } from "./paths.js";

export const stateSchema = z.object({
  last_run: z.record(z.string(), z.string()).default({}),
  // Excludes commits authored by the agent itself (heartbeat, its own PR
  // merges) — see docs/architecture.md section 9. That filtering happens
  // where this field is written, not here.
  last_human_commit_seen: z.string().nullable().default(null),
  commits_since_last_onboarding_refresh: z.number().int().min(0).default(0),
  kill_switch: z.boolean().default(false),
});

export type AgentState = z.infer<typeof stateSchema>;

export function defaultState(): AgentState {
  return stateSchema.parse({});
}

/** Returns schema defaults if no state has been persisted yet — a fresh repo is never "broken", just unstarted. */
export async function readState(repoRoot: string): Promise<AgentState> {
  const state = await readJsonFile(statePath(repoRoot), stateSchema);
  return state ?? defaultState();
}

export async function writeState(repoRoot: string, data: AgentState): Promise<void> {
  await writeJsonFile(statePath(repoRoot), stateSchema, data);
}
