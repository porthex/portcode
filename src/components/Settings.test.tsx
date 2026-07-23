import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";

import { SettingsPanel } from "./Settings";
import { useStore } from "../store/store";
import * as ipc from "../lib/ipc";
import {
  DEFAULT_SETTINGS,
  MODELS,
  type OpenAIAccountSummary,
  type PairedDevice,
  type PhoneSyncStatus,
  type Settings,
} from "../types";

// SettingsPanel is the settings modal. It reads `settings` from the real store
// and mutates it through the store's `updateSettings` action (which lands on
// ipc.saveSettings) plus direct Codex authentication IPC. We mock the
// IPC layer (TDD London style) and drive the real store so the assertions check
// genuine wiring: which ipc calls fire and how store state changes.
vi.mock("../lib/ipc", () => ({
  getSettings: vi.fn(async () => DEFAULT_SETTINGS),
  // Reached by the store's updateSettings; echoes a merged settings object.
  saveSettings: vi.fn(async (s: Partial<Settings>) => ({ ...DEFAULT_SETTINGS, ...s })),
  // Reached by the store's checkForUpdate (manual "Check now" button); no update.
  checkForUpdate: vi.fn(async () => null),
  setTelemetryConsent: vi.fn(async (_enabled: boolean) => {}),
  // Called directly by the component for API-key authentication. Portcode never stores the key.
  loginCodexApiKey: vi.fn(),
  // Resolves a folder path; present for completeness of the store's surface.
  openFolder: vi.fn(async () => "C:/work/repo" as string | null),
  // Footer reads this to label native vs. preview.
  isTauri: vi.fn(() => false),
  openaiOauthStatus: vi.fn(),
  listOpenAIAccounts: vi.fn(),
  startOpenAIAccountLogin: vi.fn(),
  reconnectOpenAIAccount: vi.fn(),
  removeOpenAIAccount: vi.fn(),
  openaiModels: vi.fn(),
  getPlanUsage: vi.fn(),
  // Phone sync: reached via the store's refreshPhoneSync/beginPairing/unpair.
  phoneSyncStatus: vi.fn(),
  phoneSyncBeginPairing: vi.fn(),
  phoneSyncUnpair: vi.fn(),
  // Device-trust gate: reached via the store's confirm/rejectPairingRequest.
  confirmPairing: vi.fn(async (_id: string) => {}),
  rejectPairing: vi.fn(async (_id: string) => {}),
}));

const m = vi.mocked(ipc);
const initial = useStore.getState();

const openAIAccount = (over: Partial<OpenAIAccountSummary> = {}): OpenAIAccountSummary => ({
  id: "00000000-0000-4000-8000-000000000001",
  accountLabel: "you@openai.com",
  tier: "ChatGPT Plus",
  expiresAt: 4_102_444_800,
  state: "connected",
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  ...over,
});

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
  m.getSettings.mockResolvedValue(DEFAULT_SETTINGS);
  m.loginCodexApiKey.mockResolvedValue({
    signedIn: true,
    expiresAt: null,
    account: "OpenAI Platform API key",
    tier: null,
    available: true,
  });
  m.openFolder.mockResolvedValue("C:/work/repo");
  m.isTauri.mockReturnValue(false);
  m.openaiOauthStatus.mockResolvedValue({
    signedIn: false,
    expiresAt: null,
    account: null,
    tier: null,
  });
  m.listOpenAIAccounts.mockResolvedValue([]);
  m.startOpenAIAccountLogin.mockResolvedValue(openAIAccount());
  m.reconnectOpenAIAccount.mockImplementation(async (accountProfileId) => ({
    status: "reconnected" as const,
    account: openAIAccount({ id: accountProfileId }),
  }));
  m.removeOpenAIAccount.mockResolvedValue(undefined);
  m.openaiModels.mockResolvedValue([
    {
      id: "gpt-live",
      label: "GPT Live",
      reasoningEfforts: ["minimal", "high", "ultra"],
      defaultReasoningEffort: "high",
    },
  ]);
  m.getPlanUsage.mockImplementation(async (provider) => ({
    provider,
    plan: provider === "openai" ? "Plus" : "Max",
    updatedAt: 1_900_000_000,
    windows: [],
  }));
  m.phoneSyncStatus.mockResolvedValue({ devicePublicKey: "DEVICE==", paired: [] });
  m.phoneSyncBeginPairing.mockResolvedValue({
    version: 1,
    publicKey: "DEVICE==",
    nonce: "NONCE==",
  });
  m.phoneSyncUnpair.mockResolvedValue(undefined);
});

afterEach(() => {
  // Several Settings tests intentionally use fake timers. Always restore the
  // global clock even when an assertion fails so later suites cannot inherit it.
  vi.useRealTimers();
});

describe("SettingsPanel — structure", () => {
  it("renders the modal chrome, provider, model select and footer", () => {
    renderPanel();

    expect(screen.getByRole("dialog", { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByText("SETTINGS")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "GPT / Codex" })).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI model for new sessions")).toHaveValue(
      DEFAULT_SETTINGS.model,
    );
    expect(screen.getByLabelText("OpenAI Platform API key")).toHaveAttribute("type", "password");
    expect(screen.queryByRole("heading", { name: "Claude" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument();
  });

  it("keeps both Codex authentication modes inside the OpenAI section", () => {
    renderPanel();
    const openai = document.getElementById("pc-settings-openai")!;

    expect(within(openai).getByLabelText("OpenAI model for new sessions")).toBeInTheDocument();
    expect(
      within(openai).getByRole("button", { name: "Sign in with ChatGPT" }),
    ).toBeInTheDocument();
    expect(within(openai).getByLabelText("OpenAI Platform API key")).toBeInTheDocument();
    expect(within(openai).getByText(/same bundled Codex engine/i)).toBeInTheDocument();
    expect(within(openai).getByText(/never stored by Portcode/i)).toBeInTheDocument();
    expect(within(openai).queryByLabelText("Anthropic API key")).toBeNull();
    expect(document.getElementById("pc-settings-claude")).toBeNull();
  });

  it("tracks the usage section when focus enters it", () => {
    renderPanel();
    const usageSection = document.getElementById("pc-settings-usage")!;

    fireEvent.focus(usageSection);

    expect(screen.getByRole("button", { name: "Plan usage" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("keeps API-key mode available when new ChatGPT connections are disabled", () => {
    useStore.setState({
      openAIAuthStatus: {
        signedIn: false,
        expiresAt: null,
        account: null,
        tier: null,
        available: false,
        unavailableReason: "Disabled in this build",
      },
    });

    renderPanel();

    const map = screen.getByRole("navigation", { name: "Settings map" });
    expect(within(map).getByRole("button", { name: "OpenAI / GPT" })).toBeInTheDocument();
    expect(document.getElementById("pc-settings-openai")).not.toHaveClass("hidden");
    expect(screen.getByText("New ChatGPT connections are disabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with ChatGPT" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI Platform API key")).toBeInTheDocument();
    expect(within(map).getAllByText(/Codex not connected/).length).toBeGreaterThan(0);
    expect(document.getElementById("pc-setting-plan-usage")).toBeInTheDocument();
  });

  it("presents a categorized settings map with live configuration summaries", () => {
    useStore.setState({ uiScale: 1.1, ambientRain: true });
    renderPanel({ permissionMode: "plan", rules: [{ tool: "shell", decision: "ask" }] });

    const map = screen.getByRole("navigation", { name: "Settings map" });
    for (const name of [
      "OpenAI / GPT",
      "Plan usage",
      "Permissions",
      "Interface",
      "Privacy & updates",
      "Phone sync",
    ]) {
      expect(within(map).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(map).getByText("plan")).toBeInTheDocument();
    expect(within(map).getByText(/110% · effects on/i)).toBeInTheDocument();
  });

  it("keeps the settings map and section headers free of numeric markers", () => {
    const { container } = renderPanel();
    const map = screen.getByRole("navigation", { name: "Settings map" });

    for (const marker of ["01", "02", "03", "04", "05", "06"]) {
      expect(within(map).queryByText(marker)).not.toBeInTheDocument();
    }
    expect(container.querySelector(".pc-settings-section-head__route")).toBeNull();
  });

  it("finds settings by their specific control names and narrows the content", () => {
    renderPanel();

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a setting" }), {
      target: { value: "scanlines" },
    });

    expect(screen.getByText("1 category found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Interface" })).not.toHaveAttribute("data-filtered");
    expect(screen.getByRole("button", { name: "OpenAI / GPT" })).toHaveAttribute(
      "data-filtered",
      "true",
    );
    expect(document.getElementById("pc-settings-interface")).not.toHaveClass("hidden");
    expect(document.getElementById("pc-settings-openai")).toHaveClass("hidden");
    expect(document.getElementById("pc-setting-scanlines")).toHaveClass("pc-settings-target");

    fireEvent.click(screen.getByRole("button", { name: "Clear settings search" }));
    expect(screen.getByRole("searchbox", { name: "Find a setting" })).toHaveValue("");
  });

  it("routes plan-limit searches to the combined usage panel", () => {
    renderPanel();

    expect(document.querySelector("#pc-setting-plan-usage .pc-plan-usage")).toHaveClass(
      "pc-plan-usage--compact",
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a setting" }), {
      target: { value: "weekly limit" },
    });

    expect(screen.getByText("1 category found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan usage" })).not.toHaveAttribute("data-filtered");
    expect(document.getElementById("pc-settings-usage")).not.toHaveClass("hidden");
    expect(document.getElementById("pc-setting-plan-usage")).toHaveClass("pc-settings-target");
  });

  it("routes permission-mode searches to the Codex policy selector", () => {
    renderPanel();

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a setting" }), {
      target: { value: "permission mode" },
    });

    expect(screen.getByText("1 category found")).toBeInTheDocument();
    expect(document.getElementById("pc-settings-permissions")).not.toHaveClass("hidden");
    expect(document.getElementById("pc-setting-permission-mode")).toHaveClass("pc-settings-target");
  });

  it("surfaces a useful empty state and clears an unsuccessful search", () => {
    renderPanel();

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a setting" }), {
      target: { value: "warp capacitor" },
    });
    expect(screen.getByText("No setting found")).toBeInTheDocument();
    expect(screen.getByText(/model.*command.*scanlines.*reports.*phone/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("searchbox", { name: "Find a setting" })).toHaveValue("");
    expect(screen.queryByText("No setting found")).not.toBeInTheDocument();
  });

  it("searches only settings that are currently available", () => {
    const { unmount } = renderPanel();
    const search = screen.getByRole("searchbox", { name: "Find a setting" });

    fireEvent.change(search, { target: { value: "reasoning level" } });
    expect(screen.getByText("1 category found")).toBeInTheDocument();

    unmount();
    useStore.setState({ remoteMode: true });
    renderPanel();
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a setting" }), {
      target: { value: "automatic updates" },
    });
    expect(screen.getByText("No setting found")).toBeInTheDocument();
  });

  it("changes the active route from the category rail", () => {
    renderPanel();

    const openai = screen.getByRole("button", { name: "OpenAI / GPT" });
    const permissions = screen.getByRole("button", { name: "Permissions" });
    expect(openai).toHaveAttribute("aria-current", "location");

    fireEvent.click(permissions);
    expect(permissions).toHaveAttribute("aria-current", "location");
    expect(openai).not.toHaveAttribute("aria-current");

    fireEvent.focus(screen.getByRole("button", { name: "Plan" }));
    expect(permissions).toHaveAttribute("aria-current", "location");

    const interfaceRoute = screen.getByRole("button", { name: "Interface" });
    fireEvent.focus(screen.getByRole("switch", { name: "Typing animation" }));
    expect(interfaceRoute).toHaveAttribute("aria-current", "location");

    const systemRoute = screen.getByRole("button", { name: "Privacy & updates" });
    const reports = screen.getByRole("switch", { name: "Crash & performance reports" });
    fireEvent.focus(reports);
    expect(systemRoute).toHaveAttribute("aria-current", "location");
    fireEvent.click(reports);
    expect(useStore.getState().crashReporting).toBe(true);
  });

  it("keeps the active route synchronized while the settings content scrolls", () => {
    const { container } = renderPanel();
    const content = container.querySelector<HTMLElement>(".pc-settings-content")!;
    const openAISection = document.getElementById("pc-settings-openai")!;
    const permissionsSection = document.getElementById("pc-settings-permissions")!;
    const interfaceSection = document.getElementById("pc-settings-interface")!;
    const systemSection = document.getElementById("pc-settings-system")!;
    const devicesSection = document.getElementById("pc-settings-devices")!;

    Object.defineProperty(content, "scrollTop", { configurable: true, value: 420 });
    Object.defineProperty(openAISection, "offsetTop", { configurable: true, value: 120 });
    Object.defineProperty(permissionsSection, "offsetTop", { configurable: true, value: 240 });
    Object.defineProperty(interfaceSection, "offsetTop", { configurable: true, value: 390 });
    Object.defineProperty(systemSection, "offsetTop", { configurable: true, value: 620 });
    Object.defineProperty(devicesSection, "offsetTop", { configurable: true, value: 840 });
    fireEvent.scroll(content);

    expect(screen.getByRole("button", { name: "Interface" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("keeps the clicked route active while its smooth scroll crosses other sections", () => {
    vi.useFakeTimers();
    const { container } = renderPanel();
    const content = container.querySelector<HTMLElement>(".pc-settings-content")!;
    const permissionsSection = document.getElementById("pc-settings-permissions")!;
    const interfaceSection = document.getElementById("pc-settings-interface")!;
    const systemSection = document.getElementById("pc-settings-system")!;
    const devicesSection = document.getElementById("pc-settings-devices")!;

    Object.defineProperty(content, "scrollTop", { configurable: true, value: 420 });
    Object.defineProperty(permissionsSection, "offsetTop", { configurable: true, value: 240 });
    Object.defineProperty(interfaceSection, "offsetTop", { configurable: true, value: 390 });
    Object.defineProperty(systemSection, "offsetTop", { configurable: true, value: 620 });
    Object.defineProperty(devicesSection, "offsetTop", { configurable: true, value: 840 });

    const systemRoute = screen.getByRole("button", { name: "Privacy & updates" });
    fireEvent.click(systemRoute);
    fireEvent.scroll(content);

    expect(systemRoute).toHaveAttribute("aria-current", "location");

    act(() => vi.advanceTimersByTime(700));
    fireEvent.scroll(content);
    expect(screen.getByRole("button", { name: "Interface" })).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  it("removes desktop-only destinations from the map in remote mode", () => {
    useStore.setState({ remoteMode: true });
    renderPanel();

    const map = screen.getByRole("navigation", { name: "Settings map" });
    expect(within(map).getByRole("button", { name: "Interface" })).toBeInTheDocument();
    expect(within(map).getByRole("button", { name: "Privacy" })).toBeInTheDocument();
    expect(within(map).queryByRole("button", { name: "Claude" })).not.toBeInTheDocument();
    expect(within(map).queryByRole("button", { name: "OpenAI / GPT" })).not.toBeInTheDocument();
    expect(within(map).queryByRole("button", { name: "Plan usage" })).not.toBeInTheDocument();
    expect(within(map).queryByRole("button", { name: "Permissions" })).not.toBeInTheDocument();
    expect(within(map).queryByRole("button", { name: "Phone sync" })).not.toBeInTheDocument();
  });
});

describe("SettingsPanel — OpenAI subscription", () => {
  it("retries slot discovery and cancels a sign-out confirmation", () => {
    const refresh = vi.fn(async () => {});
    useStore.setState({
      openAIAccounts: [openAIAccount()],
      openAIAccountsError: "registry offline",
      refreshOpenAIStatus: refresh,
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Sign out you@openai.com" }));
    expect(
      screen.getByRole("button", { name: "Confirm sign out you@openai.com" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("button", { name: "Confirm sign out you@openai.com" }),
    ).not.toBeInTheDocument();
  });

  it("distinguishes loading, discovery error, true zero, and reconnect-only registries", () => {
    const refresh = vi.fn(async () => {});
    useStore.setState({
      openAIAccounts: [],
      openAIAccountsLoading: true,
      openAIAccountsError: null,
      refreshOpenAIStatus: refresh,
    });
    const view = renderPanel();

    expect(screen.getByText(/Loading Codex authentication/)).toHaveAttribute("role", "status");

    useStore.setState({ openAIAccountsLoading: false, openAIAccountsError: "registry locked" });
    view.rerender(<SettingsPanel />);
    expect(screen.getByText(/load Codex authentication/).closest("[role=alert]")).toHaveTextContent(
      "registry locked",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry account discovery" }));
    expect(refresh).toHaveBeenCalledOnce();

    useStore.setState({ openAIAccountsError: null });
    view.rerender(<SettingsPanel />);
    expect(screen.getByText("Codex is not connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeEnabled();

    const saved = openAIAccount({ state: "reconnect_required", expiresAt: null });
    useStore.setState({ openAIAccounts: [saved] });
    view.rerender(<SettingsPanel />);
    expect(screen.getByText("Codex needs authentication")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect you@openai.com" })).toBeEnabled();
  });

  it("switches the default provider only from the provider-scoped GPT picker", async () => {
    const account = openAIAccount();
    const gptModel = MODELS.find((model) => model.provider === "openai")!;
    useStore.setState({
      openAIAccounts: [account],
      openAIModels: [gptModel],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [gptModel], error: null },
      },
    });
    renderPanel({ provider: "anthropic", model: "claude-opus-4-8" });

    const picker = screen.getByLabelText("OpenAI model for new sessions");
    expect(picker).toHaveValue("choose-openai");
    fireEvent.click(picker);
    expect(screen.queryByRole("option", { name: "Claude Opus 4.8" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: gptModel.label }));

    expect(m.saveSettings).toHaveBeenCalledWith({
      model: gptModel.id,
      provider: "openai",
      reasoningEffort: "medium",
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useStore.getState().settings).toMatchObject({
      model: gptModel.id,
      provider: "openai",
    });
  });

  it("renders only the backend's codex-primary authentication slot", () => {
    const model = MODELS.find((candidate) => candidate.provider === "openai")!;
    const primary = openAIAccount({ id: "codex-primary", accountLabel: "primary@chatgpt.test" });
    const stale = openAIAccount({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "stale@chatgpt.test",
    });
    useStore.setState({
      openAIAccounts: [stale, primary],
      openAIModels: [model],
      openAIModelCatalogs: {
        [primary.id]: { status: "ready", models: [model], error: null },
        [stale.id]: { status: "ready", models: [model], error: null },
      },
    });
    renderPanel({ provider: "openai", model: model.id });

    expect(screen.getByText(/Models for primary@chatgpt\.test/)).toBeInTheDocument();
    expect(screen.getAllByText("primary@chatgpt.test").length).toBeGreaterThan(0);
    expect(screen.queryByText("stale@chatgpt.test")).toBeNull();
  });

  it("does not offer profiles and explains that authentication modes replace the slot", () => {
    const model = MODELS.find((candidate) => candidate.provider === "openai")!;
    const primary = openAIAccount({ id: "codex-primary" });
    useStore.setState({
      openAIAccounts: [primary],
      openAIModels: [model],
      openAIModelCatalogs: {
        [primary.id]: { status: "ready", models: [model], error: null },
      },
    });
    renderPanel({ provider: "openai", model: model.id });

    expect(screen.queryByLabelText("Default ChatGPT account")).toBeNull();
    expect(screen.getByRole("button", { name: "Switch to ChatGPT" })).toBeEnabled();
    expect(
      screen.getByText(/Switching modes replaces the current Codex authentication/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Using it replaces the current ChatGPT authentication/),
    ).toBeInTheDocument();
  });

  it("signs in to the Codex slot and refreshes its live model catalogue", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.startOpenAIAccountLogin).toHaveBeenCalledTimes(1);
    expect(m.openaiModels).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
    expect(useStore.getState().openAIAccounts).toEqual([openAIAccount()]);
    expect(useStore.getState().openAIModels.map((model) => model.id)).toEqual(["gpt-live"]);
  });

  it("shows per-account state, reconnects a tombstone in place, and never renders its UUID", async () => {
    const removed = openAIAccount({
      accountLabel: "returning@chatgpt.test",
      state: "removed",
      expiresAt: null,
    });
    useStore.setState({
      openAIAuthStatus: {
        signedIn: false,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
      openAIAccounts: [removed],
    });
    const connected = { ...removed, state: "connected" as const, updatedAt: 2 };
    m.reconnectOpenAIAccount.mockResolvedValue({
      status: "reconnected",
      account: connected,
    });
    renderPanel();

    expect(screen.getAllByText("returning@chatgpt.test").length).toBeGreaterThan(0);
    expect(screen.getByText(/Removed .* history retained/)).toBeInTheDocument();
    expect(screen.queryByText(removed.id)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove returning@chatgpt.test" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect returning@chatgpt.test" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.reconnectOpenAIAccount).toHaveBeenCalledWith(removed.id);
    expect(useStore.getState().openAIAccounts).toEqual([connected]);
  });

  it("does not advertise a second profile after a mismatched reconnect", async () => {
    const original = openAIAccount({
      accountLabel: "original@chatgpt.test",
      state: "reconnect_required",
      expiresAt: null,
    });
    useStore.setState({
      openAIAuthStatus: {
        signedIn: false,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
      openAIAccounts: [original],
    });
    m.reconnectOpenAIAccount.mockResolvedValue({
      status: "identity_mismatch",
      message: "That sign-in belongs to a different ChatGPT account.",
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect original@chatgpt.test" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useStore.getState().openAIAccounts).toEqual([original]);
    expect(screen.queryByText("Different ChatGPT account detected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add as separate account" })).toBeNull();
  });

  it("renders one unlabeled Codex slot and never exposes profile ids", () => {
    const primary = openAIAccount({ id: "codex-primary", accountLabel: null, createdAt: 10 });
    const stale = openAIAccount({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: null,
      createdAt: 20,
    });
    useStore.setState({ openAIAccounts: [stale, primary] });
    const { container } = renderPanel();

    expect(container.querySelectorAll(".pc-openai-account-row")).toHaveLength(1);
    expect(container).not.toHaveTextContent(primary.id);
    expect(container).not.toHaveTextContent(stale.id);
  });

  it("does not offer stale model rows when a profile catalogue is in error", () => {
    const account = openAIAccount();
    const stale = {
      id: "gpt-stale",
      label: "GPT Stale",
      provider: "openai" as const,
      reasoningEfforts: ["high" as const],
      defaultReasoningEffort: "high" as const,
    };
    useStore.setState({
      openAIAccounts: [account],
      openAIModels: [stale],
      openAIModelCatalogs: {
        [account.id]: { status: "error", models: [stale], error: "catalogue offline" },
      },
    });
    renderPanel({ provider: "openai", model: stale.id, reasoningEffort: "high" });

    const picker = screen.getByLabelText("OpenAI model for new sessions");
    expect(picker).toBeDisabled();
    expect(screen.getByText("catalogue offline")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "GPT Stale" })).not.toBeInTheDocument();
    expect(screen.getByText("Choose a GPT model to configure reasoning.")).toBeInTheDocument();
  });

  it("keeps removal available when connection capability is off and retains the tombstone", async () => {
    const connected = openAIAccount();
    const removed = { ...connected, state: "removed" as const, expiresAt: null, updatedAt: 2 };
    useStore.setState({
      openAIAuthStatus: {
        signedIn: false,
        expiresAt: null,
        account: null,
        tier: null,
        available: false,
        unavailableReason: "Disabled in this build",
      },
      openAIAccounts: [connected],
    });
    m.listOpenAIAccounts.mockResolvedValue([removed]);
    renderPanel();

    expect(screen.getByText("New ChatGPT connections are disabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with ChatGPT" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out you@openai.com" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm sign out you@openai.com" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.removeOpenAIAccount).toHaveBeenCalledWith(connected.id);
    expect(useStore.getState().openAIAccounts).toEqual([removed]);
    expect(screen.getByText(/Removed .* history retained/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sign out you@openai.com" }),
    ).not.toBeInTheDocument();
  });

  it("shows and persists only supported reasoning levels for the selected OpenAI model", async () => {
    useStore.setState({
      openAIModels: [
        {
          id: "gpt-live",
          label: "GPT Live",
          provider: "openai",
          reasoningEfforts: ["minimal", "ultra"],
          defaultReasoningEffort: "ultra",
        },
      ],
    });
    renderPanel({ provider: "openai", model: "gpt-live", reasoningEffort: "ultra" });

    expect(screen.getByRole("heading", { name: "GPT / Codex" })).toBeInTheDocument();
    const reasoning = screen.getByLabelText("Reasoning level");
    expect(reasoning).toHaveValue("ultra");
    fireEvent.click(reasoning);
    const reasoningList = screen.getByRole("listbox", { name: "Reasoning level" });
    expect(
      within(reasoningList)
        .getAllByRole("option")
        .map((option) => option.textContent?.replace("✓", "").trim()),
    ).toEqual(["Minimal", "Ultra"]);

    fireEvent.click(screen.getByRole("option", { name: "Minimal" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(m.saveSettings).toHaveBeenCalledWith({ reasoningEffort: "minimal" });
  });

  it("shows Spark's advertised default instead of a stale Ultra setting", () => {
    useStore.setState({
      openAIModels: [
        {
          id: "gpt-5.3-codex-spark",
          label: "GPT-5.3 Codex Spark",
          provider: "openai",
          reasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "high",
        },
      ],
    });
    renderPanel({
      provider: "openai",
      model: "gpt-5.3-codex-spark",
      reasoningEffort: "ultra",
    });

    const reasoning = screen.getByLabelText("Reasoning level");
    expect(reasoning).toHaveValue("high");
    fireEvent.click(reasoning);
    expect(screen.queryByRole("option", { name: "Ultra" })).toBeNull();
    expect(screen.getByRole("option", { name: "High" })).toHaveAttribute("aria-selected", "true");
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

  it("lets an open settings picker consume Escape before the modal", () => {
    const account = openAIAccount();
    const gptModel = MODELS.find((model) => model.provider === "openai")!;
    useStore.setState({
      openAIAccounts: [account],
      openAIModels: [gptModel],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [gptModel], error: null },
      },
    });
    renderPanel({ provider: "openai", model: gptModel.id });
    useStore.setState({ showSettings: true });
    const model = screen.getByRole("combobox", { name: "OpenAI model for new sessions" });

    fireEvent.click(model);
    expect(
      screen.getByRole("listbox", { name: "OpenAI model for new sessions" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(model, { key: "Escape" });

    expect(
      screen.queryByRole("listbox", { name: "OpenAI model for new sessions" }),
    ).not.toBeInTheDocument();
    expect(useStore.getState().showSettings).toBe(true);
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

describe("SettingsPanel — Codex API-key authentication", () => {
  it("explains key handling and keeps submission disabled until a non-empty key is entered", () => {
    renderPanel();

    const input = screen.getByLabelText("OpenAI Platform API key");
    const submit = screen.getByRole("button", { name: "Use API key" });
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("placeholder", "sk-…");
    expect(input.className).toContain("focus:border-accent/50");
    expect(screen.getByText(/never stored by Portcode/i)).toBeInTheDocument();
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: "   " } });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(m.loginCodexApiKey).not.toHaveBeenCalled();
  });

  it("hands a trimmed key to Codex, clears the raw value, refreshes auth, and announces success", async () => {
    m.openaiOauthStatus.mockResolvedValue({
      signedIn: true,
      expiresAt: null,
      account: "OpenAI Platform API key",
      tier: null,
      available: true,
    });
    m.listOpenAIAccounts.mockResolvedValue([
      openAIAccount({ id: "codex-primary", accountLabel: "OpenAI Platform API key" }),
    ]);
    renderPanel();

    const input = screen.getByLabelText("OpenAI Platform API key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  sk-proj-secret  " } });
    fireEvent.click(screen.getByRole("button", { name: "Use API key" }));

    await act(async () => {});
    expect(m.loginCodexApiKey).toHaveBeenCalledTimes(1);
    expect(m.loginCodexApiKey).toHaveBeenCalledWith("sk-proj-secret");
    expect(input.value).toBe("");
    expect(m.openaiOauthStatus).toHaveBeenCalled();
    expect(m.listOpenAIAccounts).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("OpenAI API key connected");
    expect(screen.getByRole("button", { name: "Connected" })).toBeInTheDocument();
  });

  it("retains a rejected key for correction and clears the stale error while editing", async () => {
    m.loginCodexApiKey.mockRejectedValueOnce(new Error("Codex rejected the key"));
    renderPanel();

    const input = screen.getByLabelText("OpenAI Platform API key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-proj-retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Use API key" }));

    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveTextContent(
      "API-key sign-in failed: Codex rejected the key",
    );
    expect(input.value).toBe("sk-proj-retry");

    fireEvent.change(input, { target: { value: "sk-proj-corrected" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the connected-state timer on unmount", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = renderPanel();

    fireEvent.change(screen.getByLabelText("OpenAI Platform API key"), {
      target: { value: "sk-proj-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use API key" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe("SettingsPanel — permission modes & rules", () => {
  it("switches to a safe mode through ipc.saveSettings", async () => {
    renderPanel({ permissionMode: "default" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Accept edits" }));
    });

    expect(m.saveSettings).toHaveBeenCalledWith({ permissionMode: "acceptEdits" });
  });

  it("locks the global permission mode while any session is live", async () => {
    useStore.setState({
      runs: {
        background: {
          streaming: true,
          cancel: null,
          pendingPermission: null,
          turnId: "turn-background",
          startedAt: 1,
          finalizing: false,
          receipt: null,
          outcome: null,
          composerPhase: "thinking",
          activeTool: null,
          unseenOutcome: null,
        },
      },
    });
    renderPanel({ permissionMode: "default" });

    const acceptEdits = screen.getByRole("button", { name: "Accept edits" });
    expect(acceptEdits).toBeDisabled();
    expect(
      screen.getByText(/Permission mode is locked while a session is running/i),
    ).toBeInTheDocument();
    await act(async () => fireEvent.click(acceptEdits));
    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("requires an explicit acknowledgment before enabling a danger mode (auto)", async () => {
    renderPanel({ permissionMode: "default" });

    // Clicking Auto does NOT switch immediately — it asks for confirmation first.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Auto/i }));
    });
    expect(m.saveSettings).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: /Enable Auto/i });
    expect(screen.getByRole("alert")).toHaveTextContent(
      /workspace-write sandbox with on-request approvals and automatic review/i,
    );

    // Confirming engages the mode.
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(m.saveSettings).toHaveBeenCalledWith({ permissionMode: "auto" });
  });

  it("cancelling the danger acknowledgment does not switch the mode", async () => {
    renderPanel({ permissionMode: "default" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Bypass/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(m.saveSettings).not.toHaveBeenCalled();
  });

  it("warns that Bypass grants danger-full-access without approval prompts", async () => {
    renderPanel({ permissionMode: "default" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Bypass/i }));
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/danger-full-access/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/without approval prompts/i);
  });

  it("does not render obsolete local policy or rule controls", () => {
    renderPanel({
      defaultPolicy: "allow",
      rules: [{ tool: "run_command", command: "git ", decision: "allow" }],
    });

    expect(document.getElementById("pc-setting-default-policy")).toBeNull();
    expect(document.getElementById("pc-setting-tool-rules")).toBeNull();
    expect(screen.queryByLabelText("Rule tool")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Rule decision")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Command prefix")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add rule" })).not.toBeInTheDocument();
  });

  it("describes the native Codex approval and sandbox mappings", () => {
    renderPanel();
    const spectrum = within(document.getElementById("pc-setting-permission-mode")!);

    expect(spectrum.getByRole("button", { name: "Default" })).toHaveAttribute(
      "title",
      "Codex policy: untrusted approvals · workspace-write sandbox.",
    );
    expect(spectrum.getByRole("button", { name: "Accept edits" })).toHaveAttribute(
      "title",
      "Codex policy: on-request approvals · workspace-write sandbox.",
    );
    expect(spectrum.getByRole("button", { name: "Plan" })).toHaveAttribute(
      "title",
      "Codex policy: never ask · read-only sandbox.",
    );
    expect(spectrum.getByRole("button", { name: /Auto/i })).toHaveAttribute(
      "title",
      "Codex policy: auto-review · on-request approvals · workspace-write sandbox.",
    );
    expect(spectrum.getByRole("button", { name: /Bypass/i })).toHaveAttribute(
      "title",
      "Codex policy: never ask · danger-full-access sandbox.",
    );
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

  // ── Interface scale: a frontend-only document-zoom preset picker ─────────────
  it("offers the interface-scale presets in an accessible group", () => {
    renderPanel();

    const group = screen.getByRole("group", { name: "Interface scale" });
    expect(group).toBeInTheDocument();
    for (const label of ["Compact", "Default", "Comfortable", "Large"]) {
      expect(within(group).getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the active scale with aria-pressed (not colour alone)", () => {
    useStore.setState({ uiScale: 1 });
    renderPanel();

    const group = screen.getByRole("group", { name: "Interface scale" });
    // The active preset is conveyed via aria-pressed so it's not colour-only.
    expect(within(group).getByRole("button", { name: "Default" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(group).getByRole("button", { name: "Large" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("selecting a preset drives the store's setUiScale (client-only, no ipc.saveSettings)", () => {
    useStore.setState({ uiScale: 1 });
    renderPanel();

    const group = screen.getByRole("group", { name: "Interface scale" });
    fireEvent.click(within(group).getByRole("button", { name: "Large" }));

    expect(useStore.getState().uiScale).toBe(1.25);
    expect(document.documentElement.style.zoom).toBe("1.25");
    expect(m.saveSettings).not.toHaveBeenCalled();
    // The newly active preset now reports pressed; the prior one is released.
    expect(within(group).getByRole("button", { name: "Large" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(group).getByRole("button", { name: "Default" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("reflects the stored auto-update value and persists a toggle via ipc.saveSettings", async () => {
    renderPanel({ autoUpdate: true });

    const sw = screen.getByRole("switch", { name: "Automatic updates" });
    expect(sw).toHaveAttribute("aria-checked", "true");

    // The toggle routes through the store's setAutoUpdate -> updateSettings ->
    // ipc.saveSettings with the negated value.
    fireEvent.click(sw);
    expect(m.saveSettings).toHaveBeenCalledWith({ autoUpdate: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(useStore.getState().settings.autoUpdate).toBe(false);
  });

  it("shows the auto-update switch as off when the preference is disabled", () => {
    renderPanel({ autoUpdate: false });
    expect(screen.getByRole("switch", { name: "Automatic updates" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("shows the plain stable auto-update hint with no channel annotation", () => {
    // Portcode ships a single `stable` channel — the retired staging feed used
    // to append a "(staging channel)" note, which must never appear now.
    useStore.setState({ updateChannel: "stable" });
    renderPanel({ autoUpdate: true });
    expect(
      screen.getByText("Download and install new versions automatically, then prompt to relaunch."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\(staging channel\)/)).not.toBeInTheDocument();
  });

  it("runs a manual update check when 'Check now' is clicked", async () => {
    renderPanel({ autoUpdate: false });
    fireEvent.click(screen.getByRole("button", { name: /check now/i }));
    // The button routes through the store's checkForUpdate -> ipc.checkForUpdate.
    expect(m.checkForUpdate).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("shows a busy state while a manual check is in flight, then settles", async () => {
    let finish!: () => void;
    m.checkForUpdate.mockReturnValue(
      new Promise<null>((resolve) => {
        finish = () => resolve(null);
      }),
    );
    renderPanel({ autoUpdate: false });

    fireEvent.click(screen.getByRole("button", { name: /check now/i }));
    // Mid-flight: the button is disabled and both it and the status read "checking".
    const busyBtn = screen.getByRole("button", { name: /checking/i });
    expect(busyBtn).toBeDisabled();
    expect(screen.getByText(/checking for updates/i)).toBeInTheDocument();

    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: /check now/i })).toBeEnabled();
  });

  it("surfaces each update phase inline as a status line", () => {
    const info = { version: "5.1.0", currentVersion: "5.0.0", notes: null, date: null };

    useStore.setState({ update: { phase: "available", info, progress: null, error: null } });
    const { unmount: u1 } = renderPanel();
    expect(screen.getByText(/Update available · v5\.1\.0/)).toBeInTheDocument();
    u1();

    useStore.setState({ update: { phase: "ready", info, progress: 100, error: null } });
    const { unmount: u2 } = renderPanel();
    expect(screen.getByText(/relaunch to apply/i)).toBeInTheDocument();
    u2();

    useStore.setState({ update: { phase: "error", info: null, progress: null, error: "x" } });
    const { unmount: u3 } = renderPanel();
    expect(screen.getByText(/last check failed/i)).toBeInTheDocument();
    u3();

    // Quiet startup/periodic failures stay in the idle phase so they do not raise
    // the global banner, but Settings still tells the user the last check failed.
    useStore.setState({ update: { phase: "idle", info: null, progress: null, error: "offline" } });
    renderPanel();
    expect(screen.getByText(/last check failed/i)).toBeInTheDocument();
  });

  it("disables 'Check now' and shows progress while an update is downloading", () => {
    useStore.setState({
      update: { phase: "downloading", info: null, progress: 40, error: null },
    });
    renderPanel();
    expect(screen.getByRole("button", { name: /check now/i })).toBeDisabled();
    expect(screen.getByText(/downloading update/i)).toBeInTheDocument();
  });

  it("reads as up to date when idle (no update offered)", () => {
    renderPanel();
    expect(screen.getByText(/on the latest version/i)).toBeInTheDocument();
  });

  it("hides the Automatic updates switch and Check now button in remote mode", () => {
    useStore.setState({ remoteMode: true });
    renderPanel();

    expect(screen.queryByRole("switch", { name: "Automatic updates" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check now/i })).not.toBeInTheDocument();

    useStore.setState({ remoteMode: false }); // don't leak into other tests
  });

  it("disables 'Check now' when an update is already staged (phase ready)", () => {
    const info = { version: "5.1.0", currentVersion: "5.0.0", notes: null, date: null };
    useStore.setState({ update: { phase: "ready", info, progress: 100, error: null } });
    renderPanel();

    expect(screen.getByRole("button", { name: /check now/i })).toBeDisabled();
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
    confirmed: true,
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

  it("surfaces store.pairingError when begin-pairing or unpair fails", () => {
    useStore.setState({ pairingPayload: null, pairingError: "keyring locked" });
    renderPanel();
    const alert = screen.getByText(/Pairing failed: keyring locked/);
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute("role", "alert");
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

  // ── device-trust gate: the desktop-side confirm prompt ───────────────────────

  it("surfaces a pending pairing request with its SAS for comparison", () => {
    useStore.setState({
      pairingRequest: { requestId: "req-1", sas: "GOLF-77", peerKeyHex: "PHONE_KEY==" },
    });
    renderPanel();

    expect(screen.getByText("New phone pairing")).toBeInTheDocument();
    // The SAS box's accessible name must carry the digits (mirrors the phone-side
    // VerifyPanel) so a screen reader hears the actual code to compare.
    const sasBox = screen.getByLabelText(/Pairing verification code/);
    expect(sasBox).toHaveAccessibleName(/GOLF-77/);
    expect(screen.getByText("GOLF-77")).toBeInTheDocument();
  });

  it("Allow confirms the pending pairing via ipc and clears the prompt", async () => {
    useStore.setState({
      pairingRequest: { requestId: "req-1", sas: "GOLF-77", peerKeyHex: "PHONE_KEY==" },
    });
    m.phoneSyncStatus.mockResolvedValue({ devicePublicKey: "DEVICE==", paired: [] });
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Codes match/ }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.confirmPairing).toHaveBeenCalledWith("req-1");
    expect(useStore.getState().pairingRequest).toBeNull();
  });

  it("Reject declines the pending pairing via ipc and clears the prompt", async () => {
    useStore.setState({
      pairingRequest: { requestId: "req-1", sas: "GOLF-77", peerKeyHex: "PHONE_KEY==" },
    });
    renderPanel();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reject" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(m.rejectPairing).toHaveBeenCalledWith("req-1");
    expect(useStore.getState().pairingRequest).toBeNull();
  });

  it("shows no pairing-confirm prompt when there is no pending request", () => {
    useStore.setState({ pairingRequest: null });
    renderPanel();
    expect(screen.queryByText("New phone pairing")).not.toBeInTheDocument();
  });

  it("hides the desktop-only sections on a phone (remote mode)", () => {
    // The agent's config (model/key/sign-in), the tool policy, and the desktop's
    // show-a-QR pairing flow all live on the desktop — several of their commands
    // are desktop-only and would error — so the phone hides those sections.
    useStore.setState({ remoteMode: true });
    renderPanel();

    expect(document.getElementById("pc-settings-claude")).toBeNull();
    expect(document.getElementById("pc-settings-openai")).toHaveClass("hidden");
    expect(document.getElementById("pc-settings-usage")).toHaveClass("hidden");
    expect(screen.getByText("PERMISSIONS").closest("section")).toHaveClass("hidden");
    expect(screen.getByText("PHONE SYNC").closest("section")).toHaveClass("hidden");
    // Appearance (purely client-side UI prefs) stays available.
    expect(screen.getByText("APPEARANCE").closest("section")).not.toHaveClass("hidden");

    useStore.setState({ remoteMode: false }); // don't leak into other tests
  });
});
