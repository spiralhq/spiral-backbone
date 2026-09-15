import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("@spiral-backbone/protocol", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@spiral-backbone/protocol");
  });
});
