export type Severity = "critical" | "high" | "medium" | "low";

/**
 * A vulnerability normalized from a single source. Only OSV is implemented
 * so far (docs/architecture.md section 6, item 5 of the plan: "un seul
 * écosystème (npm), pas de corrélation multi-source") — cvss/cisaKev stay
 * unset until the GHSA/CISA KEV/NVD enrichment sources land in Phase 3.
 */
export interface NormalizedAdvisory {
  id: string;
  aliases: string[];
  summary: string;
  severity: Severity | null;
  package: string;
  ecosystem: string;
  /** The exact version that was queried and found affected. */
  affectedVersion: string;
  source: "osv";
  url: string | null;
}
