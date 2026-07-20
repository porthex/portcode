import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { QRCodeSVG } from "qrcode.react";
import { modelsForOpenAIProfile, preferredOpenAIAccount, useStore } from "../store/store";
import {
  ANTHROPIC_MODELS,
  DANGER_MODES,
  modelInfo,
  openAIAccountLabel,
  providerForModel,
  reasoningEffortLabel,
  type PairingPayload,
  type PairingRequest,
  type PermissionMode,
  type Rule,
  type ToolPolicy,
} from "../types";
import * as ipc from "../lib/ipc";
import { isCommandToolName, toolLabel, toolNamesEquivalent } from "../lib/toolNames";
import { SelectMenu } from "./SelectMenu";
import { PlanUsagePanel } from "./PlanUsagePanel";

type SettingsSectionId =
  "claude" | "openai" | "usage" | "permissions" | "interface" | "system" | "devices";

interface SettingsSectionMeta {
  id: SettingsSectionId;
  label: string;
  eyebrow: string;
  description: string;
  items: string[];
  desktopOnly?: boolean;
}

const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  {
    id: "claude",
    label: "Claude",
    eyebrow: "Anthropic",
    description: "Claude models and Anthropic credentials.",
    items: [
      "Claude models",
      "Claude default model",
      "Claude subscription",
      "Sign in with Claude",
      "Anthropic API key",
      "Claude API key",
      "Credential Manager",
    ],
    desktopOnly: true,
  },
  {
    id: "openai",
    label: "OpenAI / GPT",
    eyebrow: "OpenAI",
    description: "GPT models, ChatGPT access, and reasoning.",
    items: [
      "OpenAI models",
      "GPT models",
      "OpenAI default model",
      "Reasoning level",
      "OpenAI subscription",
      "ChatGPT sign in",
      "OpenAI API keys",
    ],
    desktopOnly: true,
  },
  {
    id: "usage",
    label: "Plan usage",
    eyebrow: "Allowance",
    description: "Included Claude and GPT plan limits with local reset times.",
    items: [
      "Plan usage",
      "Claude usage",
      "GPT usage",
      "Codex limits",
      "Current session limit",
      "Weekly limit",
      "Reset time",
      "Remaining usage",
    ],
    desktopOnly: true,
  },
  {
    id: "permissions",
    label: "Permissions",
    eyebrow: "Safety gate",
    description: "Control what the agent can do without asking.",
    items: [
      "Permission mode",
      "Default policy",
      "Accept edits",
      "Plan mode",
      "Auto mode",
      "Bypass mode",
      "Tool rules",
      "Command prefix",
    ],
    desktopOnly: true,
  },
  {
    id: "interface",
    label: "Interface",
    eyebrow: "Experience",
    description: "Motion, atmosphere, and display density.",
    items: ["Typing animation", "Neon rain", "Scanlines", "Interface scale", "Appearance"],
  },
  {
    id: "system",
    label: "Privacy & updates",
    eyebrow: "System",
    description: "Reporting choices and version control.",
    items: [
      "Automatic updates",
      "Check for updates",
      "Check now",
      "Crash reports",
      "Performance reports",
      "Privacy",
    ],
  },
  {
    id: "devices",
    label: "Phone sync",
    eyebrow: "Devices",
    description: "Pair, inspect, and revoke mobile access.",
    items: ["Pair a phone", "Paired phones", "This device", "Pairing code", "Unpair"],
    desktopOnly: true,
  },
];

const SETTINGS_TARGET_IDS: Record<string, string> = {
  "Claude models": "pc-setting-claude-model",
  "Claude default model": "pc-setting-claude-model",
  "Claude subscription": "pc-setting-claude",
  "Sign in with Claude": "pc-setting-claude",
  "Anthropic API key": "pc-setting-anthropic-api-key",
  "Claude API key": "pc-setting-anthropic-api-key",
  "Credential Manager": "pc-setting-anthropic-api-key",
  "OpenAI models": "pc-setting-openai-model",
  "GPT models": "pc-setting-openai-model",
  "OpenAI default model": "pc-setting-openai-model",
  "Reasoning level": "pc-setting-openai-reasoning",
  "OpenAI subscription": "pc-setting-openai",
  "ChatGPT sign in": "pc-setting-openai",
  "OpenAI API keys": "pc-setting-openai-auth-note",
  "Plan usage": "pc-setting-plan-usage",
  "Claude usage": "pc-setting-plan-usage",
  "GPT usage": "pc-setting-plan-usage",
  "Codex limits": "pc-setting-plan-usage",
  "Current session limit": "pc-setting-plan-usage",
  "Weekly limit": "pc-setting-plan-usage",
  "Reset time": "pc-setting-plan-usage",
  "Remaining usage": "pc-setting-plan-usage",
  "Permission mode": "pc-setting-permission-mode",
  "Default policy": "pc-setting-default-policy",
  "Accept edits": "pc-setting-permission-mode",
  "Plan mode": "pc-setting-permission-mode",
  "Auto mode": "pc-setting-permission-mode",
  "Bypass mode": "pc-setting-permission-mode",
  "Tool rules": "pc-setting-tool-rules",
  "Command prefix": "pc-setting-tool-rules",
  "Typing animation": "pc-setting-typing",
  "Neon rain": "pc-setting-rain",
  Scanlines: "pc-setting-scanlines",
  "Interface scale": "pc-setting-scale",
  Appearance: "pc-settings-interface",
  "Automatic updates": "pc-setting-auto-update",
  "Check for updates": "pc-setting-update-check",
  "Check now": "pc-setting-update-check",
  "Crash reports": "pc-setting-diagnostics",
  "Performance reports": "pc-setting-diagnostics",
  Privacy: "pc-setting-diagnostics",
  "Pair a phone": "pc-setting-phone-pairing",
  "Paired phones": "pc-setting-paired-phones",
  "This device": "pc-setting-device-identity",
  "Pairing code": "pc-setting-phone-pairing",
  Unpair: "pc-setting-paired-phones",
};

function matchesSettingsQuery(section: SettingsSectionMeta, query: string) {
  if (!query) return true;
  const haystack = [section.label, section.eyebrow, section.description, ...section.items]
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .every((term) => haystack.includes(term));
}

function matchingSettingNames(section: SettingsSectionMeta, query: string) {
  if (!query) return [];
  const terms = query.toLowerCase().trim().split(/\s+/);
  return section.items.filter((item) => terms.every((term) => item.toLowerCase().includes(term)));
}

export function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const settingsError = useStore((s) => s.settingsError);
  const pairingError = useStore((s) => s.pairingError);
  const oauthStatus = useStore((s) => s.oauthStatus);
  const oauthError = useStore((s) => s.oauthError);
  const loginWithClaude = useStore((s) => s.loginWithClaude);
  const logoutClaude = useStore((s) => s.logoutClaude);
  const openAIAuthStatus = useStore((s) => s.openAIAuthStatus);
  const openAIAuthError = useStore((s) => s.openAIAuthError);
  const openAIReconnectMismatch = useStore((s) => s.openAIReconnectMismatch);
  const openAIModels = useStore((s) => s.openAIModels);
  const openAIAccounts = useStore((s) => s.openAIAccounts);
  const openAIAccountsLoading = useStore((s) => s.openAIAccountsLoading);
  const openAIAccountsError = useStore((s) => s.openAIAccountsError);
  const openAIModelCatalogs = useStore((s) => s.openAIModelCatalogs);
  const lastOpenAIAccountProfileId = useStore((s) => s.lastOpenAIAccountProfileId);
  const loginWithOpenAI = useStore((s) => s.loginWithOpenAI);
  const reconnectOpenAIAccount = useStore((s) => s.reconnectOpenAIAccount);
  const removeOpenAIAccount = useStore((s) => s.removeOpenAIAccount);
  const refreshOpenAIStatus = useStore((s) => s.refreshOpenAIStatus);

  const ambientRain = useStore((s) => s.ambientRain);
  const scanlines = useStore((s) => s.scanlines);
  const uiScale = useStore((s) => s.uiScale);
  const setAmbientRain = useStore((s) => s.setAmbientRain);
  const setScanlines = useStore((s) => s.setScanlines);
  const setUiScale = useStore((s) => s.setUiScale);
  const crashReporting = useStore((s) => s.crashReporting);
  const setCrashReporting = useStore((s) => s.setCrashReporting);

  const setAutoUpdate = useStore((s) => s.setAutoUpdate);
  const update = useStore((s) => s.update);
  const checkForUpdate = useStore((s) => s.checkForUpdate);
  const [checkingForUpdate, setCheckingForUpdate] = useState(false);

  const phoneSync = useStore((s) => s.phoneSync);
  const pairingPayload = useStore((s) => s.pairingPayload);
  const beginPairing = useStore((s) => s.beginPairing);
  const unpair = useStore((s) => s.unpair);
  const clearPairing = useStore((s) => s.clearPairing);
  const pairingRequest = useStore((s) => s.pairingRequest);
  const confirmPairingRequest = useStore((s) => s.confirmPairingRequest);
  const rejectPairingRequest = useStore((s) => s.rejectPairingRequest);
  // On the phone (remote client) the agent — its model, key, sign-in, tool policy —
  // and the desktop's "show a QR to pair" flow all live on the DESKTOP, so those
  // sections are hidden here (several of their commands are desktop-only).
  const remoteMode = useStore((s) => s.remoteMode);

  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signingInOpenAI, setSigningInOpenAI] = useState(false);
  const [openAIAccountAction, setOpenAIAccountAction] = useState<string | null>(null);
  const [pendingOpenAIRemoval, setPendingOpenAIRemoval] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const saveBtnRef = useRef<HTMLButtonElement | null>(null);
  const sectionRefs = useRef<Partial<Record<SettingsSectionId, HTMLElement | null>>>({});
  const searchTargetRef = useRef<HTMLElement | null>(null);
  const navigatingRef = useRef(false);
  const navigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    remoteMode ? "interface" : "claude",
  );

  const signedIn = !!oauthStatus?.signedIn;
  const connectedOpenAIAccounts = openAIAccounts.filter((account) => account.state === "connected");
  const signedInOpenAI = connectedOpenAIAccounts.length > 0;
  const reconnectOnlyOpenAI = openAIAccounts.length > 0 && connectedOpenAIAccounts.length === 0;
  const openAIAvailable = openAIAuthStatus?.available !== false;
  const reconnectMismatchAccount = openAIAccounts.find(
    (account) => account.id === openAIReconnectMismatch?.accountProfileId,
  );
  const defaultOpenAIAccount = preferredOpenAIAccount(
    connectedOpenAIAccounts,
    lastOpenAIAccountProfileId,
  );
  const defaultOpenAIModels = modelsForOpenAIProfile(
    defaultOpenAIAccount?.id,
    openAIModelCatalogs,
    openAIModels,
  );
  const selectedModel = modelInfo(settings.model, defaultOpenAIModels);
  const selectedProvider = providerForModel(settings.model, defaultOpenAIModels);
  const claudeModelValue = selectedProvider === "anthropic" ? settings.model : "choose-claude";
  const openAIModelValue = selectedProvider === "openai" ? settings.model : "choose-openai";
  const reasoningEfforts =
    selectedProvider === "openai" ? (selectedModel?.reasoningEfforts ?? []) : [];
  const availableSections = useMemo(
    () =>
      SETTINGS_SECTIONS.filter(
        (section) =>
          !(remoteMode && section.desktopOnly) &&
          (openAIAvailable || openAIAccounts.length > 0 || section.id !== "openai"),
      ).map((section) => {
        if (section.id === "openai" && reasoningEfforts.length === 0) {
          return {
            ...section,
            items: section.items.filter((item) => item !== "Reasoning level"),
          };
        }
        if (section.id === "system" && remoteMode) {
          return {
            ...section,
            label: "Privacy",
            description: "Control anonymous diagnostics.",
            items: ["Crash reports", "Performance reports", "Privacy"],
          };
        }
        return section;
      }),
    [openAIAccounts.length, openAIAvailable, reasoningEfforts.length, remoteMode],
  );
  const visibleSections = useMemo(
    () => availableSections.filter((section) => matchesSettingsQuery(section, searchQuery)),
    [availableSections, searchQuery],
  );
  const visibleSectionIds = useMemo(
    () => new Set(visibleSections.map((section) => section.id)),
    [visibleSections],
  );
  const activeSearchMatch = useMemo(() => {
    if (!searchQuery) return null;
    for (const section of visibleSections) {
      const match = matchingSettingNames(section, searchQuery)[0];
      if (match) return { label: match, targetId: SETTINGS_TARGET_IDS[match] };
    }
    return null;
  }, [searchQuery, visibleSections]);
  const sectionStatus: Record<SettingsSectionId, string> = {
    claude: `${selectedProvider === "anthropic" ? "default" : "available"} · ${signedIn ? "signed in" : settings.apiKeySet ? "key stored" : "not connected"}`,
    openai: `${selectedProvider === "openai" ? "default" : "available"} · ${connectedOpenAIAccounts.length} account${connectedOpenAIAccounts.length === 1 ? "" : "s"}`,
    usage: `${Number(signedIn) + connectedOpenAIAccounts.length} connected account${Number(signedIn) + connectedOpenAIAccounts.length === 1 ? "" : "s"}`,
    permissions: `${settings.permissionMode} · ${settings.rules.length} rule${settings.rules.length === 1 ? "" : "s"}`,
    interface: `${Math.round(uiScale * 100)}% · ${ambientRain || scanlines ? "effects on" : "effects off"}`,
    system: remoteMode
      ? `reports ${crashReporting === true ? "on" : "off"}`
      : update.phase === "available"
        ? `v${update.info?.version ?? "new"} available`
        : `${settings.autoUpdate ? "auto update" : "manual update"} · reports ${crashReporting === true ? "on" : "off"}`,
    devices: `${phoneSync?.paired.length ?? 0} paired`,
  };

  const navigateToSection = (id: SettingsSectionId) => {
    // A smooth programmatic scroll crosses the sections between the current and
    // requested destinations. Do not let those intermediate scroll positions
    // steal the active marker from the route the user just selected.
    navigatingRef.current = true;
    if (navigationTimerRef.current !== null) clearTimeout(navigationTimerRef.current);
    navigationTimerRef.current = setTimeout(() => {
      navigatingRef.current = false;
      navigationTimerRef.current = null;
    }, 700);
    setActiveSection(id);
    sectionRefs.current[id]?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  const onContentScroll = () => {
    const content = contentRef.current;
    if (!content || searchQuery || navigatingRef.current) return;
    const threshold = content.scrollTop + 120;
    let current = availableSections[0]?.id;
    for (const section of availableSections) {
      const node = sectionRefs.current[section.id];
      if (node && !node.classList.contains("hidden") && node.offsetTop <= threshold) {
        current = section.id;
      }
    }
    if (current) setActiveSection(current);
  };

  useEffect(() => {
    if (!searchQuery || visibleSectionIds.has(activeSection)) return;
    const first = visibleSections[0];
    if (first) setActiveSection(first.id);
  }, [activeSection, searchQuery, visibleSectionIds, visibleSections]);

  useEffect(() => {
    searchTargetRef.current?.classList.remove("pc-settings-target");
    searchTargetRef.current = null;
    if (!activeSearchMatch?.targetId) return;
    const target = document.getElementById(activeSearchMatch.targetId);
    if (!target || target.classList.contains("hidden")) return;
    target.classList.add("pc-settings-target");
    target.scrollIntoView?.({ behavior: "smooth", block: "center" });
    searchTargetRef.current = target;
    return () => target.classList.remove("pc-settings-target");
  }, [activeSearchMatch]);

  // Close on Escape, mirroring CommandPalette/PermissionPrompt's keyboard affordance.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setShowSettings(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setShowSettings]);

  // Move focus into the dialog on open and restore it to the opener on close, so a
  // keyboard user isn't left on a background control behind the scrim.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const modal = modalRef.current;
    const first = modal?.querySelector<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    );
    (first ?? modal)?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  // Clear the "Saved" toast timer on unmount so it can't update state after close.
  useEffect(() => {
    return () => {
      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
      if (navigationTimerRef.current !== null) clearTimeout(navigationTimerRef.current);
    };
  }, []);

  // Replay the one-shot pc-flash on the SAME Save node when a save succeeds —
  // restart the CSS animation by toggling the class across a forced reflow rather
  // than remounting via a React key, which would drop focus out of the focus trap.
  useEffect(() => {
    if (!savedKey) return;
    replayFlash(saveBtnRef.current);
  }, [savedKey]);

  // Trap Tab within the dialog: query focusable descendants live (sections toggle
  // `hidden` in remoteMode), skip hidden ones, and wrap at the first/last element.
  const onModalKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab") return;
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = Array.from(
      modal.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const firstEl = focusable[0];
    const lastEl = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === firstEl || !active || !focusable.includes(active)) {
        e.preventDefault();
        lastEl.focus();
      }
    } else if (active === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      setKeyError(null);
      await ipc.setApiKey(apiKey.trim());
      // The credential write is the commit point. Drop the raw secret before any
      // follow-up work, then refresh the derived apiKeySet flag from the native
      // credential store. A read failure cannot roll the committed credential
      // back, so keep the UI conservative and mark the key present locally.
      setApiKey("");
      try {
        useStore.setState({ settings: await ipc.getSettings() });
      } catch {
        useStore.setState((state) => ({
          settings: { ...state.settings, apiKeySet: true },
        }));
      }
      setSavedKey(true);
      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedKey(false), 1800);
    } catch (err) {
      // Only the credential write itself can fail this operation. Until it
      // succeeds, retain the typed value so the user can retry.
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const signIn = async () => {
    setSigningIn(true);
    try {
      await loginWithClaude();
    } finally {
      setSigningIn(false);
    }
  };

  const signInOpenAI = async () => {
    setSigningInOpenAI(true);
    try {
      await loginWithOpenAI();
    } finally {
      setSigningInOpenAI(false);
    }
  };

  const reconnectOpenAI = async (accountProfileId: string) => {
    setOpenAIAccountAction(`reconnect:${accountProfileId}`);
    try {
      await reconnectOpenAIAccount(accountProfileId);
    } finally {
      setOpenAIAccountAction(null);
    }
  };

  const removeOpenAI = async (accountProfileId: string) => {
    setOpenAIAccountAction(`remove:${accountProfileId}`);
    try {
      await removeOpenAIAccount(accountProfileId);
      setPendingOpenAIRemoval((current) => (current === accountProfileId ? null : current));
    } finally {
      setOpenAIAccountAction(null);
    }
  };

  const saveLabel = savedKey ? "Saved" : saving ? "…" : settings.apiKeySet ? "Replace" : "Save";

  return (
    <div
      className="pc-overlay pc-settings-overlay items-start justify-center z-[58] p-6"
      onClick={() => setShowSettings(false)}
    >
      <div
        className="pc-modal pc-settings-shell my-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pc-settings-title"
        tabIndex={-1}
        ref={modalRef}
        onKeyDown={onModalKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pc-sweep pc-sweep--accent" />

        {/* HEADER */}
        <div className="pc-settings-header">
          <div className="pc-settings-brand">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-accent-2"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>
              <span className="pc-settings-brand__overline">PORTCODE / CONTROL DECK</span>
              <span id="pc-settings-title" className="pc-settings-brand__title">
                SETTINGS
              </span>
            </span>
          </div>
          <button
            onClick={() => setShowSettings(false)}
            className="pc-settings-close"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        {/* BODY */}
        <div className="pc-settings-layout">
          <aside className="pc-settings-rail" aria-label="Settings categories">
            <div className="pc-settings-search">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.6-3.6" />
              </svg>
              <label htmlFor="pc-settings-search" className="sr-only">
                Find a setting
              </label>
              <input
                id="pc-settings-search"
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Find a setting…"
                autoComplete="off"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear settings search"
                >
                  ×
                </button>
              )}
            </div>

            <div className="pc-settings-search-status" aria-live="polite">
              {searchQuery
                ? `${visibleSections.length} categor${visibleSections.length === 1 ? "y" : "ies"} found`
                : "Navigate the control deck"}
            </div>

            <nav className="pc-settings-nav" aria-label="Settings map">
              {availableSections.map((section) => {
                const visible = visibleSectionIds.has(section.id);
                const matches = matchingSettingNames(section, searchQuery);
                return (
                  <button
                    key={section.id}
                    type="button"
                    className="pc-settings-nav__item"
                    data-active={activeSection === section.id ? "true" : undefined}
                    data-filtered={!visible ? "true" : undefined}
                    aria-label={section.label}
                    aria-current={activeSection === section.id ? "location" : undefined}
                    aria-controls={`pc-settings-${section.id}`}
                    onClick={() => navigateToSection(section.id)}
                  >
                    <span className="pc-settings-nav__route" aria-hidden="true">
                      <SettingsGlyph id={section.id} />
                    </span>
                    <span className="pc-settings-nav__copy">
                      <strong>{section.label}</strong>
                      <small>{matches[0] ?? sectionStatus[section.id]}</small>
                    </span>
                    <span className="pc-settings-nav__beacon" aria-hidden="true" />
                  </button>
                );
              })}
            </nav>

            <div className="pc-settings-rail__readout" aria-hidden="true">
              <span>LIVE CONFIG</span>
              <span>{ipc.isTauri() ? "NATIVE" : "PREVIEW"}</span>
            </div>
          </aside>

          <main ref={contentRef} className="pc-settings-content" onScroll={onContentScroll}>
            {settingsError && (
              <div className="pc-settings-global-error" role="alert">
                <span aria-hidden="true">!</span>
                <div>
                  <strong>Couldn't save settings</strong>
                  <p>{settingsError}</p>
                </div>
              </div>
            )}
            {searchQuery && visibleSections.length === 0 && (
              <div className="pc-settings-empty">
                <span aria-hidden="true">Ø</span>
                <strong>No setting found</strong>
                <p>Try “model”, “command”, “scanlines”, “reports”, or “phone”.</p>
                <button type="button" onClick={() => setSearchQuery("")}>
                  Clear search
                </button>
              </div>
            )}

            <div className="pc-settings-sections">
              {/* CLAUDE */}
              <section
                id="pc-settings-claude"
                ref={(node) => {
                  sectionRefs.current.claude = node;
                }}
                className={`pc-settings-section ${
                  remoteMode || !visibleSectionIds.has("claude") ? "hidden" : ""
                }`}
                onFocusCapture={() => setActiveSection("claude")}
              >
                <SettingsSectionHeader
                  eyebrow="ANTHROPIC"
                  title="Claude"
                  description="Claude models, Claude account access, and the Anthropic API key live here—nothing in this section is sent to OpenAI."
                  status={sectionStatus.claude}
                  statusTone={signedIn || settings.apiKeySet ? "success" : "cyan"}
                  tone="violet"
                />
                <div className="pc-settings-group pc-provider-section pc-provider-section--claude">
                  <ProviderBanner
                    provider="claude"
                    vendor="Anthropic"
                    title="Claude"
                    active={selectedProvider === "anthropic"}
                    model={selectedProvider === "anthropic" ? selectedModel?.label : undefined}
                  />
                  <div className="pc-provider-grid">
                    <div id="pc-setting-claude-model" className="pc-provider-card">
                      <div className="pc-provider-card__heading">
                        <span>Model</span>
                        <span>CLAUDE ONLY</span>
                      </div>
                      <label
                        htmlFor="pc-settings-claude-model"
                        className="mb-1.5 block text-[12.5px] font-medium text-fg"
                      >
                        Claude model for new sessions
                      </label>
                      <SelectMenu
                        id="pc-settings-claude-model"
                        label="Claude model for new sessions"
                        value={claudeModelValue}
                        onChange={(next) => void updateSettings({ model: next })}
                        className="w-full"
                        buttonClassName="px-3 py-2.5 text-[12.5px]"
                        groups={[
                          {
                            id: "claude-models",
                            options: [
                              {
                                value: "choose-claude",
                                label: "Choose a Claude model…",
                                disabled: true,
                              },
                              ...ANTHROPIC_MODELS.map((model) => ({
                                value: model.id,
                                label: model.label,
                              })),
                            ],
                          },
                        ]}
                      />
                      <p className="mt-1.5 text-[11px] text-faint">
                        Choosing a Claude model makes Anthropic the default for new chats.
                      </p>
                    </div>

                    <div id="pc-setting-claude" className="pc-provider-card">
                      <div className="pc-provider-card__heading">
                        <span>Account</span>
                        <span>CLAUDE PRO / MAX</span>
                      </div>
                      <h3>Claude subscription</h3>
                      {signedIn ? (
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-panel-2 px-3 py-2.5">
                          <div className="min-w-0 text-[12.5px]">
                            <div className="flex items-center gap-1.5">
                              <span className="pc-dot pc-dot--success" />
                              <span className="min-w-0 truncate text-fg">
                                Signed in{oauthStatus?.account ? ` as ${oauthStatus.account}` : ""}
                              </span>
                              {oauthStatus?.tier && (
                                <span
                                  title={oauthStatus.tier}
                                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider shadow-sm ${
                                    /max/i.test(oauthStatus.tier)
                                      ? "bg-gradient-to-r from-amber-300 to-amber-500 text-black"
                                      : "bg-gradient-to-r from-violet-400 to-indigo-500 text-white"
                                  }`}
                                >
                                  {oauthStatus.tier.replace(/^Claude\s+/, "")}
                                </span>
                              )}
                            </div>
                            {oauthStatus?.expiresAt != null && (
                              <div className="mt-0.5 text-[11px] text-muted">
                                Access expires {formatExpiry(oauthStatus.expiresAt)}
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            aria-label="Log out of Claude"
                            onClick={() => void logoutClaude()}
                            className="shrink-0 rounded-lg border border-border bg-panel px-3 py-2 text-[12.5px] text-muted hover:text-fg"
                          >
                            Log out
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void signIn()}
                          disabled={signingIn}
                          className="pc-btn-accent w-full px-3 py-2.5 text-[12.5px] disabled:opacity-30"
                        >
                          {signingIn ? "Signing in…" : "Sign in with Claude"}
                        </button>
                      )}
                      {oauthError && (
                        <p className="mt-1.5 text-[11px] text-danger" role="alert">
                          Sign-in failed: {oauthError}
                        </p>
                      )}
                      <p className="mt-1.5 text-[11px] text-faint">
                        Uses your eligible Claude subscription instead of API billing.
                      </p>
                    </div>

                    <div
                      id="pc-setting-anthropic-api-key"
                      className="pc-provider-card pc-provider-card--wide"
                    >
                      <div className="pc-provider-card__heading">
                        <span>API credential</span>
                        <span>ANTHROPIC ONLY</span>
                      </div>
                      <label
                        htmlFor="pc-settings-apikey"
                        className="mb-1.5 block text-[12.5px] font-medium text-fg"
                      >
                        Anthropic API key
                      </label>
                      <div className="flex gap-2">
                        <input
                          id="pc-settings-apikey"
                          type="password"
                          value={apiKey}
                          onChange={(e) => {
                            setApiKey(e.target.value);
                            // Clear a stale "Couldn't save key" as the user corrects it.
                            if (keyError) setKeyError(null);
                          }}
                          placeholder={settings.apiKeySet ? "••••••••  (replace)" : "sk-ant-…"}
                          className="flex-1 rounded-lg border border-border bg-panel-2 px-3 py-2.5 font-mono text-[12.5px] text-muted outline-none transition-colors focus:border-accent/50 select-text"
                        />
                        <button
                          ref={saveBtnRef}
                          type="button"
                          onClick={() => void saveKey()}
                          disabled={saving || !apiKey.trim()}
                          className="pc-btn-accent px-4 py-2.5 text-[12.5px] disabled:opacity-30"
                        >
                          {saveLabel}
                        </button>
                      </div>
                      {keyError && (
                        <p className="mt-1.5 text-[11px] text-danger" role="alert">
                          Couldn't save key: {keyError}
                        </p>
                      )}
                      <span role="status" aria-live="polite" className="sr-only">
                        {savedKey ? "Anthropic API key saved" : ""}
                      </span>
                      <p className="mt-1.5 text-[11px] text-faint">
                        {signedIn
                          ? "Optional while signed in with Claude. Subscription access takes priority."
                          : settings.apiKeySet
                            ? "An Anthropic key is stored in Windows Credential Manager."
                            : "Stored in Windows Credential Manager and used only for Claude requests."}
                      </p>
                    </div>
                  </div>
                </div>
              </section>

              {/* OPENAI */}
              <section
                id="pc-settings-openai"
                ref={(node) => {
                  sectionRefs.current.openai = node;
                }}
                className={`pc-settings-section ${
                  remoteMode || !visibleSectionIds.has("openai") ? "hidden" : ""
                }`}
                onFocusCapture={() => setActiveSection("openai")}
              >
                <SettingsSectionHeader
                  eyebrow="OPENAI"
                  title="GPT / Codex"
                  description="OpenAI models, ChatGPT account access, and reasoning controls stay separate from Claude credentials."
                  status={sectionStatus.openai}
                  statusTone={signedInOpenAI ? "success" : "cyan"}
                />
                <div className="pc-settings-group pc-provider-section pc-provider-section--openai">
                  <ProviderBanner
                    provider="openai"
                    vendor="OpenAI"
                    title="GPT / Codex"
                    active={selectedProvider === "openai"}
                    model={selectedProvider === "openai" ? selectedModel?.label : undefined}
                  />

                  <div className="pc-provider-grid">
                    <div id="pc-setting-openai-model" className="pc-provider-card">
                      <div className="pc-provider-card__heading">
                        <span>Model</span>
                        <span>OPENAI ONLY</span>
                      </div>
                      <label
                        htmlFor="pc-settings-openai-model"
                        className="mb-1.5 block text-[12.5px] font-medium text-fg"
                      >
                        OpenAI model for new sessions
                      </label>
                      <SelectMenu
                        id="pc-settings-openai-model"
                        label="OpenAI model for new sessions"
                        value={openAIModelValue}
                        onChange={(next) => void updateSettings({ model: next })}
                        disabled={
                          !openAIAvailable ||
                          !defaultOpenAIAccount ||
                          openAIModelCatalogs[defaultOpenAIAccount.id]?.status !== "ready"
                        }
                        className="w-full"
                        buttonClassName="px-3 py-2.5 text-[12.5px]"
                        groups={[
                          {
                            id: "openai-models",
                            options: [
                              {
                                value: "choose-openai",
                                label: "Choose a GPT model…",
                                disabled: true,
                              },
                              ...defaultOpenAIModels.map((model) => ({
                                value: model.id,
                                label: model.label,
                              })),
                            ],
                          },
                        ]}
                      />
                      <p className="mt-1.5 text-[11px] text-faint">
                        {!openAIAvailable
                          ? (openAIAuthStatus?.unavailableReason ??
                            "ChatGPT subscription access is unavailable in this build.")
                          : !defaultOpenAIAccount
                            ? "Add a ChatGPT account to load its model catalogue."
                            : openAIModelCatalogs[defaultOpenAIAccount.id]?.status === "loading"
                              ? `Loading models for ${openAIAccountLabel(defaultOpenAIAccount, openAIAccounts)}…`
                              : openAIModelCatalogs[defaultOpenAIAccount.id]?.status === "error"
                                ? (openAIModelCatalogs[defaultOpenAIAccount.id]?.error ??
                                  "This account's model catalogue is unavailable.")
                                : `Models for ${openAIAccountLabel(defaultOpenAIAccount, openAIAccounts)}. Choosing one makes OpenAI the default for new chats.`}
                      </p>
                    </div>

                    <div id="pc-setting-openai-reasoning" className="pc-provider-card">
                      <div className="pc-provider-card__heading">
                        <span>Model behavior</span>
                        <span>GPT / CODEX</span>
                      </div>
                      <label
                        htmlFor="pc-settings-reasoning"
                        className="mb-1.5 block text-[12.5px] font-medium text-fg"
                      >
                        Reasoning level
                      </label>
                      {selectedProvider === "openai" && reasoningEfforts.length > 0 ? (
                        <SelectMenu
                          id="pc-settings-reasoning"
                          label="Reasoning level"
                          value={settings.reasoningEffort}
                          onChange={(next) => void updateSettings({ reasoningEffort: next })}
                          className="w-full"
                          buttonClassName="px-3 py-2.5 text-[12.5px]"
                          groups={[
                            {
                              id: "reasoning",
                              options: reasoningEfforts.map((effort) => ({
                                value: effort,
                                label: reasoningEffortLabel(effort),
                              })),
                            },
                          ]}
                        />
                      ) : (
                        <div className="pc-provider-empty-control">
                          Choose a GPT model to configure reasoning.
                        </div>
                      )}
                      <p className="mt-1.5 text-[11px] text-faint">
                        Available levels come from the selected OpenAI model.
                      </p>
                    </div>

                    <div id="pc-setting-openai" className="pc-provider-card pc-provider-card--wide">
                      <div className="pc-provider-card__heading">
                        <span>Authentication</span>
                        <span>CHATGPT SUBSCRIPTION</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <h3>ChatGPT accounts</h3>
                        {openAIAvailable && (
                          <button
                            type="button"
                            onClick={() => void signInOpenAI()}
                            disabled={signingInOpenAI || openAIAccountAction !== null}
                            className="pc-settings-action"
                          >
                            {signingInOpenAI ? "Adding…" : "+ Add account"}
                          </button>
                        )}
                      </div>
                      {!openAIAvailable && (
                        <div className="pc-openai-capability-notice" role="status">
                          <strong>New ChatGPT connections are disabled</strong>
                          <span>
                            {openAIAuthStatus?.unavailableReason ??
                              "ChatGPT subscription access is unavailable in this build."}
                            {openAIAccounts.length > 0
                              ? " Existing credentials can still be removed below."
                              : ""}
                          </span>
                        </div>
                      )}
                      {openAIAccountsLoading && openAIAccounts.length === 0 ? (
                        <div className="pc-openai-account-empty" role="status">
                          Loading ChatGPT accounts…
                        </div>
                      ) : openAIAccountsError && openAIAccounts.length === 0 ? (
                        <div className="pc-openai-account-empty" role="alert">
                          <strong>Couldn’t load ChatGPT accounts</strong>
                          <span>{openAIAccountsError}</span>
                          <button type="button" onClick={() => void refreshOpenAIStatus()}>
                            Retry account discovery
                          </button>
                        </div>
                      ) : openAIAccounts.length === 0 ? (
                        <div className="pc-openai-account-empty">
                          <strong>No ChatGPT accounts connected</strong>
                          <span>
                            Add an eligible ChatGPT subscription account to create GPT chats.
                          </span>
                        </div>
                      ) : (
                        <>
                          {reconnectOnlyOpenAI && (
                            <div className="pc-openai-capability-notice" role="status">
                              <strong>No connected ChatGPT account</strong>
                              <span>
                                Reconnect a saved profile below; history remains readable.
                              </span>
                            </div>
                          )}
                          <div className="pc-openai-account-list" aria-label="ChatGPT accounts">
                            {openAIAccounts.map((account) => {
                              const reconnecting =
                                openAIAccountAction === `reconnect:${account.id}`;
                              const removing = openAIAccountAction === `remove:${account.id}`;
                              const confirmingRemoval = pendingOpenAIRemoval === account.id;
                              const connected = account.state === "connected";
                              const displayLabel = openAIAccountLabel(account, openAIAccounts);
                              const stateLabel = connected
                                ? "Connected"
                                : account.state === "reconnect_required"
                                  ? "Reconnect required"
                                  : account.state === "removed"
                                    ? "Removed · history retained"
                                    : "Unavailable";
                              return (
                                <div key={account.id} className="pc-openai-account-row">
                                  <div className="pc-openai-account-row__identity">
                                    <div>
                                      <span
                                        className={`pc-dot ${connected ? "pc-dot--success" : "pc-dot--warn"}`}
                                        aria-hidden="true"
                                      />
                                      <strong title={displayLabel}>{displayLabel}</strong>
                                      {account.tier && (
                                        <span className="pc-openai-account-tier">
                                          {account.tier.replace(/^ChatGPT\s+/i, "")}
                                        </span>
                                      )}
                                    </div>
                                    <small>
                                      {stateLabel}
                                      {account.expiresAt != null
                                        ? ` · access expires ${formatExpiry(account.expiresAt)}`
                                        : ""}
                                    </small>
                                  </div>
                                  <div className="pc-openai-account-row__actions">
                                    {confirmingRemoval ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => setPendingOpenAIRemoval(null)}
                                          disabled={removing}
                                        >
                                          Cancel
                                        </button>
                                        <button
                                          type="button"
                                          className="is-danger"
                                          onClick={() => void removeOpenAI(account.id)}
                                          disabled={removing}
                                          aria-label={`Confirm remove ${displayLabel}`}
                                        >
                                          {removing ? "Removing…" : "Confirm remove"}
                                        </button>
                                      </>
                                    ) : (
                                      <>
                                        {!connected && openAIAvailable && (
                                          <button
                                            type="button"
                                            onClick={() => void reconnectOpenAI(account.id)}
                                            disabled={openAIAccountAction !== null}
                                            aria-label={`Reconnect ${displayLabel}`}
                                          >
                                            {reconnecting ? "Reconnecting…" : "Reconnect"}
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() => setPendingOpenAIRemoval(account.id)}
                                          disabled={openAIAccountAction !== null}
                                          aria-label={`Remove ${displayLabel}`}
                                        >
                                          Remove
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          {openAIReconnectMismatch && (
                            <div className="pc-openai-capability-notice" role="alert">
                              <strong>Different ChatGPT account detected</strong>
                              <span>
                                {openAIReconnectMismatch.message} The original profile
                                {reconnectMismatchAccount && (
                                  <>
                                    {" ("}
                                    {openAIAccountLabel(reconnectMismatchAccount, openAIAccounts)}
                                    {")"}
                                  </>
                                )}{" "}
                                was unchanged.
                              </span>
                              <button
                                type="button"
                                onClick={() => void signInOpenAI()}
                                disabled={signingInOpenAI || openAIAccountAction !== null}
                              >
                                {signingInOpenAI ? "Adding…" : "Add as separate account"}
                              </button>
                            </div>
                          )}
                        </>
                      )}
                      {openAIAccountsError && openAIAccounts.length > 0 && (
                        <div className="pc-openai-accounts-error" role="alert">
                          <span>Couldn’t refresh accounts: {openAIAccountsError}</span>
                          <button type="button" onClick={() => void refreshOpenAIStatus()}>
                            Retry
                          </button>
                        </div>
                      )}
                      {openAIAuthError && (
                        <p className="mt-1.5 text-[11px] text-danger" role="alert">
                          ChatGPT accounts: {openAIAuthError}
                        </p>
                      )}
                      <p className="mt-1.5 text-[11px] text-faint">
                        Uses models included with your eligible ChatGPT subscription.
                      </p>
                      <div id="pc-setting-openai-auth-note" className="pc-provider-boundary">
                        <strong>OpenAI API keys are not used by this integration.</strong>
                        <span>
                          OpenAI authenticates through ChatGPT sign-in. Your Anthropic key is never
                          sent to OpenAI.
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* PLAN USAGE */}
              <section
                id="pc-settings-usage"
                ref={(node) => {
                  sectionRefs.current.usage = node;
                }}
                className={`pc-settings-section ${
                  remoteMode || !visibleSectionIds.has("usage") ? "hidden" : ""
                }`}
                onFocusCapture={() => setActiveSection("usage")}
              >
                <SettingsSectionHeader
                  eyebrow="PLAN ALLOWANCE"
                  title="Plan usage"
                  description="See the included allowance reported by Claude and GPT in one place. Percentages use one shared meaning: capacity remaining."
                  status={sectionStatus.usage}
                  statusTone={signedIn || signedInOpenAI ? "success" : "cyan"}
                  tone="cyan"
                />
                <div
                  id="pc-setting-plan-usage"
                  className="pc-settings-group pc-settings-group--usage"
                >
                  <PlanUsagePanel />
                </div>
              </section>

              {/* PERMISSIONS */}
              <section
                id="pc-settings-permissions"
                ref={(node) => {
                  sectionRefs.current.permissions = node;
                }}
                className={`pc-settings-section ${
                  remoteMode || !visibleSectionIds.has("permissions") ? "hidden" : ""
                }`}
                onFocusCapture={() => setActiveSection("permissions")}
              >
                <SettingsSectionHeader
                  eyebrow="PERMISSIONS"
                  title="Permissions & safety"
                  description="Set the agent's operating posture, then add precise exceptions where needed."
                  status={sectionStatus.permissions}
                  statusTone={DANGER_MODES.includes(settings.permissionMode) ? "danger" : "warn"}
                  tone="amber"
                />
                <div className="pc-settings-group pc-settings-group--permissions">
                  <PermissionSettings />
                </div>
              </section>

              {/* APPEARANCE */}
              <section
                id="pc-settings-interface"
                ref={(node) => {
                  sectionRefs.current.interface = node;
                }}
                className={`pc-settings-section ${
                  !visibleSectionIds.has("interface") ? "hidden" : ""
                }`}
                onFocusCapture={() => setActiveSection("interface")}
              >
                <SettingsSectionHeader
                  eyebrow="APPEARANCE"
                  title="Interface"
                  description="Tune visual density, response motion, and the ambient layer around your work."
                  status={sectionStatus.interface}
                  statusTone="cyan"
                  tone="violet"
                />
                <div className="pc-settings-group pc-settings-group--rows">
                  <ToggleRow
                    id="pc-setting-typing"
                    label="Typing animation"
                    hint="Reveal replies with a terminal-style typing effect."
                    on={settings.typingAnimation}
                    onToggle={() =>
                      void updateSettings({ typingAnimation: !settings.typingAnimation })
                    }
                  />
                  <ToggleRow
                    id="pc-setting-rain"
                    label="Neon rain"
                    hint="Ambient cyberpunk backdrop behind the app. Decorative only."
                    on={ambientRain}
                    onToggle={() => setAmbientRain(!ambientRain)}
                  />
                  <ToggleRow
                    id="pc-setting-scanlines"
                    label="Scanlines"
                    hint="CRT-style scanline overlay and vignette."
                    on={scanlines}
                    onToggle={() => setScanlines(!scanlines)}
                  />
                  <ScaleRow id="pc-setting-scale" value={uiScale} onSelect={setUiScale} />
                </div>
              </section>

              {/* PRIVACY */}
              <section
                id="pc-settings-system"
                ref={(node) => {
                  sectionRefs.current.system = node;
                }}
                className={`pc-settings-section ${
                  !visibleSectionIds.has("system") ? "hidden" : ""
                }`}
                onFocusCapture={() => setActiveSection("system")}
              >
                <SettingsSectionHeader
                  eyebrow="PRIVACY"
                  title={remoteMode ? "Privacy" : "Privacy & updates"}
                  description={
                    remoteMode
                      ? "Control anonymous diagnostics for this interface."
                      : "Control diagnostics and decide when Portcode changes under your feet."
                  }
                  status={sectionStatus.system}
                  statusTone={
                    update.phase === "error"
                      ? "danger"
                      : update.phase === "available"
                        ? "warn"
                        : "cyan"
                  }
                  tone="violet"
                />
                <div className="pc-settings-system-grid">
                  {!remoteMode && (
                    <div
                      id="pc-setting-auto-update"
                      className="pc-settings-group pc-settings-group--rows"
                    >
                      <div className="pc-settings-group__label">APP UPDATES</div>
                      <ToggleRow
                        label="Automatic updates"
                        hint="Download and install new versions automatically, then prompt to relaunch."
                        on={settings.autoUpdate}
                        onToggle={() => void setAutoUpdate(!settings.autoUpdate)}
                      />
                      <div id="pc-setting-update-check" className="pc-setting-row">
                        <div>
                          <div className="text-[12.5px] font-medium text-fg">Check for updates</div>
                          <div className="mt-0.5 text-[11px] text-faint" aria-live="polite">
                            {checkingForUpdate
                              ? "Checking for updates…"
                              : update.phase === "available"
                                ? `Update available · v${update.info?.version ?? ""}`
                                : update.phase === "downloading"
                                  ? "Downloading update…"
                                  : update.phase === "ready"
                                    ? "Update ready — relaunch to apply"
                                    : update.phase === "error"
                                      ? "Last check failed — try again"
                                      : update.error
                                        ? "Last check failed — try again"
                                        : "You're on the latest version."}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setCheckingForUpdate(true);
                            void checkForUpdate().finally(() => setCheckingForUpdate(false));
                          }}
                          disabled={
                            checkingForUpdate ||
                            update.phase === "downloading" ||
                            update.phase === "ready"
                          }
                          className="pc-settings-action"
                        >
                          {checkingForUpdate ? "Checking…" : "Check now"}
                        </button>
                      </div>
                    </div>
                  )}
                  <div
                    id="pc-setting-diagnostics"
                    className="pc-settings-group pc-settings-group--rows"
                  >
                    <div className="pc-settings-group__label">ANONYMOUS DIAGNOSTICS</div>
                    <ToggleRow
                      label="Crash & performance reports"
                      hint="Send anonymous, scrubbed crash + basic performance reports — never your prompts, code, files, or keys. Off by default."
                      on={crashReporting === true}
                      onToggle={() => setCrashReporting(crashReporting !== true)}
                    />
                    <div className="pc-settings-privacy-note">
                      <span aria-hidden="true">◇</span>
                      Prompts, code, files, and credentials never leave through diagnostics.
                    </div>
                  </div>
                </div>
              </section>

              {/* PHONE SYNC */}
              <section
                id="pc-settings-devices"
                ref={(node) => {
                  sectionRefs.current.devices = node;
                }}
                className={`pc-settings-section ${
                  remoteMode || !visibleSectionIds.has("devices") ? "hidden" : ""
                }`}
                onFocusCapture={() => setActiveSection("devices")}
              >
                <SettingsSectionHeader
                  eyebrow="PHONE SYNC"
                  title="Phone & devices"
                  description="Extend this desktop to a trusted phone, then revoke access at any time."
                  status={sectionStatus.devices}
                  statusTone={phoneSync?.paired.length ? "success" : "cyan"}
                />
                <div className="pc-settings-group flex flex-col gap-3.5">
                  {phoneSync && (
                    <div id="pc-setting-device-identity">
                      <label className="mb-1.5 block text-[12.5px] font-medium text-fg">
                        This device
                      </label>
                      <div className="rounded-lg border border-border bg-panel-2 px-3 py-2.5 font-mono text-[11.5px] text-muted select-text">
                        {truncateKey(phoneSync.devicePublicKey)}
                      </div>
                    </div>
                  )}

                  {phoneSync && phoneSync.paired.length > 0 && (
                    <div id="pc-setting-paired-phones">
                      <label className="mb-1.5 block text-[12.5px] font-medium text-fg">
                        Paired phones
                      </label>
                      <div className="flex flex-col gap-1.5">
                        {phoneSync.paired.map((device) => (
                          <div
                            key={device.publicKey}
                            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-panel-2 px-3 py-2"
                          >
                            <div className="min-w-0 text-[12.5px]">
                              <div className="flex items-center gap-1.5">
                                <span className="pc-dot pc-dot--success" />
                                <span className="min-w-0 truncate text-fg">{device.name}</span>
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] text-muted">
                                {truncateKey(device.publicKey)}
                              </div>
                            </div>
                            <button
                              onClick={() => void unpair(device.publicKey)}
                              className="shrink-0 rounded-lg border border-border bg-panel px-3 py-2 text-[12.5px] text-muted hover:text-danger"
                              aria-label={`Unpair ${device.name}`}
                            >
                              Unpair
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Device-trust gate: a phone completed the handshake and is waiting
                  for this desktop user to compare its SAS and confirm. Until the
                  user confirms, the phone is served NOTHING. */}
                  {pairingRequest && (
                    <PairingConfirm
                      request={pairingRequest}
                      onConfirm={() => void confirmPairingRequest()}
                      onReject={() => void rejectPairingRequest()}
                    />
                  )}

                  <div id="pc-setting-phone-pairing">
                    {pairingPayload ? (
                      <PairingCode payload={pairingPayload} onDone={clearPairing} />
                    ) : (
                      <button
                        onClick={() => void beginPairing()}
                        className="pc-btn-accent w-full px-3 py-2.5 text-[12.5px]"
                      >
                        Pair a phone
                      </button>
                    )}
                  </div>
                  {pairingError && (
                    <p className="mt-1.5 text-[11px] text-danger" role="alert">
                      Pairing failed: {pairingError}
                    </p>
                  )}
                </div>
              </section>
            </div>
          </main>
        </div>

        {/* FOOTER */}
        <div className="pc-settings-footer">
          <span className="text-muted">CHANGES SAVE AS YOU WORK</span>
          <span className="text-warn">{ipc.isTauri() ? "NATIVE CORE" : "PREVIEW (BROWSER)"}</span>
        </div>
      </div>
    </div>
  );
}

function ProviderBanner({
  provider,
  vendor,
  title,
  active,
  model,
}: {
  provider: "claude" | "openai";
  vendor: string;
  title: string;
  active: boolean;
  model?: string;
}) {
  return (
    <div className={`pc-provider-banner pc-provider-banner--${provider}`}>
      <div className="pc-provider-mark" aria-hidden="true">
        {provider === "claude" ? "C" : "O"}
      </div>
      <div className="pc-provider-banner__copy">
        <span>{vendor}</span>
        <strong>{title}</strong>
        <small>{model ?? "Choose a model to make this provider the default"}</small>
      </div>
      <div className={`pc-provider-state ${active ? "pc-provider-state--active" : ""}`}>
        <span className={`pc-dot ${active ? "pc-dot--success" : "pc-dot--cyan"}`} />
        {active ? "Default for new chats" : "Available"}
      </div>
    </div>
  );
}

function SettingsSectionHeader({
  eyebrow,
  title,
  description,
  status,
  statusTone = "cyan",
  tone = "cyan",
}: {
  eyebrow: string;
  title: string;
  description: string;
  status: string;
  statusTone?: "cyan" | "success" | "warn" | "danger";
  tone?: "cyan" | "violet" | "amber";
}) {
  return (
    <header className={`pc-settings-section-head pc-settings-section-head--${tone}`}>
      <div className="pc-settings-section-head__copy">
        <div className="pc-eyebrow">{eyebrow}</div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="pc-settings-section-head__status">
        <span className={`pc-dot pc-dot--${statusTone}`} />
        <span>{status}</span>
      </div>
    </header>
  );
}

function SettingsGlyph({ id }: { id: SettingsSectionId }) {
  const paths: Record<SettingsSectionId, ReactNode> = {
    claude: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" />
      </>
    ),
    openai: (
      <>
        <path d="M8.2 4.6A5.1 5.1 0 0 1 17 8.1a5.1 5.1 0 0 1-1.3 9.8 5.1 5.1 0 0 1-8.8-3.5A5.1 5.1 0 0 1 8.2 4.6Z" />
        <path d="m8.2 4.6 7.5 4.3v9m1.3-9.8-7.5 4.3-2.6 2m8.8 3.5-7.5-4.3v-9" />
      </>
    ),
    usage: (
      <>
        <path d="M4 19V9m5 10V5m5 14v-7m5 7V3" />
        <path d="M3 19.5h18" />
      </>
    ),
    permissions: (
      <path d="M12 3 5.5 6v5.2c0 4.2 2.7 7.9 6.5 9.8 3.8-1.9 6.5-5.6 6.5-9.8V6L12 3Zm-2.3 9 1.6 1.6 3.4-3.6" />
    ),
    interface: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-4v4M7 8h4m-4 4h8" />
      </>
    ),
    system: (
      <>
        <path d="M12 3a9 9 0 1 0 9 9" />
        <path d="M12 7v5l3 2M16 3h5v5" />
      </>
    ),
    devices: (
      <>
        <rect x="7" y="2.5" width="10" height="19" rx="2" />
        <path d="M10 5h4m-3 13h2" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      {paths[id]}
    </svg>
  );
}

/** Restart the one-shot pc-flash on a persistent node: drop the class, force a
 *  reflow so the browser registers the removal, then re-add it. Replays the CSS
 *  animation without remounting (which would yank focus out of the focus trap). */
function replayFlash(node: HTMLElement | null) {
  if (!node) return;
  node.classList.remove("pc-flash");
  void node.offsetWidth; // force reflow so the re-added class restarts the animation
  node.classList.add("pc-flash");
}

/** Show only the first 8 and last 4 chars of a base64 key to keep the UI compact. */
function truncateKey(key: string): string {
  if (key.length <= 16) return key;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function formatExpiry(expiresAt: number): string {
  // expiresAt is a unix timestamp in seconds.
  return new Date(expiresAt * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** The device-trust confirmation prompt: a phone completed the Noise handshake
 *  inside an open pairing window and is awaiting this desktop user's approval. The
 *  user compares this SAS with the one shown on the phone; only on Confirm is the
 *  phone persisted as trusted and served the command surface. This is the gate that
 *  closes the "handshake == authorized" hole — without it, the phone gets nothing. */
function PairingConfirm({
  request,
  onConfirm,
  onReject,
}: {
  request: PairingRequest;
  onConfirm: () => void;
  onReject: () => void;
}) {
  // Land focus on the SAS, NOT the affirmative Confirm — a queued/habitual Enter
  // must not approve a device before the user actually compares codes (mirrors the
  // phone-side VerifyPanel in RemotePairing).
  const sasRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sasRef.current?.focus();
  }, []);

  return (
    <div
      className="rounded-xl border border-accent/40 bg-panel-2 p-4 shadow-[0_0_24px_rgba(255,46,126,0.16)]"
      role="group"
      aria-label="Confirm new phone pairing"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="pc-dot pc-dot--cyan" />
        <span className="font-mono text-[11px] uppercase tracking-[1.5px] text-accent-2">
          New phone pairing
        </span>
      </div>
      <p className="mb-3 text-[12px] leading-[1.5] text-muted">
        A phone is trying to pair. Compare this code with the one on the phone — they must match
        before you allow it to control this desktop.
      </p>
      <div
        ref={sasRef}
        tabIndex={-1}
        aria-label={`Pairing verification code: ${request.sas}`}
        className="rounded-lg border border-accent/40 bg-panel px-4 py-4 text-center outline-none"
      >
        <div className="select-text break-all font-mono text-[22px] font-bold leading-tight tracking-[3px] text-accent-2">
          {request.sas}
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={onConfirm} className="pc-btn-accent flex-1 px-3 py-2.5 text-[12.5px]">
          Codes match — Allow
        </button>
        <button
          onClick={onReject}
          className="flex-1 rounded-lg border border-border bg-panel px-3 py-2.5 text-[12.5px] text-muted transition-colors hover:border-danger/50 hover:text-danger"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

/** The desktop pairing affordance: the live PairingPayload rendered as a scannable
 *  QR (the phone scans it) with a copyable text fallback for manual entry. The QR
 *  encodes the exact JSON `phone_sync_connect` parses, so a scan dials directly. */
function PairingCode({ payload, onDone }: { payload: PairingPayload; onDone: () => void }) {
  const json = JSON.stringify(payload);
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyBtnRef = useRef<HTMLButtonElement | null>(null);

  // Clear the "Copied ✓" reset timer on unmount. PairingCode is dismissed (Done)
  // well within the 1.5s window, so an uncleared timer would setState after unmount.
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // Replay the one-shot pc-flash on the SAME Copy node when a copy succeeds,
  // restarting the CSS animation without remounting (which would drop focus).
  useEffect(() => {
    if (!copied) return;
    replayFlash(copyBtnRef.current);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (no permission / older webview); the raw text
      // below is always selectable as a fallback.
    }
  };

  return (
    <div>
      <label className="mb-1.5 block text-[12.5px] font-medium text-fg">Pairing code</label>
      <p className="mb-3 text-[11px] leading-[1.5] text-faint">
        On your phone, open Portcode and tap <span className="text-muted">Scan QR</span>, then point
        the camera at this code.
      </p>

      <div className="flex flex-col items-center gap-3">
        {/* Dark-on-white: cameras read high-contrast QRs most reliably, regardless
            of the app's dark theme. */}
        <div
          className="rounded-xl border border-accent/40 bg-white p-3 shadow-[0_0_24px_rgba(255,46,126,0.18)]"
          data-testid="pairing-qr"
        >
          <QRCodeSVG
            value={json}
            size={256}
            level="M"
            marginSize={4}
            bgColor="#ffffff"
            fgColor="#0a0a12"
            title="Portcode pairing QR code"
          />
        </div>

        <div className="flex w-full items-center gap-2">
          <button
            ref={copyBtnRef}
            onClick={() => void copy()}
            className="flex-1 rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12.5px] text-fg transition-colors hover:border-accent/50"
          >
            {copied ? "Copied ✓" : "Copy code"}
          </button>
          <button
            onClick={onDone}
            className="flex-1 rounded-lg border border-border bg-panel px-3 py-2 text-[12.5px] text-muted hover:text-fg"
          >
            Done
          </button>
        </div>
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? "Pairing code copied" : ""}
        </span>

        <button
          onClick={() => setShowRaw((v) => !v)}
          className="self-start text-[11px] text-faint underline-offset-2 hover:text-muted hover:underline"
          aria-expanded={showRaw}
        >
          {showRaw ? "Hide pairing code" : "Can’t scan? Show pairing code"}
        </button>
        {showRaw && (
          <div className="w-full rounded-lg border border-border bg-panel-2 px-3 py-2.5 font-mono text-[10.5px] leading-[1.5] text-accent-2 select-text break-all">
            {json}
          </div>
        )}
      </div>
    </div>
  );
}

/** The selectable interface-scale presets (a frontend-only `document.zoom`).
 *  Kept small + named so the picker reads as discrete steps, not a free slider. */
const UI_SCALES: { value: number; label: string }[] = [
  { value: 0.9, label: "Compact" },
  { value: 1, label: "Default" },
  { value: 1.1, label: "Comfortable" },
  { value: 1.25, label: "Large" },
];

/** Interface-scale row: a segmented set of preset buttons wired to the store's
 *  uiScale/setUiScale. The active option is indicated with aria-pressed (not by
 *  colour alone) so it's conveyed to assistive tech and high-contrast users. */
function ScaleRow({
  id,
  value,
  onSelect,
}: {
  id?: string;
  value: number;
  onSelect: (n: number) => void;
}) {
  return (
    <div id={id} className="pc-setting-block flex flex-col gap-2 py-1.5">
      <div>
        <div className="text-[12.5px] font-medium text-fg">Interface scale</div>
        <div className="text-[11px] text-faint mt-0.5">
          Resize the whole interface for comfort or density.
        </div>
      </div>
      <div role="group" aria-label="Interface scale" className="pc-scale-grid flex gap-2">
        {UI_SCALES.map((s) => {
          const active = value === s.value;
          return (
            <button
              key={s.value}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(s.value)}
              className={`flex-1 rounded-lg border px-2 py-2 text-[12px] transition-colors ${
                active
                  ? "border-accent-2/50 bg-accent-2/10 text-accent-2"
                  : "border-border bg-panel-2 text-muted hover:border-accent-2/40"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Only tools that can reach the permission gate belong here. Read-only and
// delegation rules would never fire, so offering them would imply protection
// the core does not need or apply.
const PERM_TOOLS = ["write_file", "edit_file", "run_command", "*"] as const;

const MODE_INFO: Record<PermissionMode, { label: string; hint: string }> = {
  default: {
    label: "Default",
    hint: "Use the policy below for configurable actions; protected actions always ask once.",
  },
  acceptEdits: {
    label: "Accept edits",
    hint: "Auto-allow file changes; protected actions always ask once.",
  },
  plan: { label: "Plan", hint: "Read-only — deny every mutating tool." },
  auto: {
    label: "Auto",
    hint: "Auto-allow configurable actions; protected actions always ask once.",
  },
  bypass: {
    label: "Bypass",
    hint: "Skip prompts and rules for configurable actions; protected actions always ask once.",
  },
};
const MODE_ORDER: PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypass"];

/**
 * The permission mode + per-tool/command rule editor. auto/bypass require an
 * explicit danger acknowledgment to engage. New command Allow rules are blocked;
 * the core also enforces that protected actions can only be approved one time.
 */
function PermissionSettings() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const permissionModeLocked = useStore((s) =>
    Object.values(s.runs).some(
      (run) => run.streaming || run.finalizing || run.pendingPermission !== null,
    ),
  );
  // Permission config is a desktop-side setting; on the phone the section is
  // hidden (the phone observes the active mode via the HUD but doesn't edit it).
  const remoteMode = useStore((s) => s.remoteMode);
  const mode = settings.permissionMode;
  const rules = settings.rules;

  const [confirmMode, setConfirmMode] = useState<PermissionMode | null>(null);
  const [confirmPolicy, setConfirmPolicy] = useState<ToolPolicy | null>(null);
  const [ruleTool, setRuleTool] = useState("run_command");
  const [ruleCommand, setRuleCommand] = useState("");
  const [ruleDecision, setRuleDecision] = useState<ToolPolicy>("ask");

  const pickMode = (m: PermissionMode) => {
    if (permissionModeLocked) return;
    if (DANGER_MODES.includes(m)) {
      setConfirmMode(m); // require an explicit acknowledgment before engaging
    } else {
      setConfirmMode(null);
      void updateSettings({ permissionMode: m });
    }
  };

  useEffect(() => {
    if (permissionModeLocked) setConfirmMode(null);
  }, [permissionModeLocked]);

  const pickPolicy = (policy: ToolPolicy) => {
    if (policy === "allow") {
      setConfirmPolicy(policy);
      return;
    }
    setConfirmPolicy(null);
    void updateSettings({ defaultPolicy: policy });
  };

  // A wildcard Allow still loosens every configurable action, so warn loudly.
  const overBroadAllow = ruleDecision === "allow" && ruleTool === "*";

  const addRule = () => {
    // Independent from the decision picker: stale state or a future UI refactor
    // still cannot create a new shell Allow rule.
    if (isCommandToolName(ruleTool) && ruleDecision === "allow") return;
    const command = isCommandToolName(ruleTool) && ruleCommand.trim() ? ruleCommand : undefined;
    const rule: Rule = command
      ? { tool: ruleTool, command, decision: ruleDecision }
      : { tool: ruleTool, decision: ruleDecision };
    const sameScope = (candidate: Rule) =>
      toolNamesEquivalent(candidate.tool, rule.tool) && candidate.command === rule.command;
    const existing = rules.find(sameScope);
    if (existing?.decision === rule.decision) return;

    const retained = rules.filter((candidate) => !sameScope(candidate));
    const shadows = (candidate: Rule) => {
      if (candidate.command !== undefined) {
        return (
          rule.command !== undefined &&
          (candidate.tool === "*" || toolNamesEquivalent(candidate.tool, rule.tool)) &&
          rule.command.startsWith(candidate.command)
        );
      }
      return candidate.tool === "*" || toolNamesEquivalent(candidate.tool, rule.tool);
    };
    const shadowingIndex = retained.findIndex(shadows);
    const insertionIndex = shadowingIndex === -1 ? retained.length : shadowingIndex;
    const nextRules = [
      ...retained.slice(0, insertionIndex),
      rule,
      ...retained.slice(insertionIndex),
    ];

    // Rules are first-match. A newly added rule must precede a broad wildcard or
    // tool/prefix rule that would otherwise shadow it. Broad rules stay after
    // existing exceptions, and replacing a scope never leaves an inert duplicate.
    void updateSettings({ rules: nextRules });
    setRuleCommand("");
  };

  const removeRule = (i: number) =>
    void updateSettings({ rules: rules.filter((_, idx) => idx !== i) });

  return (
    <div className={remoteMode ? "hidden" : undefined}>
      <div className="pc-settings-permission-intro">
        <span className={DANGER_MODES.includes(mode) ? "text-danger" : "text-accent-2"}>
          {DANGER_MODES.includes(mode) ? "CAUTION" : "CURRENT POSTURE"}
        </span>
        <strong>{MODE_INFO[mode].label}</strong>
        <p>{MODE_INFO[mode].hint}</p>
      </div>

      <div
        id="pc-setting-permission-mode"
        className="pc-permission-spectrum"
        aria-label="Permission mode"
      >
        {MODE_ORDER.map((m) => {
          const danger = DANGER_MODES.includes(m);
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => pickMode(m)}
              disabled={permissionModeLocked}
              title={
                permissionModeLocked
                  ? "Stop all active sessions before changing the global permission mode"
                  : MODE_INFO[m].hint
              }
              aria-pressed={active}
              className={`pc-permission-mode ${
                active
                  ? danger
                    ? "pc-permission-mode--active-danger"
                    : "pc-permission-mode--active"
                  : danger
                    ? "pc-permission-mode--danger"
                    : ""
              }`}
            >
              {danger ? "⚠ " : ""}
              {MODE_INFO[m].label}
            </button>
          );
        })}
      </div>
      {permissionModeLocked && (
        <p role="status" className="mt-1.5 text-[11px] text-warn">
          Permission mode is locked while a session is running or awaiting approval.
        </p>
      )}
      <p className="mt-1.5 text-[11px] text-faint">{MODE_INFO[mode].hint}</p>

      {confirmMode && (
        <div
          role="alert"
          className="mt-2 rounded-lg border border-danger/50 bg-danger/10 p-2.5 text-[11.5px] text-danger"
        >
          <p>
            ⚠ <strong className="capitalize">{MODE_INFO[confirmMode].label}</strong> lets the agent
            run configurable mutations without asking. Commands and other protected actions still
            require one-time approval. Only enable it if you trust the task.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                void updateSettings({ permissionMode: confirmMode });
                setConfirmMode(null);
              }}
              className="rounded border border-danger/60 bg-danger/15 px-2.5 py-1 capitalize text-danger"
            >
              Enable {MODE_INFO[confirmMode].label}
            </button>
            <button
              type="button"
              onClick={() => setConfirmMode(null)}
              className="rounded border border-border bg-panel-2 px-2.5 py-1 text-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div id="pc-setting-default-policy" className="mt-3">
        <div className="mb-1 text-[11px] text-faint">
          Default-mode policy for configurable actions (used when the mode is Default)
        </div>
        <div className="flex gap-2">
          {(["allow", "ask", "deny"] as ToolPolicy[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => pickPolicy(p)}
              className={`flex-1 rounded-lg border px-3 py-2 text-[12.5px] capitalize transition-colors ${
                settings.defaultPolicy === p
                  ? "border-accent-2/50 bg-accent-2/10 text-accent-2"
                  : "border-border bg-panel-2 text-muted hover:border-accent-2/40"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        {confirmPolicy === "allow" && (
          <div
            role="alert"
            className="mt-2 rounded-lg border border-danger/50 bg-danger/10 p-2.5 text-[11.5px] text-danger"
          >
            <p>
              ⚠ <strong>Allow by default</strong> lets every unmatched configurable action run
              without asking. Protected actions still require one-time approval. Use specific rules
              when possible.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  void updateSettings({ defaultPolicy: "allow" });
                  setConfirmPolicy(null);
                }}
                className="rounded border border-danger/60 bg-danger/15 px-2.5 py-1 text-danger"
              >
                Enable default Allow
              </button>
              <button
                type="button"
                onClick={() => setConfirmPolicy(null)}
                className="rounded border border-border bg-panel-2 px-2.5 py-1 text-muted"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div id="pc-setting-tool-rules" className="mt-3">
        <div className="mb-1 text-[11px] text-faint">
          Rules — first match wins; protected one-time approval is enforced last
        </div>
        {rules.length === 0 ? (
          <p className="text-[11px] text-faint">
            No rules yet. The mode above applies to configurable tools; protected actions ask once.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rules.map((r, i) => (
              <li
                key={`${r.tool}|${r.command ?? ""}|${r.decision}`}
                className="flex items-center justify-between gap-2 rounded border border-border bg-panel-2 px-2 py-1 text-[11.5px]"
              >
                <span className="min-w-0 truncate font-mono">
                  <span className="text-fg">{r.tool === "*" ? "Any tool" : toolLabel(r.tool)}</span>
                  {r.command ? <span className="text-muted"> “{r.command}”</span> : null}{" "}
                  <span
                    className={
                      r.decision === "allow"
                        ? "text-accent-2"
                        : r.decision === "deny"
                          ? "text-danger"
                          : "text-warn"
                    }
                  >
                    → {r.decision}
                  </span>
                  {r.decision === "allow" && isCommandToolName(r.tool) ? (
                    <span className="ml-1 text-warn">(overridden: asks every time)</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  onClick={() => removeRule(i)}
                  aria-label={`Remove rule ${i + 1}`}
                  className="shrink-0 px-1 text-muted hover:text-danger"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SelectMenu
            label="Rule tool"
            value={ruleTool}
            onChange={(next) => {
              setRuleTool(next);
              if (isCommandToolName(next) && ruleDecision === "allow") {
                setRuleDecision("ask");
              }
            }}
            placement="top"
            className="w-[136px]"
            buttonClassName="px-2 py-1.5 font-mono text-[11.5px]"
            groups={[
              {
                id: "tools",
                label: "Agent tools",
                options: PERM_TOOLS.map((tool) => ({
                  value: tool,
                  label: tool === "*" ? "Any tool" : toolLabel(tool),
                })),
              },
            ]}
          />
          {isCommandToolName(ruleTool) && (
            <input
              aria-label="Command prefix"
              value={ruleCommand}
              onChange={(e) => setRuleCommand(e.target.value)}
              placeholder="command prefix (e.g. git )"
              className="min-w-0 flex-1 rounded border border-border bg-panel-2 px-2 py-1 text-[11.5px] text-fg"
            />
          )}
          <SelectMenu
            label="Rule decision"
            value={ruleDecision}
            onChange={(next) => setRuleDecision(next as ToolPolicy)}
            placement="top"
            className="w-[96px]"
            buttonClassName="px-2 py-1.5 text-[11.5px] capitalize"
            groups={[
              {
                id: "decisions",
                options: (isCommandToolName(ruleTool)
                  ? (["ask", "deny"] as ToolPolicy[])
                  : (["allow", "ask", "deny"] as ToolPolicy[])
                ).map((decision) => ({ value: decision, label: decision })),
              },
            ]}
          />
          <button
            type="button"
            onClick={addRule}
            className="rounded border border-accent-2/50 bg-accent-2/10 px-2.5 py-1 text-[11.5px] text-accent-2"
          >
            Add rule
          </button>
        </div>
        {overBroadAllow && (
          <p role="alert" className="mt-1.5 text-[11px] text-danger">
            ⚠ This allow rule matches every configurable tool. Protected actions still ask once.
            Prefer a specific tool.
          </p>
        )}
        <p className="mt-1.5 text-[11px] text-faint">
          Command prefixes scope Ask or Deny rules. Historical shell Allow rules remain visible for
          compatibility, but mandatory approval overrides them.
        </p>
        <p className="mt-1 text-[11px] text-faint">
          Read-only browsing and delegated tasks never require permission rules.
        </p>
      </div>
    </div>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  on,
  onToggle,
}: {
  id?: string;
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div id={id} className="pc-setting-row">
      <div>
        <div className="text-[12.5px] font-medium text-fg">{label}</div>
        <div className="text-[11px] text-faint mt-0.5">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        className="pc-switch"
      >
        <span className="pc-switch__knob" />
      </button>
    </div>
  );
}
