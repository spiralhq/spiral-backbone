import { describe, expect, it } from "vitest";
import { faultDetail } from "./run-container";

describe("faultDetail", () => {
  it("uses stderr when there is any", () => {
    expect(
      faultDetail(Object.assign(new Error("Command failed"), { stderr: "boom", code: 2 })),
    ).toBe("boom");
  });

  it("reports killed, signal and code when stderr is empty, without the command line", () => {
    const error = Object.assign(
      new Error("Command failed: docker run -e SPIRAL_ATTEMPT={secret}"),
      {
        stderr: "",
        killed: true,
        signal: "SIGTERM",
        code: null,
      },
    );
    const detail = faultDetail(error);
    expect(detail).toContain("killed=true");
    expect(detail).toContain("signal=SIGTERM");
    expect(detail).toContain("code=null");
    expect(detail).not.toContain("secret");
  });
});
