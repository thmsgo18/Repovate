import type { DependencyRef } from "../manifests/types.js";
import type { NormalizedAdvisory, Severity } from "./types.js";

const OSV_API_BASE = "https://api.osv.dev/v1";
// Documented OSV.dev limit on querybatch — chunk defensively rather than
// assume our caller never hands us a large monorepo's full dependency tree.
const BATCH_CHUNK_SIZE = 1000;

interface OsvBatchQuery {
  package: { name: string; ecosystem: string };
  version: string;
}

interface OsvBatchResult {
  vulns?: Array<{ id: string; modified: string }>;
}

interface OsvBatchResponse {
  results: OsvBatchResult[];
}

interface OsvVulnDetail {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  references?: Array<{ type: string; url: string }>;
}

const SEVERITY_MAP: Record<string, Severity> = {
  LOW: "low",
  MODERATE: "medium",
  HIGH: "high",
  CRITICAL: "critical",
};

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function osvFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${OSV_API_BASE}${path}`, init);
  if (!response.ok) {
    throw new Error(`OSV.dev request to ${path} failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/** For each dependency, the set of OSV advisory IDs known to affect the exact queried version. */
async function queryBatch(deps: DependencyRef[]): Promise<string[][]> {
  const results: string[][] = [];
  for (const batch of chunk(deps, BATCH_CHUNK_SIZE)) {
    const queries: OsvBatchQuery[] = batch.map((dep) => ({
      package: { name: dep.name, ecosystem: dep.ecosystem },
      version: dep.version,
    }));
    const response = await osvFetch<OsvBatchResponse>("/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries }),
    });
    results.push(...response.results.map((r) => (r.vulns ?? []).map((v) => v.id)));
  }
  return results;
}

function normalize(detail: OsvVulnDetail, dep: DependencyRef): NormalizedAdvisory {
  const rawSeverity = detail.database_specific?.severity;
  return {
    id: detail.id,
    aliases: detail.aliases ?? [],
    summary: detail.summary ?? detail.details?.slice(0, 200) ?? "",
    severity: rawSeverity ? (SEVERITY_MAP[rawSeverity] ?? null) : null,
    package: dep.name,
    ecosystem: dep.ecosystem,
    affectedVersion: dep.version,
    source: "osv",
    url: detail.references?.find((r) => r.type === "ADVISORY")?.url ?? detail.references?.[0]?.url ?? null,
  };
}

/**
 * Queries OSV.dev for every dependency and returns normalized advisories.
 * Batches the initial query (id-only, per OSV's own design), then fetches
 * full details once per unique advisory id — the same GHSA often affects
 * several dependencies/versions in one repo, no need to re-fetch it.
 */
export async function fetchOsvAdvisories(deps: DependencyRef[]): Promise<NormalizedAdvisory[]> {
  if (deps.length === 0) return [];

  const idsPerDep = await queryBatch(deps);
  const detailCache = new Map<string, Promise<OsvVulnDetail>>();
  const advisories: NormalizedAdvisory[] = [];

  for (let i = 0; i < deps.length; i++) {
    const dep = deps[i];
    const ids = idsPerDep[i];
    if (!dep || !ids) continue;
    for (const id of ids) {
      let detailPromise = detailCache.get(id);
      if (!detailPromise) {
        detailPromise = osvFetch<OsvVulnDetail>(`/vulns/${id}`);
        detailCache.set(id, detailPromise);
      }
      advisories.push(normalize(await detailPromise, dep));
    }
  }

  return advisories;
}
