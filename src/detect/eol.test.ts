import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DependencyRef } from "../manifests/types.js";
import { assessEol, checkGitHubArchived, extractGitHubRepo, fetchNpmPackageInfo, fetchPyPiPackageInfo } from "./eol.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, statusText: ok ? "OK" : "Error", json: async () => body } as unknown as Response;
}

function notFound(): Response {
  return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) } as unknown as Response;
}

function dep(overrides: Partial<DependencyRef> = {}): DependencyRef {
  return { name: "left-pad", version: "1.0.0", ecosystem: "npm", direct: true, manifestPath: "package.json", ...overrides };
}

describe("extractGitHubRepo", () => {
  it("parses common repository URL forms", () => {
    expect(extractGitHubRepo("git+https://github.com/request/request.git")).toEqual({ owner: "request", repo: "request" });
    expect(extractGitHubRepo("https://github.com/expressjs/express")).toEqual({ owner: "expressjs", repo: "express" });
    expect(extractGitHubRepo("git://github.com/foo/bar.git")).toEqual({ owner: "foo", repo: "bar" });
  });

  it("returns null for a non-GitHub URL or missing value", () => {
    expect(extractGitHubRepo("https://gitlab.com/foo/bar")).toBeNull();
    expect(extractGitHubRepo(null)).toBeNull();
  });
});

describe("fetchNpmPackageInfo", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("extracts deprecated flag, last release date, and repository url from the latest version", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        "dist-tags": { latest: "2.88.2" },
        time: { "2.88.2": "2020-02-11T16:35:36.122Z" },
        versions: {
          "2.88.2": {
            deprecated: "request has been deprecated",
            repository: { url: "git+https://github.com/request/request.git" },
          },
        },
      }),
    );

    const info = await fetchNpmPackageInfo("request");

    expect(info).toEqual({
      deprecated: "request has been deprecated",
      lastReleaseDate: "2020-02-11T16:35:36.122Z",
      repositoryUrl: "git+https://github.com/request/request.git",
    });
  });

  it("returns null (not an error) for a package the registry doesn't know", async () => {
    fetchMock.mockResolvedValueOnce(notFound());
    expect(await fetchNpmPackageInfo("this-package-does-not-exist")).toBeNull();
  });
});

describe("fetchPyPiPackageInfo", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("derives 'deprecated' from the Development Status :: 7 - Inactive classifier", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        info: {
          classifiers: ["Development Status :: 7 - Inactive"],
          project_urls: { Source: "https://github.com/foo/bar" },
        },
        urls: [{ upload_time_iso_8601: "2019-01-01T00:00:00Z" }, { upload_time_iso_8601: "2019-06-01T00:00:00Z" }],
      }),
    );

    const info = await fetchPyPiPackageInfo("some-old-package");

    expect(info?.deprecated).toBe("PyPI classifier: Development Status :: 7 - Inactive");
    expect(info?.lastReleaseDate).toBe("2019-06-01T00:00:00Z"); // the later of the two upload times
    expect(info?.repositoryUrl).toBe("https://github.com/foo/bar");
  });

  it("reports no deprecation for an actively-classified package", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ info: { classifiers: ["Development Status :: 5 - Production/Stable"], project_urls: {} }, urls: [] }),
    );
    const info = await fetchPyPiPackageInfo("django");
    expect(info?.deprecated).toBeNull();
  });
});

describe("checkGitHubArchived", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns true for an archived repo, false for an active one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ archived: true }));
    expect(await checkGitHubArchived("o", "archived-repo")).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({ archived: false }));
    expect(await checkGitHubArchived("o", "active-repo")).toBe(false);
  });

  it("returns null for a repo that no longer exists", async () => {
    fetchMock.mockResolvedValueOnce(notFound());
    expect(await checkGitHubArchived("o", "gone")).toBeNull();
  });
});

describe("assessEol", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("does NOT flag EOL on a single signal alone (deprecated but not archived — the real 'request' package's actual situation)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": { latest: "2.88.2" },
          time: { "2.88.2": new Date().toISOString() }, // recent — no staleness signal
          versions: { "2.88.2": { deprecated: "deprecated", repository: { url: "https://github.com/request/request" } } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ archived: false }));

    const result = await assessEol(dep({ name: "request" }));

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.type).toBe("deprecated_flag");
    expect(result.isLikelyEol).toBe(false);
  });

  it("flags EOL once deprecated + archived agree (two independent signals)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": { latest: "1.0.0" },
          time: { "1.0.0": new Date().toISOString() },
          versions: { "1.0.0": { deprecated: "deprecated", repository: { url: "https://github.com/o/abandoned" } } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ archived: true }));

    const result = await assessEol(dep({ name: "abandoned-pkg" }));

    expect(result.signals.map((s) => s.type).sort()).toEqual(["archived_upstream", "deprecated_flag"]);
    expect(result.isLikelyEol).toBe(true);
  });

  it("flags EOL on staleness + archived even with no explicit deprecated flag", async () => {
    const oldDate = new Date();
    oldDate.setMonth(oldDate.getMonth() - 30);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": { latest: "1.0.0" },
          time: { "1.0.0": oldDate.toISOString() },
          versions: { "1.0.0": { repository: { url: "https://github.com/o/stale" } } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ archived: true }));

    const result = await assessEol(dep({ name: "stale-pkg" }));

    expect(result.signals.map((s) => s.type).sort()).toEqual(["archived_upstream", "stale_release"]);
    expect(result.isLikelyEol).toBe(true);
  });

  it("does not flag EOL from staleness alone", async () => {
    const oldDate = new Date();
    oldDate.setMonth(oldDate.getMonth() - 30);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        "dist-tags": { latest: "1.0.0" },
        time: { "1.0.0": oldDate.toISOString() },
        versions: { "1.0.0": {} },
      }),
    );

    const result = await assessEol(dep({ name: "just-old-no-repo" }));

    expect(result.signals).toHaveLength(1);
    expect(result.isLikelyEol).toBe(false);
  });

  it("respects a custom staleMonths threshold", async () => {
    const nineMonthsAgo = new Date();
    nineMonthsAgo.setMonth(nineMonthsAgo.getMonth() - 9);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": { latest: "1.0.0" },
          time: { "1.0.0": nineMonthsAgo.toISOString() },
          versions: { "1.0.0": { deprecated: "x", repository: { url: "https://github.com/o/r" } } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ archived: false }));

    const strict = await assessEol(dep({ name: "pkg" }), { staleMonths: 6 });
    expect(strict.signals.map((s) => s.type)).toContain("stale_release");

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": { latest: "1.0.0" },
          time: { "1.0.0": nineMonthsAgo.toISOString() },
          versions: { "1.0.0": { deprecated: "x", repository: { url: "https://github.com/o/r" } } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ archived: false }));

    const lenient = await assessEol(dep({ name: "pkg" }), { staleMonths: 24 });
    expect(lenient.signals.map((s) => s.type)).not.toContain("stale_release");
  });

  it("degrades gracefully when the GitHub archived check itself fails", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          "dist-tags": { latest: "1.0.0" },
          time: { "1.0.0": new Date().toISOString() },
          versions: { "1.0.0": { deprecated: "x", repository: { url: "https://github.com/o/r" } } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({}, false, 500));

    const result = await assessEol(dep({ name: "pkg" }));

    expect(result.signals.map((s) => s.type)).toEqual(["deprecated_flag"]);
    expect(result.isLikelyEol).toBe(false);
  });

  it("returns zero signals for a package the registry has no record of", async () => {
    fetchMock.mockResolvedValueOnce(notFound());
    const result = await assessEol(dep({ name: "does-not-exist" }));
    expect(result.signals).toEqual([]);
    expect(result.isLikelyEol).toBe(false);
  });
});
