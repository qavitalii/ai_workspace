import { describe, expect, it } from "vitest";
import {
  usageWindows,
  modelLabel,
  effortLabel,
  claudeSubscriptionUsage,
} from "../src/usage";

describe("provider usage and model display", () => {
  it("shows remaining percentages for both Codex windows and uses actual durations", () => {
    expect(
      usageWindows({
        primary: {
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 2000000000,
        },
        secondary: { usedPercent: 80, windowDurationMins: 10080 },
      }),
    ).toEqual([
      {
        label: "5 hours",
        remaining: 75,
        resetsAt: 2000000000,
        status: undefined,
      },
      { label: "7 days", remaining: 20, resetsAt: null, status: undefined },
    ]);
    expect(
      usageWindows({
        primary: { usedPercent: 5, windowDurationMins: 10080 },
      })[0].label,
    ).toBe("7 days");
  });
  it("uses multi-bucket snapshots without duplicating the legacy Codex bucket", () => {
    const primary = { usedPercent: 100, windowDurationMins: 300 };
    expect(
      usageWindows({
        rateLimits: { primary },
        rateLimitsByLimitId: {
          codex: { primary },
          special: { primary: { ...primary, usedPercent: 20 } },
        },
      }).map((w) => w.remaining),
    ).toEqual([0, 80]);
  });
  it("converts Claude fractions but never invents a balance for missing utilization", () => {
    expect(
      usageWindows({
        windows: {
          five_hour: { utilization: 0.2 },
          seven_day: { status: "allowed" },
        },
      }).map((w) => w.remaining),
    ).toEqual([80, null]);
    expect(usageWindows(null)).toEqual([]);
    expect(usageWindows({ usedPercent: null })[0].remaining).toBeNull();
    expect(usageWindows({ usedPercent: 120 })[0].remaining).toBe(0);
  });
  it("normalizes Claude subscription usage without inventing windows or credits", () => {
    const limits = claudeSubscriptionUsage({
      five_hour: { utilization: 23, resets_at: "2033-05-18T03:33:20+00:00" },
      seven_day: { utilization: 100, resets_at: null },
      seven_day_opus: null,
      seven_day_oauth_apps: { utilization: 5 },
      seven_day_sonnet: { utilization: null },
      extra_usage: { is_enabled: true, utilization: 50 },
    });
    expect(limits).toEqual({
      windows: {
        five_hour: { utilization: 0.23, resets_at: 2000000000 },
        seven_day: { utilization: 1, resets_at: null, status: "rejected" },
      },
    });
    expect(usageWindows(limits)).toEqual([
      {
        label: "5 hours",
        remaining: 77,
        resetsAt: 2000000000,
        status: undefined,
      },
      { label: "7 days", remaining: 0, resetsAt: null, status: "rejected" },
    ]);
    expect(claudeSubscriptionUsage(null)).toEqual({ windows: {} });
  });
  it("prefers a provider-reported model over its alias and uses native effort labels", () => {
    expect(
      modelLabel({ model: "sonnet", resolved_model: "claude-fixture" }),
    ).toBe("claude-fixture");
    expect(modelLabel({ model: "gpt-fixture" })).toBe("gpt-fixture");
    expect(modelLabel({})).toBe("Model not yet reported");
    expect(effortLabel("high")).toBe("High");
  });
});
