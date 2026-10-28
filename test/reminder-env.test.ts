import { describe, expect, it } from "vitest";
import { childEnv } from "../src/provider-bridge.js";

const reminderFeatureKeys = [
  "MUSE_EXPERIMENTAL_SCOPE_REMINDER",
  "MUSE_EXPERIMENTAL_SKILL_REMINDER",
  "MUSE_EXPERIMENTAL_TODO_REMINDER",
  "MUSE_EXPERIMENTAL_MEMORY_REMINDER",
  "MUSE_EXPERIMENTAL_GOAL_REMINDER",
  "MUSE_EXPERIMENTAL_VERIFY_REMINDER",
] as const;

describe("Muse reminder runtime policy", () => {
  it("disables every reminder feature for BB-hosted Muse processes", () => {
    const env = childEnv(undefined, null);

    for (const key of reminderFeatureKeys) {
      expect(env[key]).toBe("false");
    }
  });

  it("does not allow provider environment overrides to re-enable reminders", () => {
    const env = childEnv(
      Object.fromEntries(reminderFeatureKeys.map((key) => [key, "true"])),
      "/tmp/bb-muse-config",
    );

    for (const key of reminderFeatureKeys) {
      expect(env[key]).toBe("false");
    }
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/bb-muse-config");
  });
});
