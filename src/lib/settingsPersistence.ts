export const SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED_PREFIX =
  "SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED:";

export interface SettingsSaveFailure {
  message: string;
  reconcileAuthoritativeSettings: boolean;
}

/** Decode the native persistence marker without exposing an implementation code
 * in user-facing errors. Only a proven post-commit durability failure requests a
 * settings reload; ordinary pre-commit failures keep the controlled value. */
export function classifySettingsSaveFailure(error: unknown): SettingsSaveFailure {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.startsWith(SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED_PREFIX)) {
    return {
      message:
        raw.slice(SETTINGS_COMMITTED_DURABILITY_UNCONFIRMED_PREFIX.length).trim() ||
        "Settings were updated, but storage durability could not be confirmed.",
      reconcileAuthoritativeSettings: true,
    };
  }
  return { message: raw, reconcileAuthoritativeSettings: false };
}
