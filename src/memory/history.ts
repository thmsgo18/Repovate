import { readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readJsonFile, writeJsonFile } from "./json-file.js";
import { historyDir, historyEntryPath } from "./paths.js";

export const historyStatusSchema = z.enum([
  "detected",
  "pr_open",
  "merged",
  "auto_merged",
  "merge_blocked_by_branch_protection",
  "tests_failed_draft",
  "ignored",
  "wontfix",
]);

export const historyEventSchema = z.object({
  at: z.string().datetime(),
  event: z.string(),
});

export const historyEntrySchema = z.object({
  id: z.string(),
  aliases: z.array(z.string()).default([]),
  package: z.string(),
  ecosystem: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  cvss: z.number().nullable().default(null),
  cisa_kev: z.boolean().default(false),
  status: historyStatusSchema,
  pr_url: z.string().nullable().default(null),
  pr_draft: z.boolean().default(false),
  autonomy_applied: z.enum(["auto_merge", "pr_only", "branch_only"]),
  patch_attempts: z.number().int().min(0).default(0),
  history: z.array(historyEventSchema).default([]),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type HistoryStatus = z.infer<typeof historyStatusSchema>;

export async function readHistoryEntry(repoRoot: string, id: string): Promise<HistoryEntry | null> {
  return readJsonFile(historyEntryPath(repoRoot, id), historyEntrySchema);
}

export async function writeHistoryEntry(repoRoot: string, entry: HistoryEntry): Promise<void> {
  await writeJsonFile(historyEntryPath(repoRoot, entry.id), historyEntrySchema, entry);
}

export async function listHistoryEntries(repoRoot: string): Promise<HistoryEntry[]> {
  let files: string[];
  try {
    files = await readdir(historyDir(repoRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJsonFile(path.join(historyDir(repoRoot), file), historyEntrySchema)),
  );
  // Each file was just listed by readdir, so a null (ENOENT) read here would
  // only happen from a concurrent delete — safe to drop rather than crash.
  return entries.filter((entry): entry is HistoryEntry => entry !== null);
}

/**
 * Dedup check for the veille cron (docs/architecture.md section 4.2.6 / 6):
 * an entry still in "detected" status was deferred by the per-run PR cap
 * and must be picked up again — only a status past "detected" means skip.
 */
export async function hasBeenHandled(repoRoot: string, id: string): Promise<boolean> {
  const entry = await readHistoryEntry(repoRoot, id);
  if (!entry) return false;
  return entry.status !== "detected";
}
