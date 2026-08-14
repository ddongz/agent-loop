import { describe, expect, it } from "vitest";

import { runFeedbackDemo } from "../../scripts/mechanism-demo.js";

describe("feedback causality mechanism demo", () => {
  it("withholds the repair until the expected fingerprint is fed back, then succeeds", async () => {
    const result = await runFeedbackDemo();

    expect(result).toMatchObject({
      refusalCode: "SCRIPT_NO_MATCH",
      repairAction: "repair",
      precheckPackageManager: "npm",
      validationExitCodes: [1, 1, 0],
      finalSource: "export const value: number = 2;\n",
      finalState: "SUCCEEDED",
      finalDecision: "REQUEST_SUCCESS_CHECK",
      passed: true,
    });
    expect(result.expectedFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.repairContextFingerprints).toContain(result.expectedFingerprint);
  });
});
