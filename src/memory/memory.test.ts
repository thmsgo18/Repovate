import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOnboarding, writeOnboarding, type Onboarding } from "./onboarding.js";
import { defaultState, readState, writeState } from "./state.js";
import { hasBeenHandled, listHistoryEntries, readHistoryEntry, writeHistoryEntry, type HistoryEntry } from "./history.js";
import { historyEntryPath } from "./paths.js";

describe("memory module (.agent/)", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "repovate-memory-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  describe("onboarding.json", () => {
    it("returns null when no onboarding has run yet", async () => {
      expect(await readOnboarding(repoRoot)).toBeNull();
    });

    it("round-trips a full onboarding summary", async () => {
      const onboarding: Onboarding = {
        generated_at: "2026-06-01T08:00:00Z",
        agent_version: "0.1.0",
        languages: ["typescript"],
        frameworks: ["express"],
        architecture_summary: "API Express...",
        entry_points: ["src/server.ts"],
        code_conventions: "ESLint airbnb-base",
        test_suite: { present: true, framework: "vitest", command: "npm test", coverage_estimate: "partiel" },
        manifests_detected: ["package.json"],
        last_refresh_reason: null,
      };
      await writeOnboarding(repoRoot, onboarding);
      expect(await readOnboarding(repoRoot)).toEqual(onboarding);
    });
  });

  describe("state.json", () => {
    it("returns schema defaults when no state has been persisted", async () => {
      expect(await readState(repoRoot)).toEqual(defaultState());
    });

    it("round-trips state and excludes nothing the caller wrote", async () => {
      const state = {
        last_run: { osv: "2026-07-23T06:00:00Z" },
        last_human_commit_seen: "a1b2c3d",
        commits_since_last_onboarding_refresh: 4,
        kill_switch: false,
      };
      await writeState(repoRoot, state);
      expect(await readState(repoRoot)).toEqual(state);
    });
  });

  describe("history/", () => {
    const entry: HistoryEntry = {
      id: "GHSA-xxxx-xxxx-xxxx",
      aliases: ["CVE-2026-12345"],
      package: "lodash",
      ecosystem: "npm",
      severity: "high",
      cvss: 7.5,
      cisa_kev: false,
      status: "pr_open",
      pr_url: "https://github.com/user/repo/pull/42",
      pr_draft: false,
      autonomy_applied: "pr_only",
      patch_attempts: 1,
      history: [{ at: "2026-07-20T06:00:00Z", event: "detected" }],
    };

    it("returns null for an advisory never seen before", async () => {
      expect(await readHistoryEntry(repoRoot, "GHSA-never-seen-here")).toBeNull();
    });

    it("round-trips a history entry to its own file", async () => {
      await writeHistoryEntry(repoRoot, entry);
      expect(await readHistoryEntry(repoRoot, entry.id)).toEqual(entry);
    });

    it("lists all persisted entries", async () => {
      await writeHistoryEntry(repoRoot, entry);
      await writeHistoryEntry(repoRoot, { ...entry, id: "CVE-2026-99999", status: "merged" });
      const entries = await listHistoryEntries(repoRoot);
      expect(entries.map((e) => e.id).sort()).toEqual(["CVE-2026-99999", "GHSA-xxxx-xxxx-xxxx"]);
    });

    it("returns an empty list when history/ does not exist yet", async () => {
      expect(await listHistoryEntries(repoRoot)).toEqual([]);
    });

    it("treats an undetected advisory as not handled", async () => {
      expect(await hasBeenHandled(repoRoot, entry.id)).toBe(false);
    });

    it("treats a 'detected' entry as not handled — it must be retried, not skipped (per-run PR cap deferral)", async () => {
      await writeHistoryEntry(repoRoot, { ...entry, status: "detected" });
      expect(await hasBeenHandled(repoRoot, entry.id)).toBe(false);
    });

    it("treats any status past 'detected' as handled", async () => {
      await writeHistoryEntry(repoRoot, entry); // status: pr_open
      expect(await hasBeenHandled(repoRoot, entry.id)).toBe(true);
    });

    it("rejects advisory ids that would escape the history directory", async () => {
      expect(() => historyEntryPath(repoRoot, "../../etc/passwd")).toThrow();
    });
  });
});
