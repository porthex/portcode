import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as ipc from "../lib/ipc";
import { useStore } from "../store/store";
import type { OpenAIAccountSummary, PlanUsageSnapshot, ProviderId } from "../types";
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

function usage(
  provider: ProviderId,
  overrides: Partial<PlanUsageSnapshot> = {},
): PlanUsageSnapshot {
  return {
    provider,
    plan: provider === "openai" ? "Plus" : "Max",
    updatedAt: Math.floor(Date.now() / 1000),
    windows: [
      {
        id: "session",
        label: "Current session",
        usedPercent: provider === "openai" ? 20 : 78,
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
  it("keeps both providers disconnected and disables refresh while signed out", () => {
    render(<PlanUsagePanel />);

    expect(screen.getAllByText("Not connected")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Refresh all plan usage" })).toBeDisabled();
    expect(m.getPlanUsage).not.toHaveBeenCalled();
  });

  it("can scope the quick view to only the active chat provider", () => {
    render(<PlanUsagePanel onlyProvider="openai" />);

    expect(screen.getByRole("article", { name: "GPT plan usage" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Claude plan usage" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Not connected")).toHaveLength(1);
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
    expect(screen.getByRole("article", { name: "Claude plan usage" })).toBeInTheDocument();
    expect(screen.getAllByText("Not connected")).toHaveLength(1);
    expect(m.getPlanUsage).not.toHaveBeenCalled();
  });

  it("loads both providers independently and refreshes one account", async () => {
    useStore.setState({
      oauthStatus: {
        signedIn: true,
        expiresAt: null,
        account: "claude@example.com",
        tier: "Claude Max",
      },
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: "gpt@example.com",
        tier: "ChatGPT Plus",
      },
      openAIAccounts: [account()],
    });
    m.getPlanUsage.mockImplementation(async (provider) => usage(provider));

    render(<PlanUsagePanel />);

    const gptCard = screen.getByRole("article", { name: "GPT plan usage" });
    const claudeCard = screen.getByRole("article", { name: "Claude plan usage" });
    expect(
      await within(gptCard).findByRole("progressbar", { name: "Current session remaining" }),
    ).toHaveAttribute("aria-valuenow", "80");
    expect(
      await within(claudeCard).findByRole("progressbar", { name: "Current session remaining" }),
    ).toHaveAttribute("aria-valuenow", "22");
    expect(within(gptCard).getByText("gpt@example.com")).toBeInTheDocument();
    expect(within(claudeCard).getByText("claude@example.com")).toBeInTheDocument();
    expect(within(gptCard).getByText(/Resets in/)).toBeInTheDocument();

    fireEvent.click(within(gptCard).getByRole("button", { name: "Refresh GPT usage" }));
    await waitFor(() =>
      expect(m.getPlanUsage.mock.calls.filter(([provider]) => provider === "openai")).toHaveLength(
        2,
      ),
    );
    expect(m.getPlanUsage).toHaveBeenCalledWith("openai", "00000000-0000-4000-8000-000000000001");
    expect(m.getPlanUsage).toHaveBeenCalledWith("anthropic", null);
  });

  it("renders and requests each ChatGPT profile independently", async () => {
    const first = account();
    const second = account({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "second@chatgpt.test",
    });
    useStore.setState({
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
      openAIAccounts: [first, second],
    });
    m.getPlanUsage.mockImplementation(async (provider, accountProfileId) =>
      usage(provider, {
        windows: [
          {
            id: "session",
            label: "Current session",
            usedPercent: accountProfileId === second.id ? 60 : 20,
            resetsAt: null,
            windowMinutes: 300,
          },
        ],
      }),
    );

    render(<PlanUsagePanel onlyProvider="openai" />);

    const firstCard = screen.getByRole("article", {
      name: "GPT plan usage for gpt@example.com",
    });
    const secondCard = screen.getByRole("article", {
      name: "GPT plan usage for second@chatgpt.test",
    });
    expect(
      await within(firstCard).findByRole("progressbar", {
        name: "Current session remaining",
      }),
    ).toHaveAttribute("aria-valuenow", "80");
    expect(
      await within(secondCard).findByRole("progressbar", {
        name: "Current session remaining",
      }),
    ).toHaveAttribute("aria-valuenow", "40");
    expect(m.getPlanUsage).toHaveBeenCalledWith("openai", first.id);
    expect(m.getPlanUsage).toHaveBeenCalledWith("openai", second.id);
  });

  it("never exposes a missing profile UUID in the scoped removed-account card", () => {
    const missing = "00000000-0000-4000-8000-000000000009";
    render(<PlanUsagePanel onlyProvider="openai" openAIAccountProfileId={missing} />);

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
      usage("openai", {
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

  it("shows an initial provider error and recovers through Refresh all", async () => {
    useStore.setState({
      oauthStatus: {
        signedIn: true,
        expiresAt: null,
        account: null,
        tier: "Claude Pro",
      },
    });
    m.getPlanUsage
      .mockRejectedValueOnce(new Error("Claude usage unavailable"))
      .mockResolvedValueOnce(
        usage("anthropic", {
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
    const card = screen.getByRole("article", { name: "Claude plan usage" });
    expect(await within(card).findByText("Usage unavailable")).toBeInTheDocument();
    expect(within(card).getByRole("alert")).toHaveTextContent("Claude usage unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Refresh all plan usage" }));

    expect(
      await within(card).findByRole("progressbar", { name: "Model limit remaining" }),
    ).toHaveAttribute("aria-valuenow", "100");
    expect(within(card).getByText("Reset time unavailable")).toBeInTheDocument();
    expect(within(card).getByText("Pro")).toBeInTheDocument();
  });
});
