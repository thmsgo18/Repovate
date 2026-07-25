export type Severity = "critical" | "high" | "medium" | "low";

/** A vulnerability as reported by a single discovery source (docs/architecture.md section 6: OSV, GHSA). */
export interface NormalizedAdvisory {
  id: string;
  aliases: string[];
  summary: string;
  severity: Severity | null;
  package: string;
  ecosystem: string;
  /** The exact version that was queried and found affected. */
  affectedVersion: string;
  source: "osv" | "ghsa";
  url: string | null;
}

/**
 * A discovery-source advisory enriched with data from the enrichment
 * sources (CISA KEV, NVD) — docs/architecture.md section 4.2.3/4.2.5. Built
 * by the correlation step, never returned directly by a source client.
 */
export interface EnrichedAdvisory extends NormalizedAdvisory {
  /** IDs of every discovery-source entry that reported this same advisory (deduped by alias). */
  mergedFrom: string[];
  /** Reference CVSS score from NVD, if found. Null if NVD had nothing or wasn't queried. */
  cvss: number | null;
  /** Non-null exactly when this advisory is in the CISA Known Exploited Vulnerabilities catalog. */
  cisaKev: { dateAdded: string; dueDate: string; knownRansomwareCampaignUse: boolean } | null;
}
