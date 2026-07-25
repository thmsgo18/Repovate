import { checkCisaKev, type CisaKevCatalog } from "./cisa-kev.js";
import { fetchNvdEnrichment } from "./nvd.js";
import type { EnrichedAdvisory, NormalizedAdvisory } from "./types.js";

export interface CorrelationOptions {
  /** Pre-fetched once by the caller (fetchCisaKevCatalog) — cheap to reuse across every advisory in a run. */
  cisaKev?: CisaKevCatalog;
  /** Passed through to fetchNvdEnrichment; omit to use NVD's lower unauthenticated rate limit. */
  nvdApiKey?: string;
}

function targetKey(a: NormalizedAdvisory): string {
  return `${a.ecosystem}:${a.package}:${a.affectedVersion}`;
}

/**
 * Groups advisories that are the same underlying finding reported by more
 * than one discovery source (docs/architecture.md section 4.2.3) — merged
 * only when they share an id/alias *and* target the same package at the
 * same resolved version, so e.g. a direct uuid@9.0.1 and an unrelated
 * transitive uuid@8.3.2 hit by the same GHSA never collapse into one entry
 * (they're different remediation targets even though the finding is the
 * same GHSA id).
 */
function groupByAlias(advisories: NormalizedAdvisory[]): NormalizedAdvisory[][] {
  const n = advisories.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const keyToIndex = new Map<string, number>();
  advisories.forEach((adv, i) => {
    const target = targetKey(adv);
    for (const id of [adv.id, ...adv.aliases]) {
      const key = `${target}::${id}`;
      const existing = keyToIndex.get(key);
      if (existing !== undefined) union(i, existing);
      else keyToIndex.set(key, i);
    }
  });

  const groups = new Map<number, NormalizedAdvisory[]>();
  advisories.forEach((adv, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(adv);
    else groups.set(root, [adv]);
  });
  return [...groups.values()];
}

/** GHSA's summaries tend to be better structured than OSV's raw details text — prefer it as the merged entry's identity when both are present. */
function choosePrimary(group: NormalizedAdvisory[]): NormalizedAdvisory {
  return group.find((a) => a.source === "ghsa") ?? group[0]!;
}

function uniqueAliases(group: NormalizedAdvisory[], primaryId: string): string[] {
  const all = new Set<string>();
  for (const adv of group) {
    all.add(adv.id);
    for (const alias of adv.aliases) all.add(alias);
  }
  all.delete(primaryId);
  return [...all];
}

/**
 * Merges OSV + GHSA results for the same finding, then enriches with CISA
 * KEV (exploitation status) and NVD (reference CVSS) — docs/architecture.md
 * section 4.2.3/4.2.5. NVD is queried once per merged group (sequentially,
 * no batching or backoff — fine for the handful of advisories a typical
 * scheduled scan turns up, but a large backlog would run into NVD's
 * unauthenticated rate limit; not solved here).
 */
export async function correlateAdvisories(
  advisories: NormalizedAdvisory[],
  options: CorrelationOptions = {},
): Promise<EnrichedAdvisory[]> {
  const groups = groupByAlias(advisories);
  const enriched: EnrichedAdvisory[] = [];

  for (const group of groups) {
    const primary = choosePrimary(group);
    const aliases = uniqueAliases(group, primary.id);
    const cveAlias = [primary.id, ...aliases].find((id) => id.startsWith("CVE-"));

    let cvss: number | null = null;
    if (cveAlias) {
      const nvd = await fetchNvdEnrichment(cveAlias, options.nvdApiKey).catch(() => null);
      cvss = nvd?.cvss ?? null;
    }

    let cisaKev: EnrichedAdvisory["cisaKev"] = null;
    if (options.cisaKev) {
      const match = checkCisaKev(options.cisaKev, [primary.id, ...aliases]);
      if (match) {
        cisaKev = {
          dateAdded: match.dateAdded,
          dueDate: match.dueDate,
          knownRansomwareCampaignUse: match.knownRansomwareCampaignUse,
        };
      }
    }

    enriched.push({
      ...primary,
      aliases,
      mergedFrom: group.map((a) => `${a.source}:${a.id}`),
      cvss,
      cisaKev,
    });
  }

  return enriched;
}
