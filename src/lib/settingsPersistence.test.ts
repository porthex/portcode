import { describe, expect, it } from "vitest";

import {
  SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED_PREFIX,
  classifySettingsSaveFailure,
} from "./settingsPersistence";

describe("classifySettingsSaveFailure", () => {
  it("keeps the native settings-error prefix contract", () => {
    expect(SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED_PREFIX).toBe(
      "SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED:",
    );
  });

  it("marks a coded post-commit durability warning for reconciliation", () => {
    expect(
      classifySettingsSaveFailure(
        new Error(
          `${SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED_PREFIX} Settings changed; sync failed.`,
        ),
      ),
    ).toEqual({
      message: "Settings changed; sync failed.",
      reconcileAuthoritativeSettings: true,
    });
  });

  it("leaves ordinary pre-commit failures unchanged", () => {
    expect(classifySettingsSaveFailure("disk full")).toEqual({
      message: "disk full",
      reconcileAuthoritativeSettings: false,
    });
  });
});
