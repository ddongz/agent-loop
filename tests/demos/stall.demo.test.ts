import { describe, expect, it } from "vitest";

import { runStallDemo } from "../../scripts/mechanism-demo.js";

describe("stall mechanism demo", () => {
  it("pauses exactly on the third unchanged validation and reports NO_PROGRESS", async () => {
    const result = await runStallDemo();

    expect(result.iterations).toEqual([
      { iteration: 1, decision: "CONTINUE", phase: "FEEDBACK" },
      { iteration: 2, decision: "CONTINUE", phase: "FEEDBACK" },
      { iteration: 3, decision: "PAUSE_NO_PROGRESS", phase: "PAUSED" },
    ]);
    expect(result).toMatchObject({
      finalState: "PAUSED",
      pauseReason: "PAUSE_NO_PROGRESS",
      reportNamesNoProgress: true,
      passed: true,
    });
  });
});
