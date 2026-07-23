import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as ipc from "../lib/ipc";
import { useStore } from "../store/store";
import type { OpenAIAccountSummary, PlanUsageSnapshot } from "../types";
import { PlanUsagePanel } from "./PlanUsagePanel";

vi.mock("../lib/ipc", () => ({
  getPlanUsage: vi.fn(),
}));

const m = vi.mocked(ipc);
const initial = useStore.getState();

const account = (over: Partial<OpenAIAccountSummary> = {}): OpenAIAccountSummary => ({
  id: "00000000-0000-4000-8000-000000000001",
  accountLabel: "gpt@example.com",
  tier: "ChatGPT Plus",
  expiresAt: null,
  state: "connected",
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  ...over,
});

function usage(overrides: Partial<PlanUsageSnapshot> = {}): PlanUsageSnapshot {
  return {
    provider: "openai",
    plan: "Plus",
    updatedAt: Math.floor(Date.now() / 1000),
    windows: [
      {
        id: "session",
        label: "Current session",
        usedPercent: 20,
        resetsAt: String(Math.floor(Date.now() / 1000) + 30 * 60),
        windowMinutes: 300,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
});

describe("PlanUsagePanel", () => {
  it("routes the disconnected card to the Codex account section", () => {
    const onOpenSettings = vi.fn();
    render(<PlanUsagePanel onOpenSettings={onOpenSettings} />);

    fireEvent.click(screen.getByRole("button", { name: "Open GPT account settings" }));

    expect(onOpenSettings).toHaveBeenCalledWith("account");
  });

  it("falls back to scrolling the Codex account control into view", () => {
    const scrollIntoView = vi.fn();
    render(
      <>
        <div
          id="pc-setting-openai"
          ref={(node) => {
            if (node) node.scrollIntoView = scrollIntoView;
          }}
        />
        <PlanUsagePanel />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open GPT account settings" }));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  });

  it("keeps the Codex account disconnected and disables refresh while signed out", () => {
    render(<PlanUsagePanel />);

    expect(screen.getByRole("article", { name: "GPT plan usage" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Claude plan usage" })).not.toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh all plan usage" })).toBeDisabled();
    expect(m.getPlanUsage).not.toHaveBeenCalled();
  });

  it("omits OpenAI usage when the native build marks that capability unavailable", () => {
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

    render(<PlanUsagePanel />);

    expect(screen.queryByRole("article", { name: "GPT plan usage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Claude plan usage" })).not.toBeInTheDocument();
    expect(m.getPlanUsage).not.toHaveBeenCalled();
  });

  it("loads and refreshes only the Codex account", async () => {
    useStore.setState({
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: "gpt@example.com",
        tier: "ChatGPT Plus",
      },
      openAIAccounts: [account()],
    });
    m.getPlanUsage.mockResolvedValue(usage());

    render(<PlanUsagePanel />);

    const gptCard = screen.getByRole("article", { name: "GPT plan usage" });
    expect(
      await within(gptCard).findByRole("progressbar", { name: "Current session remaining" }),
    ).toHaveAttribute("aria-valuenow", "80");
    expect(within(gptCard).getByText("gpt@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Claude plan usage" })).not.toBeInTheDocument();
    expect(within(gptCard).getByText(/Resets in/)).toBeInTheDocument();

    fireEvent.click(within(gptCard).getByRole("button", { name: "Refresh GPT usage" }));
    await waitFor(() =>
      expect(m.getPlanUsage.mock.calls.filter(([provider]) => provider === "openai")).toHaveLength(
        2,
      ),
    );
    expect(m.getPlanUsage).toHaveBeenCalledWith("openai", "00000000-0000-4000-8000-000000000001");
    expect(m.getPlanUsage.mock.calls.every(([provider]) => provider === "openai")).toBe(true);
  });

  it("renders and requests only the codex-primary authentication slot", async () => {
    const primary = account({ id: "codex-primary" });
    const stale = account({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "stale@chatgpt.test",
    });
    useStore.setState({
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
      openAIAccounts: [stale, primary],
    });
    m.getPlanUsage.mockImplementation(async (_provider, accountProfileId) =>
      usage({
        windows: [
          {
            id: "session",
            label: "Current session",
            usedPercent: accountProfileId === primary.id ? 20 : 60,
            resetsAt: null,
            windowMinutes: 300,
          },
        ],
      }),
    );

    render(<PlanUsagePanel />);

    const card = screen.getByRole("article", { name: "GPT plan usage" });
    expect(
      await within(card).findByRole("progressbar", {
        name: "Current session remaining",
      }),
    ).toHaveAttribute("aria-valuenow", "80");
    expect(screen.queryByText("stale@chatgpt.test")).toBeNull();
    expect(m.getPlanUsage).toHaveBeenCalledWith("openai", primary.id);
    expect(m.getPlanUsage).not.toHaveBeenCalledWith("openai", stale.id);
  });

  it("never exposes a missing profile UUID in the scoped removed-account card", () => {
    const missing = "00000000-0000-4000-8000-000000000009";
    render(<PlanUsagePanel openAIAccountProfileId={missing} />);

    expect(screen.getByText("Removed ChatGPT account")).toBeInTheDocument();
    expect(screen.queryByText(missing)).not.toBeInTheDocument();
    expect(m.getPlanUsage).not.toHaveBeenCalled();
  });

  it("keeps a healthy snapshot visible when a later refresh fails", async () => {
    useStore.setState({
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: "gpt@example.com",
        tier: "ChatGPT Plus",
      },
      openAIAccounts: [account()],
    });
    m.getPlanUsage.mockResolvedValueOnce(
      usage({
        updatedAt: Math.floor(Date.now() / 1000) - 2 * 60 * 60,
        windows: [
          {
            id: "weekly",
            label: "Weekly limit",
            usedPercent: 95,
            resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
            windowMinutes: 10_080,
          },
        ],
      }),
    );

    render(<PlanUsagePanel />);
    const card = screen.getByRole("article", { name: "GPT plan usage" });
    expect(
      await within(card).findByRole("progressbar", { name: "Weekly limit remaining" }),
    ).toHaveAttribute("aria-valuenow", "5");
    expect(within(card).getByText(/Updated 2h ago/)).toBeInTheDocument();

    m.getPlanUsage.mockRejectedValueOnce(new Error("usage endpoint offline"));
    fireEvent.click(within(card).getByRole("button", { name: "Refresh GPT usage" }));

    expect(await within(card).findByText("Last update kept · refresh failed")).toBeInTheDocument();
    expect(within(card).getByRole("alert")).toHaveTextContent("usage endpoint offline");
    expect(
      within(card).getByRole("progressbar", { name: "Weekly limit remaining" }),
    ).toHaveAttribute("aria-valuenow", "5");
  });

  it("shows an initial Codex usage error and recovers through Refresh all", async () => {
    useStore.setState({
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: null,
        tier: "ChatGPT Pro",
        available: true,
      },
      openAIAccounts: [account({ tier: "ChatGPT Pro" })],
    });
    m.getPlanUsage
      .mockRejectedValueOnce(new Error("Codex usage unavailable"))
      .mockResolvedValueOnce(
        usage({
          plan: null,
          windows: [
            {
              id: "unknown-reset",
              label: "Model limit",
              usedPercent: -20,
              resetsAt: "not-a-date",
              windowMinutes: null,
            },
          ],
        }),
      );

    render(<PlanUsagePanel />);
    const card = screen.getByRole("article", { name: "GPT plan usage" });
    expect(await within(card).findByText("Usage unavailable")).toBeInTheDocument();
    expect(within(card).getByRole("alert")).toHaveTextContent("Codex usage unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Refresh all plan usage" }));

    expect(
      await within(card).findByRole("progressbar", { name: "Model limit remaining" }),
    ).toHaveAttribute("aria-valuenow", "100");
    expect(within(card).getByText("Reset time unavailable")).toBeInTheDocument();
    expect(within(card).getByText("Pro")).toBeInTheDocument();
  });
});
