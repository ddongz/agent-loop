import { describe, expect, it } from "vitest";

import { runGovernanceDemo } from "../../scripts/mechanism-demo.js";

describe("governance mechanism demo", () => {
  it("blocks a frozen-test mutation before dispatch and records the policy rule", async () => {
    const result = await runGovernanceDemo();

    expect(result).toMatchObject({
      decision: "REQUIRE_APPROVAL",
      auditReason: "PROTECTED_TEST_MUTATION",
      observationStatus: "approval_required",
      finalState: "AWAITING_APPROVAL",
      toolExecutions: 0,
      passed: true,
    });
  });
});
