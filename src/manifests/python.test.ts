import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPythonDependencies, findRequirementsFiles, parseRequirementLine, parseRequirementsFile } from "./python.js";

describe("parseRequirementLine", () => {
  it("parses an exact pin", () => {
    expect(parseRequirementLine("Django==6.0.2")).toEqual({ name: "Django", version: "6.0.2" });
  });

  it("parses a range specifier by approximating to its floor version", () => {
    expect(parseRequirementLine("requests>=2.28.0")).toEqual({ name: "requests", version: "2.28.0" });
  });

  it("drops an extras marker", () => {
    expect(parseRequirementLine("psycopg[binary]==3.2.12")).toEqual({ name: "psycopg", version: "3.2.12" });
  });

  it("strips an environment marker", () => {
    expect(parseRequirementLine('foo==1.2.3; python_version >= "3.8"')).toEqual({ name: "foo", version: "1.2.3" });
  });

  it("strips a trailing inline comment", () => {
    expect(parseRequirementLine("foo==1.2.3  # pinned for compatibility")).toEqual({ name: "foo", version: "1.2.3" });
  });

  it("ignores a full-line comment", () => {
    expect(parseRequirementLine("# this is a comment")).toBeNull();
  });

  it("ignores a blank line", () => {
    expect(parseRequirementLine("   ")).toBeNull();
  });

  it("ignores option flags like -r and --index-url", () => {
    expect(parseRequirementLine("-r base.txt")).toBeNull();
    expect(parseRequirementLine("--index-url https://example.com")).toBeNull();
  });

  it("ignores an unpinned requirement — nothing to version-check", () => {
    expect(parseRequirementLine("requests")).toBeNull();
  });

  it("handles underscore vs hyphen package names as written (no normalization)", () => {
    expect(parseRequirementLine("djangorestframework_simplejwt==5.5.1")).toEqual({
      name: "djangorestframework_simplejwt",
      version: "5.5.1",
    });
  });
});

describe("requirements.txt file parsing", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), "repovate-python-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  async function write(relPath: string, content: string): Promise<void> {
    const full = path.join(repoRoot, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  it("parses a real-shaped requirements.txt into direct-only pypi deps", async () => {
    await write(
      "backend-django/requirements.txt",
      [
        "asgiref==3.11.1",
        "Django==6.0.2",
        "psycopg[binary]==3.2.12",
        "",
        "# dev-only tooling below",
        "requests==2.33.1",
      ].join("\n"),
    );

    const result = await parseRequirementsFile(repoRoot, "backend-django/requirements.txt");

    expect(result.transitiveCoverage).toBe("direct-only");
    expect(result.lockfilePath).toBeNull();
    expect(result.dependencies).toEqual([
      { name: "asgiref", version: "3.11.1", ecosystem: "pypi", direct: true, manifestPath: "backend-django/requirements.txt" },
      { name: "Django", version: "6.0.2", ecosystem: "pypi", direct: true, manifestPath: "backend-django/requirements.txt" },
      { name: "psycopg", version: "3.2.12", ecosystem: "pypi", direct: true, manifestPath: "backend-django/requirements.txt" },
      { name: "requests", version: "2.33.1", ecosystem: "pypi", direct: true, manifestPath: "backend-django/requirements.txt" },
    ]);
  });

  it("discovers every requirements.txt in the repo, skipping virtualenvs", async () => {
    await write("backend-django/requirements.txt", "Django==6.0.2");
    await write("scripts/requirements.txt", "black==24.0.0");
    await write("backend-django/venv/lib/requirements.txt", "should-be-skipped==1.0.0");

    const found = await findRequirementsFiles(repoRoot);

    expect(found.sort()).toEqual(["backend-django/requirements.txt", "scripts/requirements.txt"].sort());
  });

  it("findPythonDependencies parses every discovered file", async () => {
    await write("backend-django/requirements.txt", "Django==6.0.2");
    await write("scripts/requirements.txt", "black==24.0.0");

    const results = await findPythonDependencies(repoRoot);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.transitiveCoverage === "direct-only")).toBe(true);
  });
});
