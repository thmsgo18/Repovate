import { describe, expect, it } from "vitest";
import { classifyFile, parseDiffStats } from "./diff.js";

describe("classifyFile", () => {
  it("recognizes manifests by basename, anywhere in the tree", () => {
    expect(classifyFile("package.json")).toBe("manifest");
    expect(classifyFile("backend/package.json")).toBe("manifest");
    expect(classifyFile("requirements.txt")).toBe("manifest");
  });

  it("recognizes lockfiles by basename", () => {
    expect(classifyFile("package-lock.json")).toBe("lockfile");
    expect(classifyFile("yarn.lock")).toBe("lockfile");
    expect(classifyFile("pnpm-lock.yaml")).toBe("lockfile");
    expect(classifyFile("npm-shrinkwrap.json")).toBe("lockfile");
  });

  it("treats anything else as source", () => {
    expect(classifyFile("src/server.ts")).toBe("source");
    expect(classifyFile("app/main.py")).toBe("source");
  });
});

function diff(...blocks: string[]): string {
  return blocks.join("\n");
}

function fileBlock(filePath: string, addedLines: number, removedLines: number): string {
  const added = Array.from({ length: addedLines }, (_, i) => `+line${i}`).join("\n");
  const removed = Array.from({ length: removedLines }, (_, i) => `-line${i}`).join("\n");
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "index 111..222 100644",
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1,3 +1,3 @@",
    added,
    removed,
  ]
    .filter(Boolean)
    .join("\n");
}

describe("parseDiffStats", () => {
  it("counts lines and files, and flags a lockfile-only patch as simple", () => {
    const stats = parseDiffStats(diff(fileBlock("package.json", 1, 1), fileBlock("package-lock.json", 40, 38)));

    expect(stats.files).toHaveLength(2);
    expect(stats.touchesSourceFile).toBe(false);
    expect(stats.isSimplePatch).toBe(true);
    // Lockfile excluded from the size calc entirely.
    expect(stats.filesChangedExcludingLockfiles).toBe(1);
    expect(stats.linesChangedExcludingLockfiles).toBe(2);
  });

  it("flags a patch that touches a source file as not simple, regardless of size", () => {
    const stats = parseDiffStats(diff(fileBlock("package.json", 1, 1), fileBlock("src/server.ts", 2, 0)));

    expect(stats.touchesSourceFile).toBe(true);
    expect(stats.isSimplePatch).toBe(false);
    expect(stats.filesChangedExcludingLockfiles).toBe(2);
  });

  it("returns an empty, simple result for an empty diff", () => {
    const stats = parseDiffStats("");
    expect(stats.files).toEqual([]);
    expect(stats.isSimplePatch).toBe(true);
    expect(stats.filesChangedExcludingLockfiles).toBe(0);
  });
});
