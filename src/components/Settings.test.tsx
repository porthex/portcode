import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";

import { SettingsPanel } from "./Settings";
import { useStore } from "../store/store";
import * as ipc from "../lib/ipc";
import {
  DEFAULT_SETTINGS,
  MODELS,
  type PairedDevice,
  type PhoneSyncStatus,
  type Settings,
  type ToolPolicy,
} from "../types";

// SettingsPanel is the settings modal. It reads `settings` from the real store
// and mutates it through the store's `updateSettings` action (which lands on
// ipc.saveSettings) plus a direct ipc.setApiKey for the credential. We mock the
// IPC layer (TDD London style) and drive the real store so the assertions check
// genuine wiring: which ipc calls fire and how store state changes.
vi.mock("../lib/ipc", () => ({
  // Reached by the store's updateSettings; echoes a merged settings object.
  saveSettings: vi.fn(async (s: Partial<Settings>) => ({ ...DEFAULT_SETTINGS, ...s })),
  // Called directly by the component when saving the API key.
  setApiKey: vi.fn(async (_key: string) => {}),
  // Resolves a folder path; present for completeness of the store's surface.
  openFolder: vi.fn(async () => "C:/work/repo" as string | null),
  // Footer reads this to label native vs. preview.
  isTauri: vi.fn(() => false),
  // Subscription sign-in: reached via the store's loginWithClaude/logoutClaude.
  startOauthLogin: vi.fn(),
  oauthLogout: vi.fn(),
  oauthStatus: vi.fn(),
  // Phone sync: reached via the store's refreshPhoneSync/beginPairing/unpair.
  phoneSyncStatus: vi.fn(),
  phoneSyncBeginPairing: vi.fn(),
  phoneSyncUnpair: vi.fn(),
}));

const m = vi.mocked(ipc);
const initial = useStore.getState();

/** Arrange a settings object on the real store, then render the panel. */
function renderPanel(over: Partial<Settings> = {}) {
  useStore.setState({ settings: { ...DEFAULT_SETTINGS, ...over } });
  return render(<SettingsPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  // Pristine store between tests (zustand has no built-in reset).
  useStore.setState(initial, true);
  // Re-arm default mock implementations cleared above.
  m.saveSettings.mockImplementation(async (s: Partial<Settings>) => ({
    ...DEFAULT_SETTINGS,
    ...s,
  }));
  m.setApiKey.mockResolvedValue(undefined);
  m.openFolder.mockResolvedValue("C:/work/repo");
  m.isTauri.mockReturnValue(false);
  m.startOauthLogin.mockResolvedValue({
    signedIn: true,
    expiresAt: 4102444800, // 2100-01-01 — stable, so the formatted expiry never flakes
    account: "you@claude.ai",
    tier: "Claude Max",
  });
  m.oauthLogout.mockResolvedValue(undefined);
  m.oauthStatus.mockResolvedValue({ signedIn: false, expiresAt: null, account: null, tier: null });
  m.phoneSyncStatus.mockResolvedValue({ devicePublicKey: "DEVICE==", paired: [] });
  m.phoneSyncBeginPairing.mockResolvedValue({
    version: 1,
    publicKey: "DEVICE==",
    nonce: "NONCE==",
  });
  m.phoneSyncUnpair.mockResolvedValue(undefined);
});

describe("SettingsPanel — structure", () => {
  it("renders the modal chrome, provider, model select and footer", () => {
    renderPanel();

    // The panel is an accessible modal: role="dialog"/aria-modal labelled by the
    // SETTINGS title span (id="pc-settings-title").
    expect(screen.getByRole("dialog", { name: /settings/i })).toBeInTheDocument();

    // The Neon-Noir header renders the title as a styled (font-display) span,
    // not a semantic heading; assert on its literal uppercase text instead.
    expect(screen.getByText("SETTINGS")).toBeInTheDocument();
    expect(screen.getByText("Anthropic (Claude)")).toBeInTheDocument();

    // Model select reflects the store's current model.
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe(DEFAULT_SETTINGS.model);
    // Every model from the catalogue is offered as an option.
    for (const model of MODELS) {
      expect(screen.getByRole("option", { name: model.label })).toBeInTheDocument();
    }
  });
});

describe("SettingsPanel — Claude subscription sign-in", () => {
  const signedInStatus = (over: Record<string, unknown> = {}) => ({
    signedIn: true,
    expiresAt: 4102444800, // 2100-01-01 — stable so the formatted expiry never flakes
    account: "you@claude.ai",
    tier: "Claude Max",
    ...over,
  });

  it("shows the sign-in button when signed out and logs in via the store on click", async () => {
    renderPanel(); // oauthStatus null -> signed out
    const btn = screen.getByRole("button", { name: "Sign in with Claude" });

    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.startOauthLogin).toHaveBeenCalledTimes(1);
    expect(useStore.getState().oauthStatus?.signedIn).toBe(true);
  });

  it("renders the signed-in account, a Max tier badge and expiry, and logs out on click", async () => {
    useStore.setState({ oauthStatus: signedInStatus() });
    renderPanel();

    expect(screen.getByText(/Signed in as you@claude\.ai/)).toBeInTheDocument();
    expect(screen.getByText("Max").className).toContain("amber"); // "Claude " stripped; Max gradient
    expect(screen.getByText(/Access expires/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Log out" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.oauthLogout).toHaveBeenCalledTimes(1);
    expect(useStore.getState().oauthStatus?.signedIn).toBe(false);
  });

  it("uses the non-Max badge styling for a Pro tier", () => {
    useStore.setState({ oauthStatus: signedInStatus({ tier: "Claude Pro" }) });
    renderPanel();
    expect(screen.getByText("Pro").className).toContain("violet");
  });

  it("surfaces a sign-in error from the store", () => {
    useStore.setState({ oauthError: "oauth denied" });
    renderPanel();
    expect(screen.getByText(/Sign-in failed: oauth denied/)).toBeInTheDocument();
  });
});

describe("SettingsPanel — close affordances", () => {
  it("closes via the ✕ button", () => {
    renderPanel({}); // showSettings starts false; set it true so close is observable
    useStore.setState({ showSettings: true });

    // The close button shows a ✕ glyph but carries aria-label="Close settings",
    // which is its accessible name.
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    expect(useStore.getState().showSettings).toBe(false);
  });

  it("closes when Escape is pressed", () => {
    renderPanel();
    useStore.setState({ showSettings: true });

    // The panel registers a window keydown listener (mirroring CommandPalette);
    // pressing Escape anywhere hides the modal.
    fireEvent.keyDown(window, { key: "Escape" });

    expect(useStore.getState().showSettings).toBe(false);
  });

  it("closes when the backdrop is clicked but not when the inner card is", () => {
    const { container } = renderPanel();
    useStore.setState({ showSettings: true });

    // The inner card (.pc-modal) stops propagation -> clicking content inside it
    // (here the SETTINGS title) must NOT close.
    fireEvent.click(screen.getByText("SETTINGS"));
    expect(useStore.getState().showSettings).toBe(true);

    // The outermost element is the .pc-overlay backdrop -> clicking it closes.
    const backdrop = container.firstElementChild as HTMLElement;
    expect(backdrop.className).toContain("pc-overlay");
    fireEvent.click(backdrop);
    expect(useStore.getState().showSettings).toBe(false);
  });
});

describe("SettingsPanel — focus management", () => {
  // jsdom does no layout, so `offsetParent` is always null — which would make the
  // component's visibility filter (offsetParent !== null) treat every control as
  // hidden. Stub it to mirror a real browser: null only for elements inside a
  // `.hidden` ancestor (the remoteMode sections), the body otherwise.
  function installOffsetParentStub() {
    const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
    Object.defineProperty(HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get(this: HTMLElement) {
        return this.closest(".hidden") ? null : document.body;
      },
    });
    return () => {
      if (orig) Object.defineProperty(HTMLElement.prototype, "offsetParent", orig);
    };
  }

  /** Live-query the visible focusable controls inside the dialog (matches the component). */
  function visibleFocusable(dialog: HTMLElement) {
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null);
  }

  it("exposes dialog semantics and moves focus into the modal on open", () => {
    renderPanel();

    const dialog = screen.getByRole("dialog", { name: /settings/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // The first focusable descendant (the close ✕) receives focus on mount, so a
    // keyboard user isn't left on a background control behind the scrim.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close settings" }));
  });

  it("traps Tab: from the last focusable wraps to the first", () => {
    const restore = installOffsetParentStub();
    try {
      renderPanel();

      const dialog = screen.getByRole("dialog", { name: /settings/i });
      const focusable = visibleFocusable(dialog);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      last.focus();
      fireEvent.keyDown(dialog, { key: "Tab" });
      expect(document.activeElement).toBe(first);
    } finally {
      restore();
    }
  });

  it("traps Shift+Tab: from the first focusable wraps to the last", () => {
    const restore = installOffsetParentStub();
    try {
      renderPanel();

      const dialog = screen.getByRole("dialog", { name: /settings/i });
      const focusable = visibleFocusable(dialog);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      first.focus();
      fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(last);
    } finally {
      restore();
    }
  });

  it("ignores non-Tab keys in the trap handler", () => {
    renderPanel();
    const dialog = screen.getByRole("dialog", { name: /settings/i });
    const before = document.activeElement;
    // A bare key press must not move focus (only Tab is trapped).
    fireEvent.keyDown(dialog, { key: "a" });
    expect(document.activeElement).toBe(before);
  });

  it("restores focus to the opener when the modal unmounts", () => {
    // Stub an opener that has focus before the modal mounts; closing the modal
    // must return focus to it.
    const trigger = document.createElement("button");
    trigger.textContent = "open settings";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = renderPanel();
    // Focus moved into the dialog on open.
    expect(document.activeElement).not.toBe(trigger);

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

describe("SettingsPanel — model picker", () => {
  it("persists a model change through ipc.saveSettings and updates the store", async () => {
    renderPanel();

    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "claude-haiku-4-5-20251001" } });

    // updateSettings -> ipc.saveSettings; flush the microtask the action awaits.
    expect(m.saveSettings).toHaveBeenCalledWith({ model: "claude-haiku-4-5-20251001" });
    await Promise.resolve();
    await Promise.resolve();
    expect(useStore.getState().settings.model).toBe("claude-haiku-4-5-20251001");
  });

  it("surfaces store.settingsError when a model save fails and preserves the prior value", async () => {
    m.saveSettings.mockRejectedValueOnce(new Error("disk full"));
    renderPanel({ model: MODELS[0].id });

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "claude-haiku-4-5-20251001" } });
      await Promise.resolve();
      await Promise.resolve();
    });

    // The store's updateSettings catches the reject into settingsError; the panel
    // surfaces it adjacent to the Model select (in the CONNECTION section, not the
    // far-away PERMISSIONS banner) and the persisted model is unchanged.
    const conn = screen.getByText("CONNECTION").closest("section")!;
    expect(within(conn).getByText(/Couldn't save settings: disk full/)).toBeInTheDocument();
    expect(useStore.getState().settings.model).toBe(MODELS[0].id);
    expect(useStore.getState().settingsError).toBe("disk full");
  });
});

describe("SettingsPanel — API key", () => {
  it("shows the input placeholder and unsaved hint when no key is stored", () => {
    renderPanel({ apiKeySet: false });

    expect(screen.getByText(/Stored securely in Windows Credential Manager/)).toBeInTheDocument();
    const input = screen.getByPlaceholderText("sk-ant-…");
    expect(input).toBeInTheDocument();
  });

  it("shows the 'key stored' hint and replace placeholder when a key exists", () => {
    renderPanel({ apiKeySet: true });

    expect(screen.getByText("A key is stored in Windows Credential Manager.")).toBeInTheDocument();
    // Source placeholder has two spaces before "(replace)"; getByPlaceholderText
    // normalizes whitespace, so match loosely on the distinctive bullet+label.
    expect(screen.getByPlaceholderText(/\(replace\)/)).toBeInTheDocument();
  });

  it("disables Save for empty/whitespace input and ignores a whitespace submit", async () => {
    renderPanel();

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    // Whitespace keeps it disabled and the guard short-circuits saveKey.
    const input = screen.getByPlaceholderText("sk-ant-…");
    fireEvent.change(input, { target: { value: "   " } });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    await Promise.resolve();
    expect(m.setApiKey).not.toHaveBeenCalled();
  });

  it("saves a trimmed key, flips apiKeySet, clears the field and flashes Saved", async () => {
    vi.useFakeTimers();
    renderPanel({ apiKeySet: false });

    const input = screen.getByPlaceholderText("sk-ant-…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  sk-ant-secret  " } });

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    // The credential is sent trimmed.
    expect(m.setApiKey).toHaveBeenCalledWith("sk-ant-secret");

    // saveKey awaits setApiKey then updateSettings (-> ipc.saveSettings -> set);
    // all are microtasks. Flush several turns inside act so React commits the
    // resulting state. Avoid vi.waitFor here — it polls on real time and would
    // hang under fake timers.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(m.saveSettings).toHaveBeenCalledWith({ apiKeySet: true });

    // Store now reflects a stored key; the input is cleared; button reads "Saved".
    expect(useStore.getState().settings.apiKeySet).toBe(true);
    expect(input.value).toBe("");
    expect(screen.getByRole("button", { name: "Saved" })).toBeInTheDocument();

    // The 1800ms timer clears the flash; advancing the fake timer fires
    // setSavedKey(false), wrapped in act so React re-renders. With a key now
    // stored, the button settles on its resting "Replace" label (not "Save").
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
  });

  it("keeps focus inside the dialog after a successful save (no flash remount)", async () => {
    renderPanel({ apiKeySet: false });

    const input = screen.getByPlaceholderText("sk-ant-…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-secret" } });

    // A keyboard user activates Save from the button itself; capture the node so we
    // can prove the flash replay reuses it rather than remounting via a React key
    // (which would drop focus to <body>, outside the focus trap).
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    save.focus();
    expect(document.activeElement).toBe(save);

    await act(async () => {
      fireEvent.click(save);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Same DOM node survived the save (re-querying by its new "Saved" label returns
    // the very element we held), so focus never left the focus-trapped dialog.
    expect(screen.getByRole("button", { name: "Saved" })).toBe(save);
    const dialog = screen.getByRole("dialog", { name: /settings/i });
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("clears a stale 'Couldn't save key' error as the user edits the field", async () => {
    m.setApiKey.mockRejectedValueOnce(new Error("keyring locked"));
    renderPanel({ apiKeySet: false });

    const input = screen.getByPlaceholderText("sk-ant-…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-secret" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/Couldn't save key: keyring locked/)).toBeInTheDocument();

    // Editing the key toward a correction clears the stale error immediately,
    // rather than lingering until the next Save click.
    fireEvent.change(input, { target: { value: "sk-ant-secret2" } });
    expect(screen.queryByText(/Couldn't save key/)).not.toBeInTheDocument();
  });

  it("surfaces a setApiKey failure and retains the typed value", async () => {
    m.setApiKey.mockRejectedValueOnce(new Error("keyring locked"));
    renderPanel({ apiKeySet: false });

    const input = screen.getByPlaceholderText("sk-ant-…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-secret" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The error is shown and the typed value is kept so the user can retry.
    expect(screen.getByText(/Couldn't save key: keyring locked/)).toBeInTheDocument();
    expect(input.value).toBe("sk-ant-secret");
    // apiKeySet was never flipped, so the resting label is still "Save".
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(useStore.getState().settings.apiKeySet).toBe(false);
  });

  it("announces the saved key via a polite live region after a successful save", async () => {
    vi.useFakeTimers();
    renderPanel({ apiKeySet: false });

    // Before saving, the status region is empty (rendered unconditionally).
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("");

    const input = screen.getByPlaceholderText("sk-ant-…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("status")).toHaveTextContent("API key saved");
  });

  it("clears the Saved-flash timer on unmount so it can't update state after close", async () => {
    vi.useFakeTimers();
    renderPanel({ apiKeySet: false });

    const input = screen.getByPlaceholderText("sk-ant-…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Flush saveKey's microtasks so the 1800ms flash timer is armed.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Saved" })).toBeInTheDocument();

    // React warns on console.error if a state update lands after unmount. Watch
    // for it: unmount the modal (as closing it would), then run the timer past
    // 1800ms. The unmount-effect must have cleared the timer, so setSavedKey
    // never fires and no warning is emitted.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanup(); // unmounts the panel before the 1800ms flash elapses
    act(() => {
      vi.advanceTimersByTime(1800);
    });

    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("SettingsPanel — default tool permission", () => {
  it("highlights the active policy and switches policy through ipc.saveSettings", async () => {
    renderPanel({ defaultPolicy: "ask" });

    // The active policy is styled cyan: it carries a filled accent background
    // (bg-accent-2/10) + accent text. Inactive buttons use bg-panel-2 and only
    // an accent *hover* border, so discriminate on the active background token
    // rather than "border-accent" (which the inactive hover class also matches).
    const ask = screen.getByRole("button", { name: "ask" });
    expect(ask.className).toContain("bg-accent-2/10");
    expect(ask.className).toContain("text-accent-2");
    const allow = screen.getByRole("button", { name: "allow" });
    expect(allow.className).not.toContain("bg-accent-2/10");

    fireEvent.click(allow);
    expect(m.saveSettings).toHaveBeenCalledWith({ defaultPolicy: "allow" });
    await Promise.resolve();
    await Promise.resolve();
    expect(useStore.getState().settings.defaultPolicy).toBe("allow");
  });

  it("offers every policy button", () => {
    renderPanel();
    const policies: ToolPolicy[] = ["allow", "ask", "deny"];
    for (const p of policies) {
      expect(screen.getByRole("button", { name: p })).toBeInTheDocument();
    }
  });
});

describe("SettingsPanel — appearance toggles", () => {
  // APPEARANCE now renders three role="switch" buttons, so each must be queried
  // by its accessible name rather than the bare switch role.
  it("reflects the stored typing-animation value and toggles it through ipc.saveSettings", async () => {
    renderPanel({ typingAnimation: true });

    const sw = screen.getByRole("switch", { name: "Typing animation" });
    expect(sw).toHaveAttribute("aria-checked", "true");

    fireEvent.click(sw);
    expect(m.saveSettings).toHaveBeenCalledWith({ typingAnimation: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(useStore.getState().settings.typingAnimation).toBe(false);
  });

  it("shows the typing-animation switch as off when the preference is disabled", () => {
    renderPanel({ typingAnimation: false });
    expect(screen.getByRole("switch", { name: "Typing animation" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("reflects neon-rain state and toggles it through the store's setAmbientRain", () => {
    // ambientRain/scanlines are root store flags (not in Settings), so seed the
    // store before mount — the component subscribes to them directly.
    useStore.setState({ ambientRain: false });
    renderPanel();

    const sw = screen.getByRole("switch", { name: "Neon rain" });
    expect(sw).toHaveAttribute("aria-checked", "false");

    // Neon rain is client-only UI state (no ipc.saveSettings); it flips the
    // store's ambientRain flag via setAmbientRain.
    fireEvent.click(sw);
    expect(useStore.getState().ambientRain).toBe(true);
    expect(m.saveSettings).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("reflects scanlines state and toggles it through the store's setScanlines", () => {
    useStore.setState({ scanlines: true });
    renderPanel();

    const sw = screen.getByRole("switch", { name: "Scanlines" });
    expect(sw).toHaveAttribute("aria-checked", "true");

    fireEvent.click(sw);
    expect(useStore.getState().scanlines).toBe(false);
    expect(m.saveSettings).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute("aria-checked", "false");
  });
});

describe("SettingsPanel — footer environment label", () => {
  it("labels preview (browser) when not under Tauri", () => {
    m.isTauri.mockReturnValue(false);
    renderPanel();
    expect(screen.getByText("PREVIEW (BROWSER)")).toBeInTheDocument();
  });

  it("labels native core when under Tauri", () => {
    m.isTauri.mockReturnValue(true);
    renderPanel();
    expect(screen.getByText("NATIVE CORE")).toBeInTheDocument();
  });
});

describe("SettingsPanel — Phone Sync section", () => {
  const withPhoneSync = (over: Partial<PhoneSyncStatus> = {}): PhoneSyncStatus => ({
    devicePublicKey: "DEVICE_KEY_BASE64==",
    paired: [],
    ...over,
  });

  const paired = (): PairedDevice => ({
    publicKey: "PHONE_KEY==",
    name: "My Android",
    pairedAt: 1000,
    lastSeen: 2000,
  });

  it("renders the PHONE SYNC eyebrow label", () => {
    renderPanel();
    expect(screen.getByText("PHONE SYNC")).toBeInTheDocument();
  });

  it("shows the device public key (truncated) when phoneSync is set", () => {
    useStore.setState({ phoneSync: withPhoneSync() });
    renderPanel();
    // "DEVICE_KEY_BASE64==" is 18 chars, so it gets truncated to first 8 + "…" + last 4
    expect(screen.getByText("DEVICE_K…64==")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();
  });

  it("lists paired phones with name, truncated key, and unpair button", () => {
    useStore.setState({ phoneSync: withPhoneSync({ paired: [paired()] }) });
    renderPanel();

    expect(screen.getByText("My Android")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpair My Android" })).toBeInTheDocument();
  });

  it("calls ipc.phoneSyncUnpair and refreshes when Unpair is clicked", async () => {
    useStore.setState({ phoneSync: withPhoneSync({ paired: [paired()] }) });
    m.phoneSyncStatus.mockResolvedValue(withPhoneSync({ paired: [] }));
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unpair My Android" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.phoneSyncUnpair).toHaveBeenCalledWith("PHONE_KEY==");
    expect(m.phoneSyncStatus).toHaveBeenCalledTimes(1);
  });

  it("shows the Pair a phone button when no pairing is in progress", () => {
    useStore.setState({ pairingPayload: null });
    renderPanel();
    expect(screen.getByRole("button", { name: "Pair a phone" })).toBeInTheDocument();
  });

  it("calls beginPairing and shows the pairing code when Pair a phone is clicked", async () => {
    useStore.setState({ pairingPayload: null });
    m.phoneSyncBeginPairing.mockResolvedValue({ version: 1, publicKey: "PUB==", nonce: "NON==" });
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pair a phone" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.phoneSyncBeginPairing).toHaveBeenCalledTimes(1);
    // After beginPairing the store sets pairingPayload; the component shows the QR.
    useStore.setState({ pairingPayload: { version: 1, publicKey: "PUB==", nonce: "NON==" } });
    // Re-render to see the updated state.
    cleanup();
    renderPanel();
    expect(screen.getByTestId("pairing-qr")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("renders the pairing payload as a scannable QR with a copyable text fallback", () => {
    useStore.setState({ pairingPayload: { version: 1, publicKey: "PUB==", nonce: "NON==" } });
    renderPanel();

    // The QR (which the phone scans) and Done are shown up front; the raw code is
    // tucked behind a "show" toggle for the can't-scan fallback.
    expect(screen.getByTestId("pairing-qr")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.queryByText(/"publicKey":"PUB=="/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show pairing code/ }));
    // The revealed text is the exact JSON the phone parses.
    expect(screen.getByText(/"publicKey":"PUB=="/)).toBeInTheDocument();
  });

  it("copies the full pairing payload to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    useStore.setState({ pairingPayload: { version: 1, publicKey: "PUB==", nonce: "NON==" } });
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Copy code/ }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('{"version":1,"publicKey":"PUB==","nonce":"NON=="}');
    expect(screen.getByRole("button", { name: /Copied/ })).toBeInTheDocument();
    // A polite status region announces the copy for screen-reader users.
    expect(
      screen.getByText("Pairing code copied", { selector: '[role="status"]' }),
    ).toBeInTheDocument();
  });

  it("Done button clears the pairing payload", () => {
    useStore.setState({ pairingPayload: { version: 1, publicKey: "PUB==", nonce: "NON==" } });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(useStore.getState().pairingPayload).toBeNull();
  });

  it("hides the desktop-only sections on a phone (remote mode)", () => {
    // The agent's config (model/key/sign-in), the tool policy, and the desktop's
    // show-a-QR pairing flow all live on the desktop — several of their commands
    // are desktop-only and would error — so the phone hides those sections.
    useStore.setState({ remoteMode: true });
    renderPanel();

    expect(screen.getByText("CONNECTION").closest("section")).toHaveClass("hidden");
    expect(screen.getByText("PERMISSIONS").closest("section")).toHaveClass("hidden");
    expect(screen.getByText("PHONE SYNC").closest("section")).toHaveClass("hidden");
    // Appearance (purely client-side UI prefs) stays available.
    expect(screen.getByText("APPEARANCE").closest("section")).not.toHaveClass("hidden");

    useStore.setState({ remoteMode: false }); // don't leak into other tests
  });
});
