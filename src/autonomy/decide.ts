import type { AgentConfig, AutonomyAction, AutonomyRule, Severity, Trigger } from "../config/schema.js";
import type { DiffStats } from "./diff.js";

export interface DecisionInput {
  trigger: Trigger;
  severity: Severity;
  cisaKev: boolean;
  config: AgentConfig;
  diff: DiffStats;
  /** false = the target repo has no detected test suite (attempt.yml's verify job reports this explicitly, distinct from "tests ran and passed"). */
  testsRan: boolean;
  testsPassed: boolean;
}

export interface Decision {
  action: AutonomyAction;
  /** What the config alone would have produced, before any hard rule or condition downgraded it — kept for the PR body / audit trail. */
  configuredAction: AutonomyAction;
  autoMergeEligible: boolean;
  reasons: string[];
}

// docs/architecture.md section 4: "eol_dependency et new_technology ne
// peuvent jamais être auto_merge" — enforced here too (not just at config
// load time via schema.ts's superRefine) so a rule that somehow slips
// through can never fire.
const STRUCTURAL_TRIGGERS = new Set<Trigger>(["eol_dependency", "new_technology"]);

function matchesRule(rule: AutonomyRule, trigger: Trigger, severity: Severity, cisaKev: boolean): boolean {
  if (rule.match.trigger !== trigger) return false;
  if (rule.match.severity && !rule.match.severity.includes(severity)) return false;
  if (typeof rule.match.cisa_kev === "boolean" && rule.match.cisa_kev !== cisaKev) return false;
  return true;
}

function downgrade(action: AutonomyAction, reason: string, reasons: string[]): AutonomyAction {
  reasons.push(reason);
  return action === "auto_merge" ? "pr_only" : action;
}

/**
 * Resolves the final autonomy action for one finding: first the config's
 * own rules (first match wins, else `autonomy.default`), then the rule's
 * own `conditions` (if declared), then the hard rules that no config can
 * override. Never throws — an ineligible auto_merge always degrades to
 * pr_only rather than being dropped, so the finding still gets a PR.
 */
export function decideAutonomy(input: DecisionInput): Decision {
  const rule = input.config.autonomy.rules.find((r) => matchesRule(r, input.trigger, input.severity, input.cisaKev));
  const configuredAction = rule?.action ?? input.config.autonomy.default;
  const reasons: string[] = [
    rule
      ? `matched rule for trigger="${rule.match.trigger}" → ${configuredAction}`
      : `no autonomy rule matched — using default (${configuredAction})`,
  ];

  let action: AutonomyAction = configuredAction;

  if (action === "auto_merge" && rule?.conditions) {
    const { conditions } = rule;
    if (conditions.tests_pass === "required" && !input.testsPassed) {
      action = downgrade(action, "rule condition: tests_pass required but verification did not pass", reasons);
    }
    if (action === "auto_merge" && conditions.max_files_changed !== undefined) {
      if (input.diff.filesChangedExcludingLockfiles > conditions.max_files_changed) {
        action = downgrade(
          action,
          `rule condition: ${input.diff.filesChangedExcludingLockfiles} files changed (excl. lockfiles) exceeds max_files_changed=${conditions.max_files_changed}`,
          reasons,
        );
      }
    }
    if (action === "auto_merge" && conditions.max_lines_changed !== undefined) {
      if (input.diff.linesChangedExcludingLockfiles > conditions.max_lines_changed) {
        action = downgrade(
          action,
          `rule condition: ${input.diff.linesChangedExcludingLockfiles} lines changed (excl. lockfiles) exceeds max_lines_changed=${conditions.max_lines_changed}`,
          reasons,
        );
      }
    }
  }

  if (action === "auto_merge" && STRUCTURAL_TRIGGERS.has(input.trigger)) {
    action = downgrade(action, `hard rule: "${input.trigger}" can never be auto_merge (docs/architecture.md section 4)`, reasons);
  }
  if (action === "auto_merge" && !input.testsRan) {
    action = downgrade(action, "hard rule: no test suite detected in the target repo — autonomy forced to pr_only", reasons);
  }
  if (action === "auto_merge" && !input.testsPassed) {
    action = downgrade(action, "hard rule: verification did not pass after retries — never auto-merge a failing patch", reasons);
  }
  if (action === "auto_merge" && !input.diff.isSimplePatch) {
    action = downgrade(
      action,
      "hard rule: patch touches a source file (not just manifest/lockfile) — not eligible for auto-merge regardless of severity",
      reasons,
    );
  }

  return { action, configuredAction, autoMergeEligible: action === "auto_merge", reasons };
}
