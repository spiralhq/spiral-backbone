import { describe, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({ status: "" }));
vi.mock("node:child_process", () => ({
  execFileSync: (_file: string, args: string[]) => {
    if (args[0] === "rev-parse") return "abc1234\n";
    if (args[0] === "status") return git.status;
    throw new Error(`unexpected git ${args[0]}`);
  },
}));

const { artifactVersions, resetBackboneStamp } = await import("./artifacts");

describe("artifactVersions", () => {
  it("stamps both programs with version@commit and the backbone commit", () => {
    const versions = artifactVersions();
    expect(versions["organization"]).toMatch(/^\d+\.\d+\.\d+@[0-9a-f]{7}$/);
    expect(versions["film"]).toMatch(/^\d+\.\d+\.\d+@[0-9a-f]{7}$/);
    expect(versions["backbone"]).toMatch(/^([0-9a-f]{7,}|unknown)$/);
  });

  it("appends -dirty when tracked files have changes, and only then", () => {
    git.status = "";
    resetBackboneStamp();
    expect(artifactVersions()["backbone"]).toBe("abc1234");
    git.status = " M packages/eval/src/h2/plan.ts\n";
    resetBackboneStamp();
    expect(artifactVersions()["backbone"]).toBe("abc1234-dirty");
  });
});
