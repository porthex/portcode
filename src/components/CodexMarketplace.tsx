import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  CodexMarketplaceCatalog,
  CodexPluginDetail,
  CodexPluginSummary,
  CodexScheduledTaskSchedule,
} from "../types";
import {
  addCodexMarketplace,
  installCodexPlugin,
  listCodexPlugins,
  readCodexPlugin,
  removeCodexMarketplace,
  uninstallCodexPlugin,
  upgradeCodexMarketplace,
} from "../lib/ipc";

const MAX_VISIBLE_PLUGINS = 200;

type CatalogRow = {
  marketplaceName: string;
  marketplaceLabel: string;
  plugin: CodexPluginSummary;
};

type Confirmation =
  | { kind: "install"; row: CatalogRow }
  | { kind: "uninstall"; row: CatalogRow }
  | { kind: "removeMarketplace"; marketplaceName: string };

type GlyphProps = { size?: number; className?: string; "aria-hidden"?: boolean | string };

function Glyph({ children, size, className = "" }: GlyphProps & { children: string }) {
  return (
    <span
      className={`marketplace-glyph ${className}`.trim()}
      style={size ? { fontSize: size } : undefined}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

const AlertTriangle = (props: GlyphProps) => <Glyph {...props}>!</Glyph>;
const Box = (props: GlyphProps) => <Glyph {...props}>◇</Glyph>;
const CheckCircle2 = (props: GlyphProps) => <Glyph {...props}>✓</Glyph>;
const Download = (props: GlyphProps) => <Glyph {...props}>↓</Glyph>;
const Loader2 = (props: GlyphProps) => <Glyph {...props}>◌</Glyph>;
const PackageSearch = (props: GlyphProps) => <Glyph {...props}>□</Glyph>;
const Plus = (props: GlyphProps) => <Glyph {...props}>+</Glyph>;
const RefreshCw = (props: GlyphProps) => <Glyph {...props}>↻</Glyph>;
const Search = (props: GlyphProps) => <Glyph {...props}>⌕</Glyph>;
const ShieldAlert = (props: GlyphProps) => <Glyph {...props}>◇</Glyph>;
const Trash2 = (props: GlyphProps) => <Glyph {...props}>×</Glyph>;
const X = (props: GlyphProps) => <Glyph {...props}>×</Glyph>;

function displayName(plugin: CodexPluginSummary): string {
  return plugin.displayName || plugin.name;
}

function flattenCatalog(catalog: CodexMarketplaceCatalog): CatalogRow[] {
  return catalog.marketplaces.flatMap((marketplace) =>
    marketplace.plugins.map((plugin) => ({
      marketplaceName: marketplace.name,
      marketplaceLabel: marketplace.displayName || marketplace.name,
      plugin,
    })),
  );
}

function formatSchedule(schedule: CodexScheduledTaskSchedule): string {
  switch (schedule.type) {
    case "hourly": {
      const cadence =
        schedule.intervalHours === 1 ? "Every hour" : `Every ${schedule.intervalHours} hours`;
      return schedule.days?.length ? `${cadence} · ${schedule.days.join(", ")}` : cadence;
    }
    case "daily":
      return `Daily at ${schedule.time}`;
    case "weekdays":
      return `Weekdays at ${schedule.time}`;
    case "weekly":
      return `${schedule.days.join(", ")} at ${schedule.time}`;
  }
}

function ActionDialog({
  confirmation,
  busy,
  onCancel,
  onConfirm,
}: {
  confirmation: Confirmation;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      );
    controls()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const available = controls();
      if (available.length === 0) return;
      const first = available[0];
      const last = available[available.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  if (confirmation.kind === "removeMarketplace") {
    return (
      <div className="marketplace-dialog-backdrop" role="presentation">
        <section
          ref={dialogRef}
          className="marketplace-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={`Remove ${confirmation.marketplaceName}`}
        >
          <button
            className="marketplace-dialog-close"
            onClick={onCancel}
            aria-label="Close dialog"
            disabled={busy}
          >
            <X size={15} aria-hidden="true" />
          </button>
          <ShieldAlert size={22} aria-hidden="true" />
          <h2>Remove marketplace source?</h2>
          <p>
            This removes <strong>{confirmation.marketplaceName}</strong> from Codex. It is not the
            same as uninstalling each plugin.
          </p>
          <div className="marketplace-dialog-actions">
            <button className="marketplace-button secondary" onClick={onCancel} disabled={busy}>
              Keep source
            </button>
            <button className="marketplace-button danger" onClick={onConfirm} disabled={busy}>
              {busy ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
              Confirm removal
            </button>
          </div>
        </section>
      </div>
    );
  }

  const name = displayName(confirmation.row.plugin);
  const installing = confirmation.kind === "install";
  return (
    <div className="marketplace-dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="marketplace-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${installing ? "Install" : "Remove"} ${name}`}
      >
        <button
          className="marketplace-dialog-close"
          onClick={onCancel}
          aria-label="Close dialog"
          disabled={busy}
        >
          <X size={15} aria-hidden="true" />
        </button>
        <ShieldAlert size={22} aria-hidden="true" />
        <h2>{installing ? `Install ${name}?` : `Remove ${name}?`}</h2>
        {installing ? (
          <>
            <p>Plugins are untrusted capability bundles. This plugin may add:</p>
            <ul>
              <li>skills that influence Codex instructions;</li>
              <li>MCP connectors that access external services;</li>
              <li>hooks that execute commands.</li>
            </ul>
            <p>Installation does not authenticate connectors, trust hooks, or schedule tasks.</p>
          </>
        ) : (
          <p>
            Removing the plugin does not necessarily revoke authorization already granted to an
            external connector. Revoke that access with the external service when needed.
          </p>
        )}
        <div className="marketplace-dialog-actions">
          <button className="marketplace-button secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={`marketplace-button ${installing ? "primary" : "danger"}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="spin" size={14} />
            ) : installing ? (
              <Download size={14} />
            ) : (
              <Trash2 size={14} />
            )}
            {installing ? "Confirm install" : "Confirm removal"}
          </button>
        </div>
      </section>
    </div>
  );
}

export function CodexMarketplace({ active = true }: { active?: boolean }) {
  const [catalog, setCatalog] = useState<CodexMarketplaceCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CatalogRow | null>(null);
  const [detail, setDetail] = useState<CodexPluginDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [source, setSource] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [sourceTrusted, setSourceTrusted] = useState(false);
  const confirmationOpenerRef = useRef<HTMLElement | null>(null);
  const detailRequestRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  const openConfirmation = useCallback((next: Confirmation) => {
    confirmationOpenerRef.current = document.activeElement as HTMLElement | null;
    setConfirmation(next);
  }, []);

  const closeConfirmation = useCallback(() => {
    setConfirmation(null);
    const opener = confirmationOpenerRef.current;
    confirmationOpenerRef.current = null;
    queueMicrotask(() => {
      if (opener?.isConnected) opener.focus();
    });
  }, []);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await listCodexPlugins());
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Codex could not load the plugin catalog.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      detailRequestRef.current += 1;
      setSelected(null);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      setQuery("");
      setConfirmation(null);
      confirmationOpenerRef.current = null;
      return;
    }
    void loadCatalog();
    return () => {
      detailRequestRef.current += 1;
    };
  }, [active, loadCatalog]);

  const allRows = useMemo(() => (catalog ? flattenCatalog(catalog) : []), [catalog]);
  const filteredRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return allRows;
    return allRows.filter(({ plugin, marketplaceLabel }) =>
      [
        plugin.displayName,
        plugin.name,
        plugin.shortDescription,
        plugin.developerName,
        plugin.category,
        marketplaceLabel,
        ...plugin.keywords,
      ]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(needle)),
    );
  }, [allRows, query]);
  const visibleRows = filteredRows.slice(0, MAX_VISIBLE_PLUGINS);

  const openPlugin = useCallback(async (row: CatalogRow) => {
    const requestId = ++detailRequestRef.current;
    setSelected(row);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setError(null);
    try {
      const nextDetail = await readCodexPlugin(row.marketplaceName, row.plugin.name);
      if (requestId === detailRequestRef.current) setDetail(nextDetail);
    } catch (reason) {
      if (requestId === detailRequestRef.current) {
        setDetailError(
          reason instanceof Error ? reason.message : "Codex could not load this plugin.",
        );
      }
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }, []);

  const confirmAction = useCallback(async () => {
    if (!confirmation) return;
    const rowToRefresh = "row" in confirmation ? confirmation.row : null;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (confirmation.kind === "install") {
        const result = await installCodexPlugin(
          confirmation.row.marketplaceName,
          confirmation.row.plugin.name,
          true,
        );
        setNotice(
          result.appsNeedingAuth.length
            ? `Installed. ${result.appsNeedingAuth.length} connector${result.appsNeedingAuth.length === 1 ? " needs" : "s need"} authentication.`
            : "Plugin installed through Codex.",
        );
      } else if (confirmation.kind === "uninstall") {
        await uninstallCodexPlugin(confirmation.row.plugin.id, true);
        setNotice("Plugin removed through Codex. External authorization may still be active.");
      } else {
        await removeCodexMarketplace(confirmation.marketplaceName, true);
        setNotice("Marketplace source removed through Codex.");
        setSelected(null);
        setDetail(null);
      }
      closeConfirmation();
      if (activeRef.current) {
        await loadCatalog();
        if (rowToRefresh && activeRef.current) await openPlugin(rowToRefresh);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Codex could not complete the action.");
    } finally {
      setBusy(false);
    }
  }, [closeConfirmation, confirmation, loadCatalog, openPlugin]);

  const addMarketplace = useCallback(async () => {
    if (!sourceTrusted) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await addCodexMarketplace(source, sourceRef.trim() || null, true);
      setNotice(
        result.alreadyAdded
          ? "Marketplace was already configured."
          : "Marketplace added through Codex.",
      );
      setSource("");
      setSourceRef("");
      setSourceTrusted(false);
      await loadCatalog();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Codex could not add the marketplace.");
    } finally {
      setBusy(false);
    }
  }, [loadCatalog, source, sourceRef, sourceTrusted]);

  const refreshMarketplaces = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await upgradeCodexMarketplace();
      setNotice(
        result.errors.length
          ? `Refreshed ${result.upgradedCount} snapshot${result.upgradedCount === 1 ? "" : "s"}; ${result.errors.length} failed.`
          : `Refreshed ${result.upgradedCount} marketplace snapshot${result.upgradedCount === 1 ? "" : "s"}.`,
      );
      await loadCatalog();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Codex could not refresh marketplace snapshots.",
      );
    } finally {
      setBusy(false);
    }
  }, [loadCatalog]);

  return (
    <main className="codex-marketplace" aria-labelledby="marketplace-title">
      <header className="marketplace-header">
        <div>
          <span className="marketplace-eyebrow">CODEX CAPABILITIES</span>
          <h1 id="marketplace-title">Plugin marketplace</h1>
          <p>Discover and manage Codex capability bundles without leaving Portcode.</p>
        </div>
        <button
          className="marketplace-button secondary"
          onClick={() => void refreshMarketplaces()}
          disabled={busy}
        >
          <RefreshCw size={14} className={busy ? "spin" : undefined} />
          Refresh snapshots
        </button>
      </header>

      {error && (
        <div className="marketplace-banner error" role="alert">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}
      {notice && (
        <div className="marketplace-banner success" role="status">
          <CheckCircle2 size={15} />
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss notice">
            <X size={14} />
          </button>
        </div>
      )}
      {catalog?.loadErrors.map((loadError) => (
        <div
          className="marketplace-banner warning"
          role="status"
          key={`${loadError.sourceLabel}:${loadError.message}`}
        >
          <AlertTriangle size={15} />
          <span>
            {loadError.sourceLabel}: {loadError.message}
          </span>
        </div>
      ))}

      <div className="marketplace-layout">
        <section className="marketplace-catalog" aria-label="Plugin catalog">
          <label className="marketplace-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search plugins, skills, connectors…"
              aria-label="Search plugin catalog"
            />
          </label>

          <div className="marketplace-count" role="status">
            {filteredRows.length > MAX_VISIBLE_PLUGINS
              ? `Showing ${MAX_VISIBLE_PLUGINS} of ${filteredRows.length} plugins`
              : `${filteredRows.length} plugin${filteredRows.length === 1 ? "" : "s"}`}
          </div>

          {loading ? (
            <div className="marketplace-empty">
              <Loader2 className="spin" /> Loading Codex catalog…
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="marketplace-empty">
              <PackageSearch /> No matching plugins.
            </div>
          ) : (
            <div className="marketplace-plugin-list">
              {visibleRows.map((row) => (
                <button
                  key={`${row.marketplaceName}:${row.plugin.id}`}
                  className={`marketplace-plugin-row ${selected?.plugin.id === row.plugin.id ? "selected" : ""}`}
                  onClick={() => void openPlugin(row)}
                  data-testid="marketplace-plugin-row"
                  aria-label={`${displayName(row.plugin)} · ${row.marketplaceLabel}`}
                >
                  <span className="marketplace-plugin-icon">
                    <Box size={17} />
                  </span>
                  <span className="marketplace-plugin-copy">
                    <strong>{displayName(row.plugin)}</strong>
                    <small>{row.plugin.shortDescription || row.marketplaceLabel}</small>
                  </span>
                  <span
                    className={`marketplace-plugin-state ${row.plugin.installed ? "installed" : ""}`}
                  >
                    {row.plugin.installed ? "Installed" : row.plugin.category || "Plugin"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="marketplace-detail" aria-label="Plugin details">
          {!selected ? (
            <div className="marketplace-empty detail-empty">
              <PackageSearch size={28} />
              <strong>Select a plugin</strong>
              <span>Inspect bundled skills, connectors, hooks, and task templates.</span>
            </div>
          ) : detailLoading ? (
            <div className="marketplace-empty">
              <Loader2 className="spin" /> Loading plugin details…
            </div>
          ) : detailError ? (
            <div className="marketplace-empty detail-error" role="alert">
              <AlertTriangle size={22} />
              <h2>{displayName(selected.plugin)}</h2>
              <span>{detailError}</span>
              <button
                className="marketplace-button secondary"
                onClick={() => void openPlugin(selected)}
              >
                <RefreshCw size={14} /> Retry plugin details
              </button>
            </div>
          ) : detail ? (
            <>
              <div className="marketplace-detail-heading">
                <div>
                  <span className="marketplace-eyebrow">{selected.marketplaceLabel}</span>
                  <h2>{displayName(detail.summary)}</h2>
                  <p>
                    {detail.description ||
                      detail.summary.shortDescription ||
                      "No description supplied."}
                  </p>
                </div>
                {detail.summary.installed ? (
                  <button
                    className="marketplace-button danger"
                    onClick={() => openConfirmation({ kind: "uninstall", row: selected })}
                  >
                    <Trash2 size={14} /> Remove plugin
                  </button>
                ) : (
                  <button
                    className="marketplace-button primary"
                    onClick={() => openConfirmation({ kind: "install", row: selected })}
                    disabled={!detail.summary.installable}
                    title={
                      !detail.summary.installable
                        ? "Codex policy does not allow installation"
                        : undefined
                    }
                  >
                    <Download size={14} /> Install plugin
                  </button>
                )}
              </div>

              <div className="marketplace-facts">
                {detail.summary.developerName && <span>By {detail.summary.developerName}</span>}
                {detail.summary.version && <span>Version {detail.summary.version}</span>}
                {detail.summary.availability === "disabledByAdmin" && (
                  <span className="blocked">Disabled by admin</span>
                )}
              </div>

              <div className="marketplace-capability-grid">
                <article>
                  <strong>{detail.skills.length}</strong>
                  <span>Skills</span>
                </article>
                <article>
                  <strong>{detail.mcpServers.length}</strong>
                  <span>MCP servers</span>
                </article>
                <article>
                  <strong>{detail.hooks.length}</strong>
                  <span>Hooks</span>
                </article>
                <article>
                  <strong>{detail.apps.length}</strong>
                  <span>Apps</span>
                </article>
              </div>

              <section className="marketplace-task-section" aria-labelledby="task-template-title">
                <div className="marketplace-section-heading">
                  <div>
                    <span className="marketplace-eyebrow">READ-ONLY METADATA</span>
                    <h3 id="task-template-title">Scheduled task templates</h3>
                  </div>
                  <span className="marketplace-template-badge">Template only</span>
                </div>
                <p className="marketplace-truth-note">
                  Each entry is a catalog template, not a configured automation. This Codex runtime
                  does not expose task creation, run-now, enablement, or history controls.
                </p>
                {detail.scheduledTasks === null ? (
                  <div className="marketplace-inline-empty">Task metadata is unavailable.</div>
                ) : detail.scheduledTasks.length === 0 ? (
                  <div className="marketplace-inline-empty">
                    This plugin declares no task templates.
                  </div>
                ) : (
                  <div className="marketplace-task-list">
                    {detail.scheduledTasks.map((task) => (
                      <article key={task.key}>
                        <div>
                          <strong>{task.name}</strong>
                          <span>{formatSchedule(task.schedule)}</span>
                        </div>
                        <p>{task.prompt}</p>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : null}
        </section>
      </div>

      <details className="marketplace-advanced">
        <summary>Advanced marketplace sources</summary>
        <div className="marketplace-advanced-body">
          <p>
            Only add public HTTPS Git sources you trust. Codex—not Portcode—owns fetching and
            configuration.
          </p>
          <div className="marketplace-source-form">
            <label>
              Source URL
              <input
                value={source}
                onChange={(event) => setSource(event.currentTarget.value)}
                placeholder="https://github.com/org/marketplace.git"
              />
            </label>
            <label>
              Git ref (optional)
              <input
                value={sourceRef}
                onChange={(event) => setSourceRef(event.currentTarget.value)}
                placeholder="main"
              />
            </label>
            <label className="marketplace-trust-check">
              <input
                type="checkbox"
                checked={sourceTrusted}
                onChange={(event) => setSourceTrusted(event.currentTarget.checked)}
              />{" "}
              I reviewed and trust this source.
            </label>
            <button
              className="marketplace-button primary"
              onClick={() => void addMarketplace()}
              disabled={busy || !sourceTrusted || !source.trim()}
            >
              <Plus size={14} /> Add source
            </button>
          </div>
          <div className="marketplace-source-list">
            {catalog?.marketplaces.map((marketplace) => (
              <div key={marketplace.name}>
                <span>{marketplace.displayName || marketplace.name}</span>
                <button
                  onClick={() =>
                    openConfirmation({
                      kind: "removeMarketplace",
                      marketplaceName: marketplace.name,
                    })
                  }
                >
                  <Trash2 size={13} /> Remove source
                </button>
              </div>
            ))}
          </div>
        </div>
      </details>

      {confirmation && (
        <ActionDialog
          confirmation={confirmation}
          busy={busy}
          onCancel={closeConfirmation}
          onConfirm={() => void confirmAction()}
        />
      )}
    </main>
  );
}
