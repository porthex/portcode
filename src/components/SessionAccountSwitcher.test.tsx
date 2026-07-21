import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as ipc from "../lib/ipc";
import { useStore } from "../store/store";
import { DEFAULT_SETTINGS, type OpenAIAccountSummary, type Session } from "../types";
import { SessionAccountSwitcher } from "./SessionAccountSwitcher";

vi.mock("../lib/ipc", () => ({
  openaiModels: vi.fn(),
  pinSessionOpenAIAccount: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
}));

const m = vi.mocked(ipc);
const initial = useStore.getState();
const model = {
  id: "gpt-live",
  label: "GPT Live",
  provider: "openai" as const,
  reasoningEfforts: ["high" as const],
  defaultReasoningEffort: "high" as const,
};

const account = (over: Partial<OpenAIAccountSummary> = {}): OpenAIAccountSummary => ({
  id: "00000000-0000-4000-8000-000000000001",
  accountLabel: "one@chatgpt.test",
  tier: "ChatGPT Plus",
  expiresAt: null,
  state: "connected",
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  ...over,
});

const chat = (over: Partial<Session> = {}): Session => ({
  id: "chat-1",
  title: "Account-scoped chat",
  workspace: null,
  branch: null,
  model: model.id,
  accountProfileId: "00000000-0000-4000-8000-000000000001",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function Harness() {
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeId),
  );
  return session ? <SessionAccountSwitcher session={session} /> : null;
}

function seed() {
  const first = account();
  const second = account({
    id: "00000000-0000-4000-8000-000000000002",
    accountLabel: "two@chatgpt.test",
    tier: "ChatGPT Team",
  });
  const session = chat({ accountProfileId: first.id });
  useStore.setState({
    sessions: [session],
    activeId: session.id,
    settings: { ...DEFAULT_SETTINGS, provider: "openai", model: model.id },
    openAIAuthStatus: {
      signedIn: true,
      expiresAt: null,
      account: null,
      tier: null,
      available: true,
    },
    openAIAccounts: [first, second],
    openAIModels: [model],
    openAIModelCatalogs: {
      [first.id]: { status: "ready", models: [model], error: null },
      [second.id]: { status: "ready", models: [model], error: null },
    },
    lastOpenAIAccountProfileId: first.id,
  });
  return { first, second, session };
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
  m.openaiModels.mockResolvedValue([model]);
  m.listSessions.mockResolvedValue([]);
  m.pinSessionOpenAIAccount.mockImplementation(async (sessionId, accountProfileId, nextModel) =>
    chat({ id: sessionId, accountProfileId, model: nextModel ?? model.id }),
  );
  m.createSession.mockImplementation(async (id, title, workspace, nextModel, accountProfileId) =>
    chat({ id, title, workspace, model: nextModel, accountProfileId }),
  );
});

describe("SessionAccountSwitcher", () => {
  it("switches an unstarted chat to another connected account", async () => {
    const { second, session } = seed();
    render(<Harness />);

    fireEvent.click(screen.getByRole("combobox", { name: "ChatGPT account for this chat" }));
    fireEvent.click(screen.getByRole("option", { name: /two@chatgpt\.test/i }));

    await waitFor(() => expect(useStore.getState().sessions[0].accountProfileId).toBe(second.id));
    expect(m.pinSessionOpenAIAccount).toHaveBeenCalledWith(session.id, second.id, model.id);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps a started chat unchanged and continues with the selected account in a new chat", async () => {
    const { first, second, session } = seed();
    m.pinSessionOpenAIAccount.mockRejectedValueOnce(
      new Error(
        "This conversation has already started. Continue with another ChatGPT account in a new chat.",
      ),
    );
    render(<Harness />);

    fireEvent.click(screen.getByRole("combobox", { name: "ChatGPT account for this chat" }));
    fireEvent.click(screen.getByRole("option", { name: /two@chatgpt\.test/i }));

    const dialog = await screen.findByRole("dialog", { name: "Continue with another account?" });
    expect(dialog).toHaveTextContent("one@chatgpt.test");
    expect(dialog).toHaveTextContent("two@chatgpt.test");
    expect(useStore.getState().sessions[0].accountProfileId).toBe(first.id);

    fireEvent.click(screen.getByRole("button", { name: "Continue in new chat" }));

    await waitFor(() => expect(useStore.getState().sessions).toHaveLength(2));
    expect(
      useStore.getState().sessions.find((candidate) => candidate.id === session.id),
    ).toMatchObject({
      accountProfileId: first.id,
    });
    expect(useStore.getState().sessions[0].accountProfileId).toBe(second.id);
    expect(m.createSession).toHaveBeenCalledWith(
      expect.any(String),
      "New chat",
      null,
      model.id,
      second.id,
    );
  });

  it("does not render account controls when there is only one connected account", () => {
    const { first } = seed();
    act(() => useStore.setState({ openAIAccounts: [first] }));

    render(<Harness />);

    expect(
      screen.queryByRole("combobox", { name: "ChatGPT account for this chat" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the current account and exposes a compact error when switching fails", async () => {
    const { first, second } = seed();
    m.pinSessionOpenAIAccount.mockRejectedValueOnce(new Error("catalogue offline"));
    render(<Harness />);

    fireEvent.click(screen.getByRole("combobox", { name: "ChatGPT account for this chat" }));
    fireEvent.click(screen.getByRole("option", { name: /two@chatgpt\.test/i }));

    expect(await screen.findByRole("alert")).toHaveAttribute("title", "catalogue offline");
    expect(useStore.getState().sessions[0].accountProfileId).toBe(first.id);
    expect(useStore.getState().sessions[0].accountProfileId).not.toBe(second.id);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables account switching while the active chat is running", () => {
    seed();
    useStore.setState({ streaming: true });

    render(<Harness />);

    expect(screen.getByRole("combobox", { name: "ChatGPT account for this chat" })).toBeDisabled();
  });

  it("does not expose an unavailable account's local profile id", () => {
    const { first, second, session } = seed();
    const removedId = "00000000-0000-4000-8000-000000000099";
    useStore.setState({
      sessions: [{ ...session, accountProfileId: removedId }],
      openAIAccounts: [
        first,
        second,
        account({ id: removedId, accountLabel: null, state: "removed", expiresAt: null }),
      ],
    });

    const { container } = render(<Harness />);

    expect(container).not.toHaveTextContent(removedId);
    expect(
      screen.getByRole("combobox", { name: "ChatGPT account for this chat" }),
    ).toHaveTextContent(/ChatGPT account \d+ · unavailable/);
  });

  it("offers the sole connected replacement for an unavailable current account", () => {
    const { first, session } = seed();
    const removedId = "00000000-0000-4000-8000-000000000099";
    useStore.setState({
      sessions: [{ ...session, accountProfileId: removedId }],
      openAIAccounts: [
        first,
        account({ id: removedId, accountLabel: null, state: "removed", expiresAt: null }),
      ],
    });

    render(<Harness />);

    fireEvent.click(screen.getByRole("combobox", { name: "ChatGPT account for this chat" }));
    expect(screen.getByRole("option", { name: "one@chatgpt.test" })).toBeInTheDocument();
  });
});
