import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as ipc from "../lib/ipc";
import { useStore } from "../store/store";
import type { PlanUsageSnapshot, PlanUsageWindow, ProviderId } from "../types";

interface UsageState {
  snapshot: PlanUsageSnapshot | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: UsageState = { snapshot: null, loading: false, error: null };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resetDate(value: string | null): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  const date =
    Number.isFinite(numeric) && trimmed !== "" ? new Date(numeric * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function relativeReset(date: Date, now = new Date()): string {
  const totalMinutes = Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 60_000));
  if (totalMinutes < 60) return `in ${totalMinutes}m`;
  if (totalMinutes < 48 * 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `in ${hours}h${minutes ? ` ${minutes}m` : ""}`;
  }
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  return `in ${days}d${hours ? ` ${hours}h` : ""}`;
}

function absoluteReset(date: Date, now = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayOffset = Math.round((target - start) / 86_400_000);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (dayOffset === 0) return `today at ${time}`;
  if (dayOffset === 1) return `tomorrow at ${time}`;
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
  return `${day} at ${time}`;
}

function resetLabel(value: string | null): string {
  const date = resetDate(value);
  if (!date) return "Reset time unavailable";
  return `Resets ${relativeReset(date)} · ${absoluteReset(date)}`;
}

function ResetTime({ value }: { value: string | null }) {
  const date = resetDate(value);
  if (!date) return <span>Reset time unavailable</span>;
  return <time dateTime={date.toISOString()}>{resetLabel(value)}</time>;
}

function updatedLabel(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp * 1000) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ago`;
}

function remainingPercent(window: PlanUsageWindow): number {
  return Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
}

function UsageWindowRow({ window }: { window: PlanUsageWindow }) {
  const remaining = remainingPercent(window);
  const tone = remaining <= 10 ? "danger" : remaining <= 25 ? "warn" : "normal";
  const status = remaining === 0 ? " · At limit" : remaining <= 25 ? " · Low" : "";
  return (
    <div className="pc-plan-window">
      <div className="pc-plan-window__heading">
        <strong>{window.label}</strong>
        <span className={`pc-plan-window__remaining pc-plan-window__remaining--${tone}`}>
          {remaining}% left{status}
        </span>
      </div>
      <div
        className={`pc-plan-meter pc-plan-meter--${tone}`}
        role="progressbar"
        aria-label={`${window.label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
        aria-valuetext={`${remaining}% remaining`}
      >
        <span style={{ width: `${remaining}%` }} />
      </div>
      <div className="pc-plan-window__reset">
        <ResetTime value={window.resetsAt} />
      </div>
    </div>
  );
}

interface ProviderUsageCardProps {
  provider: ProviderId;
  account: string | null;
  tier: string | null;
  signedIn: boolean;
  state: UsageState;
  onRefresh: () => void;
  onOpenSettings?: (provider: ProviderId) => void;
}

function ProviderUsageCard({
  provider,
  account,
  tier,
  signedIn,
  state,
  onRefresh,
  onOpenSettings,
}: ProviderUsageCardProps) {
  const isClaude = provider === "anthropic";
  const name = isClaude ? "Claude" : "GPT";
  const vendor = isClaude ? "Anthropic" : "OpenAI · Codex";
  const target = isClaude ? "pc-setting-claude" : "pc-setting-openai";
  const plan = state.snapshot?.plan ?? tier?.replace(/^(Claude|ChatGPT)\s+/i, "") ?? null;
  const openAccount = () => {
    if (onOpenSettings) {
      onOpenSettings(provider);
      return;
    }
    document.getElementById(target)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  };

  return (
    <article
      className={`pc-plan-card pc-plan-card--${isClaude ? "claude" : "openai"}`}
      aria-label={`${name} plan usage`}
    >
      <header className="pc-plan-card__header">
        <span className="pc-plan-card__mark" aria-hidden="true">
          {isClaude ? "C" : "G"}
        </span>
        <div className="pc-plan-card__identity">
          <span>{vendor}</span>
          <strong>{name}</strong>
          {account && <small title={account}>{account}</small>}
        </div>
        {plan && <span className="pc-plan-card__tier">{plan}</span>}
      </header>

      {!signedIn ? (
        <div className="pc-plan-card__empty">
          <span className="pc-dot" aria-hidden="true" />
          <strong>Not connected</strong>
          <p>Sign in to see included-plan limits and reset times.</p>
          <button type="button" onClick={openAccount}>
            Open {name} account settings
          </button>
        </div>
      ) : state.loading && !state.snapshot ? (
        <div className="pc-plan-card__loading" role="status" aria-label={`Loading ${name} usage`}>
          <span />
          <span />
          <span />
        </div>
      ) : state.snapshot ? (
        <>
          <div className="pc-plan-card__windows">
            {state.snapshot.windows.map((window) => (
              <UsageWindowRow key={window.id} window={window} />
            ))}
          </div>
          <footer className="pc-plan-card__footer">
            <span className={state.error ? "text-warn" : undefined}>
              {state.error
                ? "Last update kept · refresh failed"
                : updatedLabel(state.snapshot.updatedAt)}
            </span>
            <button
              type="button"
              onClick={onRefresh}
              disabled={state.loading}
              aria-label={`Refresh ${name} usage`}
            >
              <span aria-hidden="true">↻</span> {state.loading ? "Refreshing" : "Refresh"}
            </button>
          </footer>
          {state.error && (
            <p className="pc-plan-card__error" role="alert">
              {state.error}
            </p>
          )}
        </>
      ) : (
        <div className="pc-plan-card__empty pc-plan-card__empty--error" role="alert">
          <span aria-hidden="true">!</span>
          <strong>Usage unavailable</strong>
          <p>{state.error ?? "No plan-usage windows were returned."}</p>
          <button type="button" onClick={onRefresh} disabled={state.loading}>
            Try again
          </button>
        </div>
      )}
    </article>
  );
}

/** Combined plan allowance view. Each provider loads independently so one failed
 * subscription backend never hides a healthy snapshot from the other. */
export function PlanUsagePanel({
  compact = false,
  onOpenSettings,
}: {
  compact?: boolean;
  onOpenSettings?: (provider: ProviderId) => void;
} = {}) {
  const claude = useStore((state) => state.oauthStatus);
  const openai = useStore((state) => state.openAIAuthStatus);
  const claudeSignedIn = Boolean(claude?.signedIn);
  const openaiSignedIn = Boolean(openai?.signedIn);
  const openAIAvailable = openai?.available !== false;
  const [states, setStates] = useState<Record<ProviderId, UsageState>>({
    anthropic: EMPTY,
    openai: EMPTY,
  });
  const mounted = useRef(true);
  const requestIds = useRef<Record<ProviderId, number>>({ anthropic: 0, openai: 0 });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (provider: ProviderId, signedIn: boolean) => {
    const requestId = ++requestIds.current[provider];
    if (!signedIn) {
      setStates((current) => ({ ...current, [provider]: EMPTY }));
      return;
    }
    setStates((current) => ({
      ...current,
      [provider]: { ...current[provider], loading: true, error: null },
    }));
    try {
      const snapshot = await ipc.getPlanUsage(provider);
      if (!mounted.current || requestIds.current[provider] !== requestId) return;
      setStates((current) => ({
        ...current,
        [provider]: { snapshot, loading: false, error: null },
      }));
    } catch (error) {
      if (!mounted.current || requestIds.current[provider] !== requestId) return;
      setStates((current) => ({
        ...current,
        [provider]: {
          snapshot: current[provider].snapshot,
          loading: false,
          error: errorMessage(error),
        },
      }));
    }
  }, []);

  useEffect(() => {
    void refresh("anthropic", claudeSignedIn);
  }, [claudeSignedIn, refresh]);

  useEffect(() => {
    void refresh("openai", openAIAvailable && openaiSignedIn);
  }, [openAIAvailable, openaiSignedIn, refresh]);

  const latest = useMemo(
    () =>
      Math.max(states.anthropic.snapshot?.updatedAt ?? 0, states.openai.snapshot?.updatedAt ?? 0),
    [states.anthropic.snapshot?.updatedAt, states.openai.snapshot?.updatedAt],
  );
  const refreshing = states.anthropic.loading || (openAIAvailable && states.openai.loading);
  const refreshAll = () => {
    void refresh("anthropic", claudeSignedIn);
    if (openAIAvailable) void refresh("openai", openaiSignedIn);
  };

  return (
    <div className={`pc-plan-usage${compact ? " pc-plan-usage--compact" : ""}`}>
      <div className="pc-plan-usage__toolbar">
        <div>
          <strong>Included plan allowance</strong>
          <span>
            {latest > 0 ? updatedLabel(latest) : "Live after sign-in"} · local reset times
          </span>
        </div>
        <button
          type="button"
          className="pc-settings-action"
          onClick={refreshAll}
          disabled={refreshing || (!claudeSignedIn && !(openAIAvailable && openaiSignedIn))}
          aria-label="Refresh all plan usage"
        >
          <span aria-hidden="true">↻</span> {refreshing ? "Refreshing" : "Refresh all"}
        </button>
      </div>
      <div className="pc-plan-usage__grid">
        {openAIAvailable && (
          <ProviderUsageCard
            provider="openai"
            account={openai?.account ?? null}
            tier={openai?.tier ?? null}
            signedIn={openaiSignedIn}
            state={states.openai}
            onRefresh={() => void refresh("openai", openaiSignedIn)}
            onOpenSettings={onOpenSettings}
          />
        )}
        <ProviderUsageCard
          provider="anthropic"
          account={claude?.account ?? null}
          tier={claude?.tier ?? null}
          signedIn={claudeSignedIn}
          state={states.anthropic}
          onRefresh={() => void refresh("anthropic", claudeSignedIn)}
          onOpenSettings={onOpenSettings}
        />
      </div>
      <p className="pc-plan-usage__note">
        Short-term and weekly limits apply at the same time. Work pauses when either reaches 0%.
        Paid credits, API billing, and local session token totals are kept separate.
      </p>
    </div>
  );
}
