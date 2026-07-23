import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as ipc from "../lib/ipc";
import { useStore } from "../store/store";
import { openAIAccountLabel, type PlanUsageSnapshot, type PlanUsageWindow } from "../types";

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

/** The most constrained provider window is the useful one-number plan summary. */
export function lowestPlanRemaining(snapshots: PlanUsageSnapshot[]): number | null {
  const remaining = snapshots.flatMap((snapshot) => snapshot.windows.map(remainingPercent));
  return remaining.length > 0 ? Math.min(...remaining) : null;
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

interface PlanUsageCardProps {
  account: string | null;
  tier: string | null;
  signedIn: boolean;
  state: UsageState;
  onRefresh: () => void;
  onOpenSettings?: (section: "account") => void;
  ariaLabel?: string;
}

function PlanUsageCard({
  account,
  tier,
  signedIn,
  state,
  onRefresh,
  onOpenSettings,
  ariaLabel,
}: PlanUsageCardProps) {
  const plan = state.snapshot?.plan ?? tier?.replace(/^ChatGPT\s+/i, "") ?? null;
  const openAccount = () => {
    if (onOpenSettings) {
      onOpenSettings("account");
      return;
    }
    document
      .getElementById("pc-setting-openai")
      ?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  };

  return (
    <article
      className="pc-plan-card pc-plan-card--openai"
      aria-label={ariaLabel ?? "GPT plan usage"}
    >
      <header className="pc-plan-card__header">
        <span className="pc-plan-card__mark" aria-hidden="true">
          G
        </span>
        <div className="pc-plan-card__identity">
          <span>OpenAI · Codex</span>
          <strong>GPT</strong>
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
            Open GPT account settings
          </button>
        </div>
      ) : state.loading && !state.snapshot ? (
        <div className="pc-plan-card__loading" role="status" aria-label="Loading GPT usage">
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
              aria-label="Refresh GPT usage"
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

interface UsageTarget {
  key: string;
  accountProfileId: string | null;
  account: string | null;
  tier: string | null;
  signedIn: boolean;
}

/** Codex plan allowance view. Codex owns one OpenAI authentication slot;
 * an explicit historical profile id is still supported for readable old chats. */
export function PlanUsagePanel({
  compact = false,
  openAIAccountProfileId,
  onOpenSettings,
  onRemainingChange,
}: {
  compact?: boolean;
  openAIAccountProfileId?: string | null;
  onOpenSettings?: (section: "account") => void;
  onRemainingChange?: (remaining: number | null) => void;
} = {}) {
  const openAIStatus = useStore((state) => state.openAIAuthStatus);
  const openAIAccounts = useStore((state) => state.openAIAccounts);
  const openAIAvailable = openAIStatus?.available !== false;

  const targets = useMemo<UsageTarget[]>(() => {
    const next: UsageTarget[] = [];
    const codexAccount =
      openAIAccounts.find((account) => account.id === "codex-primary") ?? openAIAccounts[0];
    const scopedAccounts = openAIAccountProfileId
      ? openAIAccounts.filter((account) => account.id === openAIAccountProfileId)
      : codexAccount
        ? [codexAccount]
        : [];
    if (scopedAccounts.length > 0) {
      for (const account of scopedAccounts) {
        next.push({
          key: `openai:${account.id}`,
          accountProfileId: account.id,
          account: openAIAccountLabel(account, openAIAccounts),
          tier: account.tier,
          signedIn: openAIAvailable && account.state === "connected",
        });
      }
    } else if (openAIAccountProfileId) {
      // A removed profile remains a readable session identity, but its local UUID
      // is intentionally not rendered. The card routes users to account Settings.
      next.push({
        key: `openai:${openAIAccountProfileId}`,
        accountProfileId: openAIAccountProfileId,
        account: "Removed ChatGPT account",
        tier: null,
        signedIn: false,
      });
    } else if (openAIAvailable) {
      next.push({
        key: "openai:none",
        accountProfileId: null,
        account: null,
        tier: null,
        signedIn: false,
      });
    }
    return next;
  }, [openAIAccountProfileId, openAIAccounts, openAIAvailable]);

  const [states, setStates] = useState<Record<string, UsageState>>({});
  const mounted = useRef(true);
  const requestIds = useRef<Record<string, number>>({});

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (target: UsageTarget) => {
    const requestId = (requestIds.current[target.key] ?? 0) + 1;
    requestIds.current[target.key] = requestId;
    if (!target.signedIn) {
      setStates((current) => ({ ...current, [target.key]: EMPTY }));
      return;
    }
    setStates((current) => ({
      ...current,
      [target.key]: {
        ...(current[target.key] ?? EMPTY),
        loading: true,
        error: null,
      },
    }));
    try {
      const snapshot = await ipc.getPlanUsage("openai", target.accountProfileId);
      if (!mounted.current || requestIds.current[target.key] !== requestId) return;
      setStates((current) => ({
        ...current,
        [target.key]: { snapshot, loading: false, error: null },
      }));
    } catch (error) {
      if (!mounted.current || requestIds.current[target.key] !== requestId) return;
      setStates((current) => ({
        ...current,
        [target.key]: {
          snapshot: current[target.key]?.snapshot ?? null,
          loading: false,
          error: errorMessage(error),
        },
      }));
    }
  }, []);

  useEffect(() => {
    for (const target of targets) void refresh(target);
  }, [refresh, targets]);

  const snapshots = useMemo(
    () =>
      targets
        .map((target) => states[target.key]?.snapshot ?? null)
        .filter((snapshot): snapshot is PlanUsageSnapshot => snapshot !== null),
    [states, targets],
  );
  const latest = Math.max(0, ...snapshots.map((snapshot) => snapshot.updatedAt));
  const refreshing = targets.some((target) => states[target.key]?.loading);
  const anyConnected = targets.some((target) => target.signedIn);
  const refreshAll = () => {
    for (const target of targets) void refresh(target);
  };

  useEffect(() => {
    if (!onRemainingChange) return;
    onRemainingChange(snapshots.length > 0 ? lowestPlanRemaining(snapshots) : null);
  }, [onRemainingChange, snapshots]);

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
          disabled={refreshing || !anyConnected}
          aria-label="Refresh all plan usage"
        >
          <span aria-hidden="true">↻</span> {refreshing ? "Refreshing" : "Refresh all"}
        </button>
      </div>
      <div className="pc-plan-usage__grid">
        {targets.map((target) => {
          return (
            <PlanUsageCard
              key={target.key}
              account={target.account}
              tier={target.tier}
              signedIn={target.signedIn}
              state={states[target.key] ?? EMPTY}
              onRefresh={() => void refresh(target)}
              onOpenSettings={onOpenSettings}
              ariaLabel="GPT plan usage"
            />
          );
        })}
      </div>
      <p className="pc-plan-usage__note">
        Short-term and weekly limits apply at the same time. Work pauses when either reaches 0%.
        Paid credits, API billing, and local session token totals are kept separate.
      </p>
    </div>
  );
}
