import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexMarketplace } from "./CodexMarketplace";
import * as ipc from "../lib/ipc";

vi.mock("../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../lib/ipc")>("../lib/ipc");
  return {
    ...actual,
    listCodexPlugins: vi.fn(),
    readCodexPlugin: vi.fn(),
    installCodexPlugin: vi.fn(),
    uninstallCodexPlugin: vi.fn(),
    addCodexMarketplace: vi.fn(),
    removeCodexMarketplace: vi.fn(),
    upgradeCodexMarketplace: vi.fn(),
  };
});

const summary = {
  id: "starter@preview",
  name: "starter",
  displayName: "Starter",
  shortDescription: "A deterministic plugin.",
  developerName: "Preview",
  category: "productivity",
  version: "1.0.0",
  localVersion: null,
  installed: false,
  enabled: false,
  installPolicy: "available" as const,
  authPolicy: "onUse" as const,
  availability: "available" as const,
  mustShowInstallationInterstitial: true,
  installable: true,
  keywords: ["preview"],
  websiteUrl: null,
  logoUrl: null,
  logoUrlDark: null,
  screenshotUrls: [],
};

const catalog = {
  marketplaces: [{ name: "preview", displayName: "Preview", plugins: [summary] }],
  loadErrors: [],
  featuredPluginIds: [summary.id],
};

const detail = {
  marketplaceName: "preview",
  summary,
  shareUrl: null,
  description: "Plugin details.",
  skills: [
    {
      name: "inspect",
      description: "Inspect",
      shortDescription: null,
      displayName: null,
      enabled: true,
    },
  ],
  hooks: [],
  apps: [],
  mcpServers: ["preview-mcp"],
  scheduledTasks: [
    {
      key: "daily-review",
      name: "Daily review",
      prompt: "Review the project.",
      schedule: { type: "daily" as const, time: "09:00" },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.listCodexPlugins).mockResolvedValue(catalog);
  vi.mocked(ipc.readCodexPlugin).mockResolvedValue(detail);
  vi.mocked(ipc.installCodexPlugin).mockResolvedValue({ authPolicy: "onUse", appsNeedingAuth: [] });
  vi.mocked(ipc.uninstallCodexPlugin).mockResolvedValue();
});

describe("CodexMarketplace", () => {
  it("does not fetch the desktop catalog while its workspace surface is inactive", async () => {
    const { rerender } = render(<CodexMarketplace active={false} />);

    expect(ipc.listCodexPlugins).not.toHaveBeenCalled();

    rerender(<CodexMarketplace active />);
    expect(await screen.findByText("Starter")).toBeInTheDocument();
    expect(ipc.listCodexPlugins).toHaveBeenCalledTimes(1);
  });

  it("removes open task prompts and disclosures when the marketplace surface deactivates", async () => {
    const { rerender } = render(<CodexMarketplace active />);
    fireEvent.click(await screen.findByRole("button", { name: /Starter/ }));
    expect(await screen.findByText("Review the project.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    expect(screen.getByRole("dialog", { name: "Install Starter" })).toBeInTheDocument();

    rerender(<CodexMarketplace active={false} />);

    await waitFor(() => {
      expect(screen.queryByText("Review the project.")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Install Starter" })).not.toBeInTheDocument();
    });
  });

  it("does not restore plugin details when a mutation finishes after deactivation", async () => {
    let resolveInstall!: (value: { authPolicy: "onUse"; appsNeedingAuth: [] }) => void;
    vi.mocked(ipc.installCodexPlugin).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        }),
    );

    const { rerender } = render(<CodexMarketplace active />);
    fireEvent.click(await screen.findByRole("button", { name: /Starter/ }));
    expect(await screen.findByText("Review the project.")).toBeInTheDocument();
    const detailReadsBeforeMutation = vi.mocked(ipc.readCodexPlugin).mock.calls.length;
    const installCallsBeforeMutation = vi.mocked(ipc.installCodexPlugin).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm install" }));
    rerender(<CodexMarketplace active={false} />);

    await act(async () => {
      resolveInstall({ authPolicy: "onUse", appsNeedingAuth: [] });
    });

    await waitFor(() =>
      expect(ipc.installCodexPlugin).toHaveBeenCalledTimes(installCallsBeforeMutation + 1),
    );
    expect(ipc.readCodexPlugin).toHaveBeenCalledTimes(detailReadsBeforeMutation);
    expect(screen.queryByText("Review the project.")).not.toBeInTheDocument();
  });

  it("loads Codex-owned plugins and renders task metadata as templates, not automations", async () => {
    render(<CodexMarketplace />);
    fireEvent.click(await screen.findByRole("button", { name: /Starter/ }));

    expect(await screen.findByText("Daily review")).toBeInTheDocument();
    expect(screen.getByText("Template only")).toBeInTheDocument();
    expect(screen.getByText(/not a configured automation/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /run now|enable|schedule/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the selected plugin visible with a retry action when authoritative detail loading fails", async () => {
    vi.mocked(ipc.readCodexPlugin).mockRejectedValueOnce(
      new Error("Codex could not load this plugin."),
    );
    render(<CodexMarketplace />);

    fireEvent.click(await screen.findByRole("button", { name: /Starter/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Codex could not load this plugin.");
    expect(screen.getByRole("heading", { name: "Starter" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry plugin details" }));
    expect(await screen.findByText("Review the project.")).toBeInTheDocument();
  });

  it("ignores a stale detail response after a newer plugin selection resolves", async () => {
    const newerSummary = {
      ...summary,
      id: "newer@preview",
      name: "newer",
      displayName: "Newer",
      shortDescription: "The newer selection.",
    };
    vi.mocked(ipc.listCodexPlugins).mockResolvedValue({
      ...catalog,
      marketplaces: [
        {
          ...catalog.marketplaces[0],
          plugins: [summary, newerSummary],
        },
      ],
    });

    let resolveStarter!: (value: typeof detail) => void;
    let resolveNewer!: (value: typeof detail) => void;
    vi.mocked(ipc.readCodexPlugin).mockImplementation((_marketplace, plugin) => {
      return new Promise((resolve) => {
        if (plugin === "starter") resolveStarter = resolve;
        else resolveNewer = resolve;
      });
    });

    render(<CodexMarketplace />);
    fireEvent.click(await screen.findByRole("button", { name: /Starter/ }));
    fireEvent.click(screen.getByRole("button", { name: /Newer/ }));

    await act(async () => {
      resolveNewer({ ...detail, summary: newerSummary, description: "Newer details." });
    });
    expect(await screen.findByRole("heading", { name: "Newer" })).toBeInTheDocument();

    await act(async () => {
      resolveStarter(detail);
    });
    expect(screen.getByRole("heading", { name: "Newer" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Starter" })).not.toBeInTheDocument();
  });

  it("requires the installation disclosure before calling the native command", async () => {
    render(<CodexMarketplace />);
    fireEvent.click(await screen.findByRole("button", { name: /Starter/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Install plugin" }));

    expect(screen.getByRole("dialog", { name: "Install Starter" })).toBeInTheDocument();
    expect(ipc.installCodexPlugin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm install" }));
    await waitFor(() =>
      expect(ipc.installCodexPlugin).toHaveBeenCalledWith("preview", "starter", true),
    );
  });

  it("cannot imply cancellation after an installation has started", async () => {
    let resolveInstall!: (value: { authPolicy: "onUse"; appsNeedingAuth: [] }) => void;
    vi.mocked(ipc.installCodexPlugin).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        }),
    );

    render(<CodexMarketplace />);
    fireEvent.click(await screen.findByRole("button", { name: /Starter/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Install plugin" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm install" }));
    await waitFor(() => expect(ipc.installCodexPlugin).toHaveBeenCalled());

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Install Starter" })).toBeInTheDocument();
    const close = screen.getByRole("button", { name: "Close dialog" });
    expect(close).toBeDisabled();
    fireEvent.click(close);
    expect(screen.getByRole("dialog", { name: "Install Starter" })).toBeInTheDocument();

    await act(async () => {
      resolveInstall({ authPolicy: "onUse", appsNeedingAuth: [] });
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Install Starter" })).not.toBeInTheDocument(),
    );
  });

  it("refreshes authoritative detail state after installation completes", async () => {
    const installedSummary = {
      ...summary,
      installed: true,
      enabled: true,
      installable: false,
      localVersion: "1.0.0",
    };
    vi.mocked(ipc.readCodexPlugin)
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce({ ...detail, summary: installedSummary });

    render(<CodexMarketplace />);
    fireEvent.click(await screen.findByRole("button", { name: /Starter/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Install plugin" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm install" }));

    expect(await screen.findByRole("button", { name: "Remove plugin" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install plugin" })).not.toBeInTheDocument();
  });

  it("closes the installation disclosure with Escape and restores its exact opener", async () => {
    render(<CodexMarketplace />);
    fireEvent.click(await screen.findByRole("button", { name: /Starter/ }));
    const opener = await screen.findByRole("button", { name: "Install plugin" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Install Starter" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(document.activeElement).toBe(opener);
  });

  it("bounds visible catalog rows to 200 and reports the hidden remainder", async () => {
    vi.mocked(ipc.listCodexPlugins).mockResolvedValue({
      marketplaces: [
        {
          name: "large",
          displayName: "Large",
          plugins: Array.from({ length: 205 }, (_, index) => ({
            ...summary,
            id: `plugin-${index}`,
            name: `plugin-${index}`,
            displayName: `Plugin ${index}`,
          })),
        },
      ],
      loadErrors: [],
      featuredPluginIds: [],
    });

    render(<CodexMarketplace />);
    await screen.findByText("Plugin 0");
    expect(screen.getAllByTestId("marketplace-plugin-row")).toHaveLength(200);
    expect(screen.getByText("Showing 200 of 205 plugins")).toBeInTheDocument();
  });

  it("keeps partial catalog errors visible without hiding healthy plugins", async () => {
    vi.mocked(ipc.listCodexPlugins).mockResolvedValue({
      ...catalog,
      loadErrors: [{ sourceLabel: "team.json", message: "Could not parse marketplace" }],
    });
    render(<CodexMarketplace />);
    expect(await screen.findByText("Starter")).toBeInTheDocument();
    expect(screen.getByText(/team.json.*Could not parse marketplace/)).toBeInTheDocument();
  });

  it("bounds non-Error catalog failures behind stable user-facing copy", async () => {
    vi.mocked(ipc.listCodexPlugins).mockRejectedValue("private provider failure");
    render(<CodexMarketplace />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Codex could not load the plugin catalog.",
    );
    expect(screen.queryByText("private provider failure")).not.toBeInTheDocument();
  });

  it("searches, refreshes, dismisses notices, and reports bounded refresh failures", async () => {
    vi.mocked(ipc.upgradeCodexMarketplace)
      .mockResolvedValueOnce({
        selectedMarketplaces: ["preview"],
        upgradedCount: 1,
        errors: [],
      })
      .mockResolvedValueOnce({
        selectedMarketplaces: ["preview"],
        upgradedCount: 0,
        errors: [{ marketplaceName: "preview", message: "offline" }],
      })
      .mockRejectedValueOnce("future refresh failure");
    render(<CodexMarketplace />);
    await screen.findByText("Starter");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search plugin catalog" }), {
      target: { value: "missing" },
    });
    expect(screen.getByText("No matching plugins.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search plugin catalog" }), {
      target: { value: "preview" },
    });
    expect(screen.getByText("Starter")).toBeInTheDocument();

    const refresh = screen.getByRole("button", { name: "Refresh snapshots" });
    fireEvent.click(refresh);
    expect(await screen.findByText("Refreshed 1 marketplace snapshot.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));

    fireEvent.click(refresh);
    expect(await screen.findByText("Refreshed 0 snapshots; 1 failed.")).toBeInTheDocument();
    fireEvent.click(refresh);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Codex could not refresh marketplace snapshots.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("adds and removes trusted sources while preserving exact native confirmations", async () => {
    vi.mocked(ipc.addCodexMarketplace).mockResolvedValue({
      marketplaceName: "custom",
      alreadyAdded: false,
    });
    vi.mocked(ipc.removeCodexMarketplace).mockResolvedValue({
      marketplaceName: "preview",
      removed: true,
    });
    render(<CodexMarketplace />);
    await screen.findByText("Starter");

    fireEvent.change(screen.getByLabelText("Source URL"), {
      target: { value: "https://github.com/porthex/plugins.git" },
    });
    fireEvent.change(screen.getByLabelText("Git ref (optional)"), { target: { value: " main " } });
    fireEvent.click(screen.getByLabelText("I reviewed and trust this source."));
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() =>
      expect(ipc.addCodexMarketplace).toHaveBeenCalledWith(
        "https://github.com/porthex/plugins.git",
        "main",
        true,
      ),
    );
    expect(await screen.findByText("Marketplace added through Codex.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove source" }));
    const dialog = screen.getByRole("dialog", { name: "Remove preview" });
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(ipc.removeCodexMarketplace).toHaveBeenCalledWith("preview", true));
    expect(
      await screen.findByText("Marketplace source removed through Codex."),
    ).toBeInTheDocument();
  });

  it("formats every task cadence and uninstalls an installed plugin", async () => {
    const installedSummary = {
      ...summary,
      installed: true,
      enabled: true,
      installable: false,
      localVersion: "1.0.0",
    };
    vi.mocked(ipc.readCodexPlugin).mockResolvedValue({
      ...detail,
      summary: installedSummary,
      scheduledTasks: [
        {
          key: "hour",
          name: "Hourly",
          prompt: "H",
          schedule: { type: "hourly", intervalHours: 1, days: null },
        },
        {
          key: "hours",
          name: "Hours",
          prompt: "H2",
          schedule: { type: "hourly", intervalHours: 3, days: ["MO"] },
        },
        {
          key: "days",
          name: "Weekdays",
          prompt: "D",
          schedule: { type: "weekdays", time: "10:00" },
        },
        {
          key: "week",
          name: "Weekly",
          prompt: "W",
          schedule: { type: "weekly", days: ["MO", "FR"], time: "11:00" },
        },
      ],
    });
    vi.mocked(ipc.uninstallCodexPlugin).mockRejectedValueOnce("private removal failure");
    render(<CodexMarketplace />);
    fireEvent.click(await screen.findByRole("button", { name: /Starter/ }));
    expect(await screen.findByText("Every hour")).toBeInTheDocument();
    expect(screen.getByText("Every 3 hours · MO")).toBeInTheDocument();
    expect(screen.getByText("Weekdays at 10:00")).toBeInTheDocument();
    expect(screen.getByText("MO, FR at 11:00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove plugin" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(ipc.uninstallCodexPlugin).toHaveBeenCalledWith(summary.id, true));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Codex could not complete the action.",
    );
    expect(screen.queryByText("private removal failure")).not.toBeInTheDocument();
  });
});
