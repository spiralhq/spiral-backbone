import { describe, expect, it } from "vitest";
import { artifactVersions } from "./artifacts";

describe("artifactVersions", () => {
  it("stamps both programs with version@commit and the backbone commit", () => {
    const versions = artifactVersions();
    expect(versions["organization"]).toMatch(/^\d+\.\d+\.\d+@[0-9a-f]{7}$/);
    expect(versions["film"]).toMatch(/^\d+\.\d+\.\d+@[0-9a-f]{7}$/);
    expect(versions["backbone"]).toMatch(/^([0-9a-f]{7,}|unknown)$/);
  });
});
