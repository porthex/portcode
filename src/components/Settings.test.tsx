import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { SettingsPanel } from "./Settings";
import { useStore } from "../store/store";
import * as ipc from "../lib/ipc";
import { DEFAULT_SETTINGS, MODELS, type Settings, type ToolPolicy } from "../types";

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
});

describe("SettingsPanel — structure", () => {
  it("renders the modal chrome, provider, model select and footer", () => {
    renderPanel();

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
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

describe("SettingsPanel — close affordances", () => {
  it("closes via the ✕ button", () => {
    renderPanel({}); // showSettings starts false; set it true so close is observable
    useStore.setState({ showSettings: true });

    fireEvent.click(screen.getByRole("button", { name: "✕" }));

    expect(useStore.getState().showSettings).toBe(false);
  });

  it("closes when the backdrop is clicked but not when the inner card is", () => {
    const { container } = renderPanel();
    useStore.setState({ showSettings: true });

    // The inner card stops propagation -> clicking the heading must NOT close.
    fireEvent.click(screen.getByRole("heading", { name: "Settings" }));
    expect(useStore.getState().showSettings).toBe(true);

    // The outermost element is the backdrop -> clicking it closes.
    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(useStore.getState().showSettings).toBe(false);
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

    // The 1800ms timer resets the flash back to "Save"; advancing the fake
    // timer fires setSavedKey(false), wrapped in act so React re-renders.
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
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

describe("SettingsPanel — default tool permission", () => {
  it("highlights the active policy and switches policy through ipc.saveSettings", async () => {
    renderPanel({ defaultPolicy: "ask" });

    // "ask" is active and carries the accent class; the others do not.
    const ask = screen.getByRole("button", { name: "ask" });
    expect(ask.className).toContain("border-accent");
    const allow = screen.getByRole("button", { name: "allow" });
    expect(allow.className).not.toContain("border-accent");

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

describe("SettingsPanel — footer environment label", () => {
  it("labels preview (browser) when not under Tauri", () => {
    m.isTauri.mockReturnValue(false);
    renderPanel();
    expect(screen.getByText("preview (browser)")).toBeInTheDocument();
  });

  it("labels native core when under Tauri", () => {
    m.isTauri.mockReturnValue(true);
    renderPanel();
    expect(screen.getByText("native core")).toBeInTheDocument();
  });
});
