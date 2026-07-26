import type { DependencyRef, Ecosystem } from "../manifests/types.js";

const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
const PYPI_BASE = "https://pypi.org/pypi";
const GITHUB_API_BASE = "https://api.github.com";
const DEFAULT_STALE_MONTHS = 18;

export type EolSignalType = "deprecated_flag" | "stale_release" | "archived_upstream";

export interface EolSignal {
  type: EolSignalType;
  detail: string;
}

export interface EolAssessment {
  package: string;
  ecosystem: Ecosystem;
  signals: EolSignal[];
  /** True only once at least 2 independent signals agree — docs/architecture.md section 7.1: "aucune de ces heuristiques n'est fiable seule". */
  isLikelyEol: boolean;
}

interface RegistryInfo {
  /** The registry's own deprecation message, if any (npm's explicit flag; PyPI has no equivalent field, only a classifier — see fetchPyPiPackageInfo). */
  deprecated: string | null;
  lastReleaseDate: string | null;
  repositoryUrl: string | null;
}

function monthsSince(isoDate: string): number {
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) return 0;
  return (Date.now() - then) / (1000 * 60 * 60 * 24 * 30.44);
}

interface NpmVersionInfo {
  deprecated?: string;
  repository?: { url?: string } | string;
}

interface NpmPackageMetadata {
  "dist-tags"?: { latest?: string };
  time?: Record<string, string>;
  versions?: Record<string, NpmVersionInfo>;
  repository?: { url?: string } | string;
}

function repoFieldToUrl(field: { url?: string } | string | undefined): string | null {
  if (!field) return null;
  return typeof field === "string" ? field : (field.url ?? null);
}

/** Returns null for a package the registry has no record of (404) — a normal, expected case, not an error. */
export async function fetchNpmPackageInfo(packageName: string): Promise<RegistryInfo | null> {
  const response = await fetch(`${NPM_REGISTRY_BASE}/${encodeURIComponent(packageName)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`npm registry request failed for ${packageName}: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as NpmPackageMetadata;
  const latest = data["dist-tags"]?.latest;
  if (!latest) return null;
  const latestVersionInfo = data.versions?.[latest];

  return {
    deprecated: latestVersionInfo?.deprecated ?? null,
    lastReleaseDate: data.time?.[latest] ?? null,
    repositoryUrl: repoFieldToUrl(latestVersionInfo?.repository) ?? repoFieldToUrl(data.repository),
  };
}

interface PyPiPackageMetadata {
  info?: {
    classifiers?: string[];
    project_urls?: Record<string, string> | null;
  };
  urls?: Array<{ upload_time_iso_8601?: string }>;
}

/** PyPI has no explicit "deprecated" field like npm — "Development Status :: 7 - Inactive" is the closest equivalent, a trove classifier maintainers opt into. */
export async function fetchPyPiPackageInfo(packageName: string): Promise<RegistryInfo | null> {
  const response = await fetch(`${PYPI_BASE}/${encodeURIComponent(packageName)}/json`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`PyPI request failed for ${packageName}: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as PyPiPackageMetadata;
  const inactive = (data.info?.classifiers ?? []).some((c) => c.includes("Development Status :: 7"));
  const uploadTimes = (data.urls ?? [])
    .map((u) => u.upload_time_iso_8601)
    .filter((t): t is string => Boolean(t))
    .sort();
  const projectUrls = data.info?.project_urls ?? {};

  return {
    deprecated: inactive ? "PyPI classifier: Development Status :: 7 - Inactive" : null,
    lastReleaseDate: uploadTimes.at(-1) ?? null,
    repositoryUrl: projectUrls.Source ?? projectUrls.Repository ?? projectUrls.Homepage ?? null,
  };
}

/** Parses a repository URL in any of the common forms (git+https://, git://, https://, with or without .git) into owner/repo — null if it's not a GitHub URL. */
export function extractGitHubRepo(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null;
  const match = /github\.com[/:]([^/\s]+)\/([^/\s#]+?)(\.git)?\/?$/.exec(url);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** Returns null when the repo can't be checked (not found, or the request itself failed) rather than treating "unknown" as "not archived". */
export async function checkGitHubArchived(owner: string, repo: string, githubToken?: string): Promise<boolean | null> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (githubToken) headers.authorization = `bearer ${githubToken}`;

  const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub repo request failed for ${owner}/${repo}: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { archived?: boolean };
  return data.archived === true;
}

export interface EolOptions {
  /** Months since the last release before staleness counts as a signal — docs/architecture.md suggests 18-24. */
  staleMonths?: number;
  githubToken?: string;
}

/**
 * Combines registry deprecation flags, release staleness, and upstream
 * GitHub archived status into one verdict — docs/architecture.md section
 * 7.1: no single signal is trusted alone, at least two must agree. A
 * package can be npm-deprecated with a non-archived GitHub repo (or vice
 * versa) in practice — that's exactly why this doesn't act on one signal.
 */
export async function assessEol(dep: DependencyRef, options: EolOptions = {}): Promise<EolAssessment> {
  const staleMonths = options.staleMonths ?? DEFAULT_STALE_MONTHS;
  const signals: EolSignal[] = [];

  const info = dep.ecosystem === "npm" ? await fetchNpmPackageInfo(dep.name) : await fetchPyPiPackageInfo(dep.name);

  if (info?.deprecated) {
    signals.push({ type: "deprecated_flag", detail: info.deprecated });
  }
  if (info?.lastReleaseDate && monthsSince(info.lastReleaseDate) >= staleMonths) {
    signals.push({ type: "stale_release", detail: `Last release ${info.lastReleaseDate}` });
  }

  const repo = extractGitHubRepo(info?.repositoryUrl ?? null);
  if (repo) {
    const archived = await checkGitHubArchived(repo.owner, repo.repo, options.githubToken).catch(() => null);
    if (archived) {
      signals.push({ type: "archived_upstream", detail: `${repo.owner}/${repo.repo} is archived on GitHub` });
    }
  }

  return { package: dep.name, ecosystem: dep.ecosystem, signals, isLikelyEol: signals.length >= 2 };
}
