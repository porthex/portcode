// Runtime platform detection for the mobile remote client.
//
// Portcode ships one frontend that runs in three hosts: the desktop Tauri shell,
// the browser preview, and the Android (Tauri-mobile) remote client. `isTauri()`
// (in ipc.ts) tells native from preview; this tells *mobile* native from desktop
// native so the app can default into remote mode on a phone.
//
// Deliberately a pure `navigator.userAgent` sniff — no Tauri/OS plugin — so it is
// trivially unit-testable by stubbing `navigator.userAgent`, and so it also works
// in the browser preview (letting a desktop browser opt into remote mode for
// testing via the in-app toggle, independent of this default).

/** True when the current user agent looks like an Android device. */
export function isMobilePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent ?? "");
}
