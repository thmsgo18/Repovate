import semver from "semver";
import type { DependencyRef } from "../manifests/types.js";
import type { NormalizedAdvisory, Severity } from "./types.js";

const GRAPHQL_URL = "https://api.github.com/graphql";
const REST_BASE = "https://api.github.com";

const SEVERITY_MAP: Record<string, Severity> = {
  LOW: "low",
  MODERATE: "medium",
  HIGH: "high",
  CRITICAL: "critical",
};

const ECOSYSTEM_MAP: Record<string, string> = {
  npm: "NPM",
};

interface GhsaAdvisoryNode {
  advisory: {
    ghsaId: string;
    summary: string;
    severity: string;
    identifiers: Array<{ type: string; value: string }>;
    references: Array<{ url: string }>;
  };
  vulnerableVersionRange: string;
  firstPatchedVersion: { identifier: string } | null;
}

interface GraphQlResponse {
  data?: { securityVulnerabilities: { nodes: GhsaAdvisoryNode[] } };
  errors?: Array<{ message: string }>;
}

async function queryGhsaForPackage(dep: DependencyRef, githubToken: string): Promise<GhsaAdvisoryNode[]> {
  const ecosystem = ECOSYSTEM_MAP[dep.ecosystem];
  if (!ecosystem) return [];

  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: `bearer ${githubToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: `query($ecosystem: SecurityAdvisoryEcosystem!, $package: String!) {
        securityVulnerabilities(ecosystem: $ecosystem, package: $package, first: 100) {
          nodes {
            advisory {
              ghsaId
              summary
              severity
              identifiers { type value }
              references { url }
            }
            vulnerableVersionRange
            firstPatchedVersion { identifier }
          }
        }
      }`,
      variables: { ecosystem, package: dep.name },
    }),
  });

  if (!response.ok) {
    throw new Error(`GHSA GraphQL request failed for ${dep.name}: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as GraphQlResponse;
  if (body.errors?.length) {
    throw new Error(`GHSA GraphQL error for ${dep.name}: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data?.securityVulnerabilities.nodes ?? [];
}

/** GHSA's range is comma-separated (">= 1.0.0, < 2.0.0") — semver wants space-separated AND clauses. */
function versionIsAffected(version: string, range: string): boolean {
  const normalized = range.replace(/,/g, " ");
  try {
    return semver.satisfies(version, normalized, { includePrerelease: true });
  } catch {
    // A range string semver can't parse — err toward reporting the advisory
    // rather than silently dropping a possible match.
    return true;
  }
}

function normalize(node: GhsaAdvisoryNode, dep: DependencyRef): NormalizedAdvisory {
  return {
    id: node.advisory.ghsaId,
    aliases: node.advisory.identifiers.filter((i) => i.type === "CVE").map((i) => i.value),
    summary: node.advisory.summary,
    severity: SEVERITY_MAP[node.advisory.severity] ?? null,
    package: dep.name,
    ecosystem: dep.ecosystem,
    affectedVersion: dep.version,
    source: "ghsa",
    url: node.advisory.references[0]?.url ?? `https://github.com/advisories/${node.advisory.ghsaId}`,
  };
}

/**
 * Discovery source (docs/architecture.md section 6), like OSV — queried
 * per dependency since securityVulnerabilities doesn't accept an exact
 * version server-side; version matching happens locally against each
 * result's vulnerableVersionRange.
 */
export async function fetchGhsaAdvisories(deps: DependencyRef[], githubToken: string): Promise<NormalizedAdvisory[]> {
  const advisories: NormalizedAdvisory[] = [];
  for (const dep of deps) {
    const nodes = await queryGhsaForPackage(dep, githubToken);
    for (const node of nodes) {
      if (versionIsAffected(dep.version, node.vulnerableVersionRange)) {
        advisories.push(normalize(node, dep));
      }
    }
  }
  return advisories;
}

interface PullRequestSummary {
  number: number;
  title: string;
  html_url: string;
  head: { ref: string };
  user: { login: string } | null;
}

/**
 * docs/architecture.md section 4.2.7: before acting on a CVE, check whether
 * dependabot[bot] already has an open PR touching the same package — skip
 * if so rather than opening a competing PR.
 */
export async function findDependabotPr(
  owner: string,
  repo: string,
  packageName: string,
  githubToken: string,
): Promise<PullRequestSummary | null> {
  const response = await fetch(`${REST_BASE}/repos/${owner}/${repo}/pulls?state=open&per_page=100`, {
    headers: {
      authorization: `bearer ${githubToken}`,
      accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub pulls request failed for ${owner}/${repo}: ${response.status} ${response.statusText}`);
  }
  const pulls = (await response.json()) as PullRequestSummary[];
  const needle = packageName.toLowerCase();
  return (
    pulls.find(
      (pr) =>
        pr.user?.login === "dependabot[bot]" &&
        (pr.title.toLowerCase().includes(needle) || pr.head.ref.toLowerCase().includes(needle)),
    ) ?? null
  );
}
