import { describe, expect, it } from "vitest";

import { runFeedbackDemo } from "../../scripts/mechanism-demo.js";

describe("feedback causality mechanism demo", () => {
  it("withholds the repair until the expected fingerprint is fed back, then succeeds", async () => {
    const result = await runFeedbackDemo();

    expect(result).toMatchObject({
      refusalCode: "SCRIPT_NO_MATCH",
      expectedFingerprint: "fp-expected-2",
      repairAction: "repair",
      finalState: "SUCCEEDED",
      finalDecision: "REQUEST_SUCCESS_CHECK",
      passed: true,
    });
    expect(result.repairContextFingerprints).toContain("fp-expected-2");
  });
});
