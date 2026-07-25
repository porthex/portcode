import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";

import { Composer } from "./Composer";
import { useStore } from "../store/store";
import {
  type Attachment,
  DEFAULT_SETTINGS,
  OPENAI_FALLBACK_MODELS,
  type ComposerPhase,
  type OpenAIAccountSummary,
  type Session,
  type TurnReceipt,
  type Usage,
} from "../types";

// The Composer is a thin view over the real store: it binds the ACTIVE session's
// draft and calls the store's send/stop actions, which reach the IPC bridge. We
// mock only the IPC layer (so `send` can't spawn the real mock-agent, and the
// debounced draft save never hits a backend) and drive the actual store, asserting
// on observable DOM + store state. House style mirrors store.test.ts / smoke.test.tsx.
vi.mock("../lib/ipc", () => ({
  runAgent: vi.fn(),
  openFolder: vi.fn(),
  pickAttachmentPaths: vi.fn(),
  validateAttachments: vi.fn(),
  onNativeFileDrop: vi.fn(async () => () => {}),
  // setSessionModel persists the active chat, then updateSettings mirrors it as
  // the default for future chats.
  updateSessionModel: vi.fn(),
  saveSettings: vi.fn(),
  saveDraft: vi.fn(),
  openaiModels: vi.fn(),
  pinSessionOpenAIAccount: vi.fn(),
  listSessions: vi.fn(),
}));

import * as ipc from "../lib/ipc";

const m = vi.mocked(ipc);

// Snapshot a pristine store once, restore it (zustand has no built-in reset)
// before every test so cross-test state never leaks.
// Keep a detached top-level snapshot. Re-installing the store's live object and
// then rendering a component lets later state writes leak into the baseline.
const initial = { ...useStore.getState() };

const run = (over: Partial<(typeof initial.runs)[string]> = {}): (typeof initial.runs)[string] => ({
  streaming: false,
  cancel: null,
  pendingPermission: null,
  turnId: null,
  startedAt: null,
  finalizing: false,
  agentDurationMs: null,
  phaseRevision: 0,
  receipt: null,
  outcome: null,
  composerPhase: "idle",
  activeTool: null,
  unseenOutcome: null,
  ...over,
});

const receipt = (over: Partial<TurnReceipt> = {}): TurnReceipt => ({
  turnId: "turn-1",
  status: "completed",
  stopReason: "end_turn",
  startedAt: 1_000,
  completedAt: 3_000,
  durationMs: 2_000,
  agentDurationMs: 2_000,
  changedFiles: [],
  changedFileCount: 0,
  additions: 0,
  deletions: 0,
  filesTruncated: false,
  changeCertainty: "unavailable",
  changeState: "unknown",
  backgroundTasksRunning: false,
  ...over,
});

const sendButton = () => screen.getByTitle("Send (Enter)");
const stopButton = () => screen.getByTitle("Stop");
const textarea = () => screen.getByRole("textbox", { name: "Message Portcode" });

// Seed an active session with a draft (drafts are keyed by activeId now).
const seedDraft = (text: string, id = "a") =>
  useStore.setState({ activeId: id, drafts: { [id]: text } });

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(initial, true);
  // Most composer tests exercise drafting/streaming, not auth. Seed the single
  // Codex account slot; auth-specific cases override it.
  useStore.setState({
    settings: DEFAULT_SETTINGS,
    sessions: [session()],
    activeId: "a",
    openAIAuthStatus: {
      signedIn: true,
      expiresAt: null,
      account: "OpenAI Platform API key",
      tier: null,
      available: true,
    },
    openAIAccounts: [
      openAIAccount({
        id: "codex-primary",
        accountLabel: "OpenAI Platform API key",
        tier: null,
      }),
    ],
    openAIModels: OPENAI_FALLBACK_MODELS,
    openAIModelCatalogs: {
      "codex-primary": { status: "ready", models: OPENAI_FALLBACK_MODELS, error: null },
    },
    lastOpenAIAccountProfileId: "codex-primary",
  });
  // Default: runAgent resolves to a cancellable handle so `send` starts a turn
  // without ever touching a real backend.
  m.runAgent.mockResolvedValue({ cancel: vi.fn(async () => {}), dispose: vi.fn() });
  m.openFolder.mockResolvedValue(null);
  m.pickAttachmentPaths.mockResolvedValue([]);
  m.validateAttachments.mockResolvedValue({ attachments: [], errors: [] });
  m.updateSessionModel.mockResolvedValue(undefined);
  m.saveSettings.mockImplementation(async (s) => ({ ...DEFAULT_SETTINGS, ...s }));
  m.saveDraft.mockResolvedValue(undefined);
  m.openaiModels.mockResolvedValue([]);
  m.listSessions.mockResolvedValue([]);
  m.pinSessionOpenAIAccount.mockImplementation(async (sessionId, accountProfileId) =>
    session({ id: sessionId, model: "gpt-live", accountProfileId }),
  );
});

const session = (over: Partial<Session> = {}): Session => ({
  id: "a",
  title: "New chat",
  workspace: null,
  model: "gpt-5.6-terra",
  accountProfileId: "codex-primary",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const openAIAccount = (over: Partial<OpenAIAccountSummary> = {}): OpenAIAccountSummary => ({
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

const attachment = (over: Partial<Attachment> = {}): Attachment => {
  const name = over.name ?? "example.rs";
  return {
    path: "C:/fixtures/example.rs",
    name,
    displayName: over.displayName ?? name,
    kind: "text",
    mediaType: "text/x-rust",
    size: 1536,
    thumbnailUrl: null,
    ...over,
  };
};

describe("Composer attachments", () => {
  it("picks multiple files and renders accessible metadata and removal", async () => {
    const code = attachment();
    const image = attachment({
      path: "C:/fixtures/pixel.png",
      name: "pixel.png",
      kind: "image",
      mediaType: "image/png",
      size: 68,
      thumbnailUrl: "data:image/png;base64,synthetic",
    });
    const extensionless = attachment({
      path: "C:/fixtures/README",
      name: "README",
      size: 2 * 1024 * 1024,
    });
    m.pickAttachmentPaths.mockResolvedValue([code.path, image.path, extensionless.path]);
    m.validateAttachments.mockResolvedValue({
      attachments: [code, image, extensionless],
      errors: [],
    });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));

    expect(await screen.findByText("example.rs")).toBeInTheDocument();
    expect(screen.getByText("RS · 1.5 KiB")).toBeInTheDocument();
    expect(screen.getByText("PNG · 68 B")).toBeInTheDocument();
    expect(screen.getByText("TEXT · 2.0 MiB")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Preview pixel.png" })).toHaveAttribute(
      "src",
      image.thumbnailUrl,
    );
    const remove = screen.getByRole("button", { name: "Remove example.rs" });
    fireEvent.click(remove);
    expect(screen.queryByText("example.rs")).not.toBeInTheDocument();
    expect(screen.getByText("pixel.png")).toBeInTheDocument();
  });

  it("moves focus to a logical composer control after Remove and Dismiss unmount", async () => {
    const first = attachment({ path: "C:/first.txt", name: "first.txt" });
    const second = attachment({ path: "C:/second.txt", name: "second.txt" });
    const third = attachment({ path: "C:/third.txt", name: "third.txt" });
    useStore.setState({
      attachments: { a: [first, second, third] },
      attachmentErrors: { a: "archive.zip: unsupported" },
    });
    render(<Composer />);

    const firstRemove = screen.getByRole("button", { name: "Remove first.txt" });
    firstRemove.focus();
    fireEvent.click(firstRemove);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove second.txt" })).toHaveFocus(),
    );

    const dismiss = screen.getByRole("button", { name: "Dismiss attachment error" });
    dismiss.focus();
    fireEvent.click(dismiss);
    await waitFor(() => expect(screen.getByRole("button", { name: "Attach files" })).toHaveFocus());
  });

  it("keeps duplicate review identities collision-free and stable as the tray changes", () => {
    const first = attachment({
      path: "C:/fixtures/alpha/index.ts",
      name: "index.ts",
      displayName: undefined,
    });
    const second = attachment({
      path: "C:/fixtures/beta/index.ts",
      name: "index.ts",
      displayName: undefined,
      kind: "image",
      mediaType: "image/png",
      thumbnailUrl: "data:image/png;base64,synthetic",
    });
    const reservedCollision = attachment({
      path: "C:/fixtures/gamma/index-qualified.ts",
      name: "index.ts <attachment 1>",
      displayName: undefined,
    });
    useStore.setState({ attachments: { a: [first, second, reservedCollision] } });

    render(<Composer />);

    expect(screen.getByText("index.ts <attachment 1>")).toBeInTheDocument();
    expect(screen.getByText("index.ts <attachment 2>")).toBeInTheDocument();
    expect(screen.getByText("index.ts <attachment 3>")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Preview index.ts <attachment 3>" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove index.ts <attachment 2>" })).toHaveAttribute(
      "title",
      "Remove index.ts <attachment 2>",
    );
    expect(screen.getByRole("button", { name: "Remove index.ts <attachment 3>" })).toHaveAttribute(
      "title",
      "Remove index.ts <attachment 3>",
    );

    act(() => useStore.setState({ streaming: true }));
    expect(screen.getByRole("button", { name: "Remove index.ts <attachment 3>" })).toHaveAttribute(
      "title",
      "Remove index.ts <attachment 3> — attachments are locked during a turn",
    );
    act(() => useStore.setState({ streaming: false }));

    act(() => useStore.setState({ attachments: { a: [reservedCollision, second, first] } }));
    expect(screen.getByText("index.ts <attachment 2>")).toBeInTheDocument();
    expect(screen.getByText("index.ts <attachment 3>")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove index.ts <attachment 3>" }));
    expect(screen.getByText("index.ts <attachment 2>")).toBeInTheDocument();
    expect(screen.queryByText("index.ts <attachment 3>")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/fixtures|alpha|beta|gamma/i);
  });

  it("renders the immutable admitted display identity after a duplicate peer is gone", () => {
    const survivor = attachment({
      path: "C:/fixtures/beta/index.ts",
      name: "index.ts",
      displayName: "index.ts <attachment 2>",
    });
    useStore.setState({ attachments: { a: [survivor] } });

    render(<Composer />);

    expect(screen.getByText("index.ts <attachment 2>")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove index.ts <attachment 2>" })).toBeVisible();
    expect(document.body.innerHTML).not.toContain("fixtures/beta");
  });

  it("isolates duplicate review identities between sessions", () => {
    const shared = attachment({
      path: "C:/shared/index.ts",
      name: "index.ts",
      displayName: undefined,
    });
    const firstPeer = attachment({
      path: "C:/first/index.ts",
      name: "index.ts",
      displayName: undefined,
    });
    const collision = attachment({
      path: "C:/second/reserved.ts",
      name: "index.ts <attachment 1>",
      displayName: undefined,
    });
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      attachments: { a: [shared, firstPeer], b: [shared, collision] },
    });

    render(<Composer />);
    expect(screen.getByText("index.ts <attachment 1>")).toBeInTheDocument();
    expect(screen.getByText("index.ts <attachment 2>")).toBeInTheDocument();

    act(() => useStore.setState({ activeId: "b" }));
    expect(screen.getByText("index.ts")).toBeInTheDocument();
    expect(screen.getByText("index.ts <attachment 1>")).toBeInTheDocument();

    act(() => useStore.setState({ activeId: "a" }));
    expect(screen.getByText("index.ts <attachment 1>")).toBeInTheDocument();
    expect(screen.getByText("index.ts <attachment 2>")).toBeInTheDocument();
  });

  it("keeps visible attachments scoped to the active session", () => {
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      attachments: {
        a: [attachment({ name: "a.txt", path: "C:/a.txt" })],
        b: [attachment({ name: "b.txt", path: "C:/b.txt" })],
      },
    });
    render(<Composer />);
    expect(screen.getByText("a.txt")).toBeInTheDocument();
    expect(screen.queryByText("b.txt")).not.toBeInTheDocument();

    act(() => useStore.setState({ activeId: "b" }));
    expect(screen.getByText("b.txt")).toBeInTheDocument();
    expect(screen.queryByText("a.txt")).not.toBeInTheDocument();
  });

  it("renders multiple validation issues as a readable list", async () => {
    const valid = attachment();
    m.pickAttachmentPaths.mockResolvedValue([valid.path, "C:/bad-a.zip", "C:/bad-b.exe"]);
    m.validateAttachments.mockResolvedValue({
      attachments: [valid],
      errors: [
        { name: "bad-a.zip", message: "Unsupported archive." },
        { name: "bad-b.exe", message: "Unsupported executable." },
      ],
    });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));

    const alert = await screen.findByRole("alert");
    const issueList = within(alert).getByRole("list", { name: "Attachment validation issues" });
    expect(issueList).toHaveAttribute("tabindex", "0");
    const issues = within(issueList).getAllByRole("listitem");
    expect(issues).toHaveLength(2);
    expect(issues[0]).toHaveTextContent("bad-a.zip: Unsupported archive.");
    expect(issues[1]).toHaveTextContent("bad-b.exe: Unsupported executable.");
  });

  it("shows picker failures and lets the user retry opening the picker", async () => {
    const valid = attachment();
    m.pickAttachmentPaths
      .mockRejectedValueOnce(new Error("File picker unavailable"))
      .mockResolvedValueOnce([valid.path]);
    m.validateAttachments.mockResolvedValue({ attachments: [valid], errors: [] });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("File picker unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry attachment picker" }));

    await waitFor(() => expect(m.pickAttachmentPaths).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("example.rs")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("labels attachment send preacceptance without calling it validation or active reading", () => {
    useStore.setState({
      attachments: { a: [attachment()] },
      attachmentBusy: { a: true },
      streaming: true,
      composerPhase: "received",
    });

    render(<Composer />);

    expect(screen.getByText("awaiting acceptance…")).toBeInTheDocument();
    expect(screen.queryByText("Checking files…")).not.toBeInTheDocument();
    expect(screen.queryByText("got it — reading…")).not.toBeInTheDocument();
  });

  it("presents a preacceptance send failure as an alert with explicit Retry Send", () => {
    const retrySend = vi.fn(async () => {});
    useStore.setState({
      attachments: { a: [attachment()] },
      attachmentErrors: { a: "Your message and files were not sent. Retry safely." },
      attachmentSendErrors: { a: true },
      drafts: { a: "Inspect this" },
      send: retrySend,
    });

    render(<Composer />);

    const alert = screen.getByRole("alert");
    const retry = within(alert).getByRole("button", { name: "Retry Send" });
    fireEvent.click(retry);
    expect(retrySend).toHaveBeenCalledWith("Inspect this");
  });

  it("retries a failed validation transport with the preserved request", async () => {
    const valid = attachment();
    m.pickAttachmentPaths.mockResolvedValue([valid.path]);
    m.validateAttachments
      .mockRejectedValueOnce(new Error("native transport unavailable"))
      .mockResolvedValueOnce({ attachments: [valid], errors: [] });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    expect(await screen.findByText("native transport unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry attachment validation" }));

    await waitFor(() => expect(m.validateAttachments).toHaveBeenCalledTimes(2));
    expect(m.validateAttachments).toHaveBeenNthCalledWith(2, [valid.path]);
    expect(await screen.findByText("example.rs")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach files" })).toHaveFocus();
  });

  it("does not steal focus when a retry completes after switching sessions", async () => {
    let finish!: (value: { attachments: Attachment[]; errors: [] }) => void;
    m.validateAttachments.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    useStore.setState({
      sessions: [session({ id: "a" }), session({ id: "b" })],
      activeId: "a",
      attachmentErrors: { a: "native transport unavailable" },
      attachmentRetryPaths: { a: ["C:/fixtures/example.rs"] },
    });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "Retry attachment validation" }));
    act(() => useStore.setState({ activeId: "b" }));
    const formattingHelp = screen.getByRole("button", { name: "Formatting help" });
    formattingHelp.focus();
    finish({ attachments: [attachment()], errors: [] });
    await waitFor(() => expect(useStore.getState().attachmentBusy.a).toBe(false));

    expect(formattingHelp).toHaveFocus();
  });

  it("enables attachment-only send and displays validation errors without losing valid files", async () => {
    const valid = attachment();
    useStore.setState({
      attachments: { a: [valid] },
      attachmentErrors: { a: "archive.zip: This file type is not supported." },
    });
    render(<Composer />);

    expect(screen.getByRole("alert")).toHaveTextContent("archive.zip");
    expect(screen.getByText("example.rs")).toBeInTheDocument();
    expect(sendButton()).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss attachment error" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(m.runAgent).toHaveBeenCalledWith(
        "a",
        "",
        expect.any(Function),
        [valid.path],
        [valid.displayName],
      ),
    );
  });

  it("attaches dropped and pasted files when the host exposes local paths", async () => {
    const dropped = attachment({ path: "C:/fixtures/drop.txt", name: "drop.txt" });
    const pasted = attachment({ path: "C:/fixtures/paste.txt", name: "paste.txt" });
    m.validateAttachments
      .mockResolvedValueOnce({ attachments: [dropped], errors: [] })
      .mockResolvedValueOnce({ attachments: [dropped, pasted], errors: [] });
    render(<Composer />);
    const target = screen.getByTestId("composer-drop-zone");
    const dropFile = new File(["drop"], "drop.txt", { type: "text/plain" });
    Object.defineProperty(dropFile, "path", { value: dropped.path });
    const dragData = { files: [dropFile], dropEffect: "none" };
    fireEvent.dragEnter(target, { dataTransfer: dragData });
    expect(target).toHaveAttribute("data-drag-active", "true");
    fireEvent.dragOver(target, { dataTransfer: dragData });
    expect(dragData.dropEffect).toBe("copy");
    fireEvent.dragLeave(target, { dataTransfer: dragData, relatedTarget: document.body });
    expect(target).not.toHaveAttribute("data-drag-active");
    fireEvent.dragEnter(target, { dataTransfer: dragData });
    fireEvent.drop(target, { dataTransfer: { files: [dropFile] } });
    expect(await screen.findByText("drop.txt")).toBeInTheDocument();

    const pasteFile = new File(["paste"], "paste.txt", { type: "text/plain" });
    Object.defineProperty(pasteFile, "path", { value: pasted.path });
    fireEvent.paste(target, { clipboardData: { files: [pasteFile] } });
    expect(await screen.findByText("paste.txt")).toBeInTheDocument();

    const pathless = new File(["browser-only"], "browser-only.txt", { type: "text/plain" });
    const validations = m.validateAttachments.mock.calls.length;
    fireEvent.paste(target, { clipboardData: { files: [pathless] } });
    expect(m.validateAttachments).toHaveBeenCalledTimes(validations);
  });

  it("accepts native desktop drops only when their logical position is over the composer", async () => {
    const native = attachment({ path: "C:/fixtures/native.rs", name: "native.rs" });
    m.validateAttachments.mockResolvedValue({ attachments: [native], errors: [] });
    const unlisten = vi.fn();
    let nativeHandler!: Parameters<typeof ipc.onNativeFileDrop>[0];
    m.onNativeFileDrop.mockImplementation(async (handler) => {
      nativeHandler = handler;
      return unlisten;
    });
    const { unmount } = render(<Composer />);
    const target = screen.getByTestId("composer-drop-zone");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 410,
      bottom: 220,
      width: 400,
      height: 200,
      toJSON: () => ({}),
    });
    await waitFor(() => expect(m.onNativeFileDrop).toHaveBeenCalledOnce());

    act(() => nativeHandler({ type: "enter", paths: [native.path], x: 500, y: 500 }));
    expect(target).not.toHaveAttribute("data-drag-active");
    act(() => nativeHandler({ type: "over", x: 30, y: 40 }));
    expect(target).toHaveAttribute("data-drag-active", "true");
    act(() => nativeHandler({ type: "leave" }));
    expect(target).not.toHaveAttribute("data-drag-active");
    act(() => nativeHandler({ type: "enter", paths: [native.path], x: 30, y: 40 }));
    expect(target).toHaveAttribute("data-drag-active", "true");
    act(() => nativeHandler({ type: "drop", paths: [native.path], x: 30, y: 40 }));
    expect(await screen.findByText("native.rs")).toBeInTheDocument();
    expect(target).not.toHaveAttribute("data-drag-active");

    unmount();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("fails closed when native drop registration is unavailable", async () => {
    m.onNativeFileDrop.mockRejectedValueOnce(new Error("webview listener unavailable"));
    render(<Composer />);
    const target = screen.getByTestId("composer-drop-zone");

    await waitFor(() => expect(m.onNativeFileDrop).toHaveBeenCalledOnce());
    expect(target).not.toHaveAttribute("data-drag-active");
  });

  it("disposes a native drop listener that resolves after unmount", async () => {
    const unlisten = vi.fn();
    let finish!: (unlisten: () => void) => void;
    m.onNativeFileDrop.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const { unmount } = render(<Composer />);
    await waitFor(() => expect(m.onNativeFileDrop).toHaveBeenCalledOnce());

    unmount();
    finish(unlisten);
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });

  it("ignores empty browser gestures and drops while remote", async () => {
    render(<Composer />);
    const target = screen.getByTestId("composer-drop-zone");
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(m.pickAttachmentPaths).toHaveBeenCalledOnce());
    fireEvent.dragEnter(target, { dataTransfer: { files: [] } });
    fireEvent.dragOver(target, { dataTransfer: { files: [], dropEffect: "none" } });
    fireEvent.dragLeave(target, { relatedTarget: target.firstElementChild });
    fireEvent.drop(target, { dataTransfer: { files: [] } });
    fireEvent.paste(target, { clipboardData: { files: [] } });

    const remoteFile = new File(["remote"], "remote.txt", { type: "text/plain" });
    Object.defineProperty(remoteFile, "path", { value: "C:/fixtures/remote.txt" });
    act(() => useStore.setState({ remoteMode: true }));
    fireEvent.drop(target, { dataTransfer: { files: [remoteFile] } });

    expect(m.validateAttachments).not.toHaveBeenCalled();
    expect(target).not.toHaveAttribute("data-drag-active");
  });

  it("hides local attachment affordances remotely and freezes them during a turn", () => {
    const file = attachment();
    useStore.setState({ attachments: { a: [file] } });
    const { rerender } = render(<Composer />);
    expect(screen.getByRole("button", { name: "Attach files" })).toBeEnabled();

    act(() =>
      useStore.setState({
        runs: { a: run({ streaming: true }) },
        streaming: true,
      }),
    );
    expect(screen.getByRole("button", { name: "Attach files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove example.rs" })).toBeDisabled();

    act(() => useStore.setState({ remoteMode: true, streaming: false, runs: {} }));
    rerender(<Composer />);
    expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
    expect(screen.queryByText("example.rs")).not.toBeInTheDocument();
  });
});

describe("Composer rich editor", () => {
  it("reflects the active session's Markdown draft", () => {
    seedDraft("seed");
    render(<Composer />);

    expect(textarea()).toHaveTextContent("seed");
  });

  it("shows only the ACTIVE session's draft (no cross-session bleed)", () => {
    // The bug per-session drafts fix: a half-written message in one session must not
    // appear in another. Two sessions hold distinct drafts; only the active shows.
    useStore.setState({ activeId: "a", drafts: { a: "draft A", b: "draft B" } });
    const { rerender } = render(<Composer />);
    expect(textarea()).toHaveTextContent("draft A");

    act(() => useStore.setState({ activeId: "b" }));
    rerender(<Composer />);
    expect(textarea()).toHaveTextContent("draft B");
  });

  it("syncs the editor when the draft changes externally", async () => {
    useStore.setState({ activeId: "a" });
    render(<Composer />);
    // Drives the [text] effect (height-sync) without going through onChange.
    act(() => {
      useStore.setState({ drafts: { a: "pasted from explorer" } });
    });
    await waitFor(() => expect(textarea()).toHaveTextContent("pasted from explorer"));
  });

  it("stays editable while a turn streams so the next message can be drafted", async () => {
    useStore.setState({ activeId: "a" });
    const { rerender } = render(<Composer />);
    // Idle (with an active session): keystrokes are accepted.
    expect(textarea()).toBeEnabled();

    act(() => {
      useStore.setState({ streaming: true });
    });
    rerender(<Composer />);
    expect(textarea()).toBeEnabled();
    expect(textarea()).toHaveAttribute(
      "aria-placeholder",
      "Draft your next message while Portcode works…",
    );
    // The shell owns the run state; the still-editable textbox is not mislabeled busy.
    expect(textarea().closest(".pc-neon-frame")).toHaveAttribute("aria-busy", "true");
    act(() => useStore.setState({ drafts: { a: "next thought" } }));
    await waitFor(() => expect(textarea()).toHaveTextContent("next thought"));
  });

  it("keeps drafting open but locks Send only while the response change record finalizes", () => {
    const provisional = receipt();
    useStore.setState({
      activeId: "a",
      sessions: [session()],
      drafts: { a: "next request" },
      streaming: false,
      runs: {
        a: run({
          turnId: "turn-1",
          startedAt: 1_000,
          finalizing: true,
          agentDurationMs: 2_000,
          phaseRevision: 2,
          receipt: provisional,
          outcome: "completed",
        }),
      },
    });
    render(<Composer />);

    expect(textarea()).toBeEnabled();
    expect(textarea()).toHaveTextContent("next request");
    expect(textarea()).toHaveAttribute(
      "aria-placeholder",
      "Draft your next message while Portcode checks file changes…",
    );
    expect(textarea().closest(".pc-neon-frame")).toHaveAttribute("aria-busy", "false");

    const lockedSend = screen.getByRole("button", {
      name: "Send unlocks after file changes are checked",
    });
    expect(lockedSend).toBeVisible();
    expect(lockedSend).toBeDisabled();
    expect(lockedSend).toHaveAttribute("tabindex", "0");
    expect(lockedSend).toHaveAttribute("title", "Finishing the change record before sending");
    expect(stopButton()).toHaveAttribute("aria-hidden", "true");
    expect(stopButton()).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("status")).toHaveTextContent(
      "response complete · checking file changes…",
    );
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "off");
    expect(
      screen.getByText("Response complete · send unlocks after file check"),
    ).toBeInTheDocument();

    act(() => {
      useStore.setState({
        runs: {
          a: run({
            turnId: "turn-1",
            startedAt: 1_000,
            receipt: receipt({ changeCertainty: "exact", changeState: "none" }),
            outcome: "completed",
          }),
        },
      });
    });

    expect(sendButton()).toBeEnabled();
    expect(textarea()).toHaveTextContent("next request");
  });

  it("disables the input when there is no active session to draft into", () => {
    // Without an activeId, setDraft has nowhere to key the draft, so an enabled
    // field would silently eat keystrokes — disable it instead (honest dead-end).
    useStore.setState({ activeId: null });
    render(<Composer />);
    expect(textarea()).toHaveAttribute("contenteditable", "false");
    expect(textarea()).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Create or select a chat to start");
    expect(screen.getByRole("button", { name: "New chat" })).toBeEnabled();
  });

  it("routes the no-session CTA through the shared default creation path", () => {
    const newSession = vi.fn(async () => {});
    useStore.setState({ activeId: null, newSession });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));

    expect(newSession).toHaveBeenCalledWith();
  });

  it("uses a dedicated full-width writing surface with a compliant placeholder", () => {
    useStore.setState({ activeId: null });
    render(<Composer />);
    const editor = textarea();
    expect(editor).toHaveAttribute("contenteditable", "false");
    expect(editor.className).toContain("pc-composer-editor");
    expect(editor).toHaveAttribute("aria-placeholder", "Create or select a chat to begin…");
  });

  it("exposes an explicit accessible name (not just the placeholder)", () => {
    render(<Composer />);
    expect(screen.getByRole("textbox", { name: "Message Portcode" })).toBe(textarea());
  });

  it("teaches the supported formatting from a compact help button", () => {
    render(<Composer />);
    const help = screen.getByRole("button", { name: "Formatting help" });
    fireEvent.click(help);

    const guide = screen.getByRole("dialog", { name: "Message formatting" });
    expect(guide).toHaveTextContent("- [ ] task");
    expect(guide).toHaveTextContent("Tab");
    expect(guide).toHaveTextContent("Shift+Tab");
    expect(guide).toHaveTextContent("Shift+Enter");
    expect(guide).toHaveTextContent("empty nested item it outdents");

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Message formatting" })).toBeNull();

    fireEvent.click(help);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Message formatting" })).toBeNull();
  });
});

describe("Composer send button", () => {
  it("is disabled for an empty or whitespace-only draft", () => {
    useStore.setState({ activeId: "a" });
    render(<Composer />);
    expect(sendButton()).toBeDisabled();

    act(() => seedDraft("   "));
    expect(sendButton()).toBeDisabled();
  });

  it("is enabled once the draft has content", () => {
    seedDraft("do a thing");
    render(<Composer />);
    expect(sendButton()).toBeEnabled();
  });

  it("exposes an accessible name for screen readers while idle", () => {
    render(<Composer />);
    // While idle the Stop control is aria-hidden, so the only button with this role
    // tree the accessible-name query reaches is Send.
    expect(screen.getByRole("button", { name: "Send message" })).toBe(sendButton());
  });

  it("arms a one-shot pulse the moment Send becomes fireable", () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ activeId: "a" });
      render(<Composer />);
      // Empty draft → not armed.
      expect(sendButton().className).not.toContain("pc-armed");
      // Disabled→enabled transition (motor anticipation) arms the pulse.
      act(() => seedDraft("now there's content"));
      expect(sendButton().className).toContain("pc-armed");
      // One-shot: the pulse class drops shortly after it plays so a later
      // disabled→enabled transition can re-trigger it.
      act(() => vi.advanceTimersByTime(320));
      expect(sendButton().className).not.toContain("pc-armed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves a clicked send into chat and clears the composer immediately", async () => {
    useStore.setState({
      sessions: [session()],
      activeId: "a",
      messages: { a: [] },
      drafts: { a: "Refactor the parser" },
    });
    render(<Composer />);

    fireEvent.click(sendButton());

    expect(useStore.getState().drafts.a).toBeUndefined();
    expect(textarea().textContent).toBe("");
    await Promise.resolve();
    await Promise.resolve();
    expect(m.runAgent).toHaveBeenCalledWith("a", "Refactor the parser", expect.any(Function));
  });

  it("restores the editor when native admission fails before turn_start", async () => {
    m.runAgent.mockRejectedValueOnce(new Error("Attachment changed before send"));
    useStore.setState({
      sessions: [session()],
      activeId: "a",
      messages: { a: [] },
      drafts: { a: "Explain the screenshot" },
    });
    render(<Composer />);

    fireEvent.click(sendButton());

    expect(textarea().textContent).toBe("");
    await waitFor(() => expect(textarea().textContent).toBe("Explain the screenshot"));
    expect(useStore.getState().drafts.a).toBe("Explain the screenshot");
    expect(screen.getByRole("alert")).toHaveTextContent("Attachment changed before send");
  });

  it("does not rewrite a follow-up draft when native handle admission succeeds", async () => {
    let finishRun!: () => void;
    m.runAgent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRun = () => resolve({ cancel: vi.fn(async () => {}), dispose: vi.fn() });
        }),
    );
    useStore.setState({
      sessions: [session()],
      activeId: "a",
      messages: { a: [] },
      drafts: { a: "First turn" },
    });
    render(<Composer />);

    fireEvent.click(sendButton());
    await waitFor(() => expect(m.runAgent).toHaveBeenCalled());
    act(() => seedDraft("Follow-up"));
    await waitFor(() => expect(textarea().textContent).toBe("Follow-up"));

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(textarea(), { childList: true, characterData: true, subtree: true });
    await act(async () => finishRun());
    await Promise.resolve();
    observer.disconnect();

    expect(textarea().textContent).toBe("Follow-up");
    expect(mutations).toEqual([]);
  });

  it("does not rewrite an IME follow-up draft when the prior send is rejected", async () => {
    let rejectRun!: (error: Error) => void;
    m.runAgent.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectRun = reject)),
    );
    useStore.setState({
      sessions: [session()],
      activeId: "a",
      messages: { a: [] },
      drafts: { a: "First turn" },
    });
    render(<Composer />);

    fireEvent.click(sendButton());
    await waitFor(() => expect(m.runAgent).toHaveBeenCalled());
    act(() => useStore.getState().setDraft("入力中の follow-up"));
    await waitFor(() => expect(textarea().textContent).toBe("入力中の follow-up"));
    fireEvent.compositionStart(textarea());

    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    observer.observe(textarea(), { childList: true, characterData: true, subtree: true });
    await act(async () => rejectRun(new Error("Prior send rejected")));
    await Promise.resolve();
    observer.disconnect();

    expect(textarea().textContent).toBe("入力中の follow-up");
    expect(useStore.getState().drafts.a).toBe("入力中の follow-up");
    expect(mutations).toEqual([]);
  });

  it("does not import a rejected send into another session's editor", async () => {
    let rejectRun!: (error: Error) => void;
    m.runAgent.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectRun = reject)),
    );
    useStore.setState({
      sessions: [session(), session({ id: "b", title: "Other" })],
      activeId: "a",
      messages: { a: [], b: [] },
      drafts: { a: "Send from A", b: "Keep B" },
    });
    render(<Composer />);

    fireEvent.click(sendButton());
    await waitFor(() => expect(m.runAgent).toHaveBeenCalled());
    act(() => useStore.setState({ activeId: "b" }));
    await waitFor(() => expect(textarea().textContent).toBe("Keep B"));

    await act(async () => rejectRun(new Error("A was rejected")));

    expect(textarea().textContent).toBe("Keep B");
    expect(useStore.getState().drafts.b).toBe("Keep B");
    expect(useStore.getState().drafts.a).toBe("Send from A");
  });

  it("collapses the textarea to an explicit px height on submit (not 'auto')", async () => {
    useStore.setState({
      sessions: [session()],
      activeId: "a",
      messages: { a: [] },
    });
    render(<Composer />);
    const ta = textarea();

    // Seed a tall multi-line draft (drives the [text] effect to grow the field).
    act(() => {
      useStore.setState({ drafts: { a: "line one\nline two\nline three" } });
    });

    fireEvent.click(sendButton());

    // The collapse sets an interpolatable px value (CSS can't ease to/from "auto").
    expect(ta.style.height).toMatch(/px$/);
    expect(ta.style.height).not.toBe("auto");

    await Promise.resolve();
    await Promise.resolve();
    expect(m.runAgent).toHaveBeenCalledWith(
      "a",
      "line one\nline two\nline three",
      expect.any(Function),
    );
  });
});

describe("Composer key handling", () => {
  const seedSession = (draft: string) =>
    useStore.setState({
      sessions: [session()],
      activeId: "a",
      messages: { a: [] },
      drafts: { a: draft },
    });

  it("submits on Enter (without Shift)", async () => {
    seedSession("ship it");
    render(<Composer />);
    fireEvent.keyDown(textarea(), { key: "Enter" });

    expect(useStore.getState().drafts.a).toBeUndefined();
    expect(textarea().textContent).toBe("");
    await Promise.resolve();
    await Promise.resolve();
    expect(m.runAgent).toHaveBeenCalledWith("a", "ship it", expect.any(Function));
  });

  it("does not submit on the Enter that commits an IME composition", async () => {
    seedSession("日本語");
    render(<Composer />);
    // The composition-commit Enter carries isComposing on the native event; the
    // guard must let it pass through (commit the candidate) without sending.
    fireEvent.keyDown(textarea(), { key: "Enter", isComposing: true });

    expect(useStore.getState().drafts.a).toBe("日本語");
    await Promise.resolve();
    await Promise.resolve();
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("inserts a newline (does not submit) on Shift+Enter", () => {
    useStore.setState({ activeId: "a", messages: { a: [] }, drafts: { a: "line one" } });
    render(<Composer />);
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });

    expect(useStore.getState().drafts.a).toBe("line one");
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    useStore.setState({ activeId: "a", messages: { a: [] }, drafts: { a: "typing" } });
    render(<Composer />);
    fireEvent.keyDown(textarea(), { key: "a" });

    expect(useStore.getState().drafts.a).toBe("typing");
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("does not send when Enter is pressed on a whitespace-only draft", () => {
    useStore.setState({ activeId: "a", messages: { a: [] }, drafts: { a: "   " } });
    render(<Composer />);
    fireEvent.keyDown(textarea(), { key: "Enter" });

    expect(useStore.getState().drafts.a).toBe("   ");
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("does not send when Enter is pressed while a turn is streaming", () => {
    useStore.setState({
      activeId: "a",
      messages: { a: [] },
      drafts: { a: "queued" },
      streaming: true,
    });
    render(<Composer />);
    fireEvent.keyDown(textarea(), { key: "Enter" });

    expect(useStore.getState().drafts.a).toBe("queued");
    expect(m.runAgent).not.toHaveBeenCalled();
  });

  it("keeps the draft editable but guards Send after a cold history load error", () => {
    useStore.setState({
      activeId: "a",
      messages: {},
      drafts: { a: "keep this draft" },
      messageLoads: {
        a: {
          phase: "error",
          loadedAt: null,
          lastAccessedAt: 1,
          requestId: 1,
          error: "offline",
          nextCursor: null,
          loadingOlder: false,
        },
      },
    });
    render(<Composer />);

    expect(textarea()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Conversation failed to load" })).toBeDisabled();
  });

  it("allows Send when a refresh fails but cached history remains", () => {
    useStore.setState({
      activeId: "a",
      messages: { a: [] },
      drafts: { a: "send from cache" },
      messageLoads: {
        a: {
          phase: "error",
          loadedAt: 1,
          lastAccessedAt: 2,
          requestId: 2,
          error: "offline",
          nextCursor: null,
          loadingOlder: false,
        },
      },
    });
    render(<Composer />);

    expect(sendButton()).toBeEnabled();
  });
});

describe("Composer send↔stop crossfade", () => {
  it("stacks both controls and only the active one is in the tab order", () => {
    const { rerender } = render(<Composer />);
    // Idle: Send is reachable; Stop is hidden from AT and out of the tab sequence.
    expect(sendButton()).toHaveAttribute("tabindex", "0");
    expect(sendButton()).not.toHaveAttribute("aria-hidden", "true");
    expect(stopButton()).toHaveAttribute("tabindex", "-1");
    expect(stopButton()).toHaveAttribute("aria-hidden", "true");

    act(() => useStore.setState({ streaming: true }));
    rerender(<Composer />);
    // Streaming: the visibility + tab order swap — Stop in, Send out.
    expect(stopButton()).toHaveAttribute("tabindex", "0");
    expect(stopButton()).not.toHaveAttribute("aria-hidden", "true");
    expect(sendButton()).toHaveAttribute("tabindex", "-1");
    expect(sendButton()).toHaveAttribute("aria-hidden", "true");
  });

  it("cross-fades the controls (not an instant swap) and both fill one slot", () => {
    const { rerender } = render(<Composer />);
    // Both carry the crossfade class; idle shows Send / hides Stop.
    expect(sendButton().className).toContain("pc-action");
    expect(stopButton().className).toContain("pc-action");
    expect(sendButton().className).toContain("pc-action--shown");
    expect(stopButton().className).toContain("pc-action--hidden");

    act(() => useStore.setState({ streaming: true }));
    rerender(<Composer />);
    expect(stopButton().className).toContain("pc-action--shown");
    expect(sendButton().className).toContain("pc-action--hidden");
  });

  it("cancels the run on Stop click and clears the streaming flags", async () => {
    const cancel = vi.fn(async () => {});
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      messages: { a: [] },
      streaming: true,
      cancel,
    });
    render(<Composer />);

    fireEvent.click(stopButton());
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledTimes(1);
    const st = useStore.getState();
    expect(st.streaming).toBe(false);
    expect(st.cancel).toBeNull();
  });

  it("relabels + dims the Stop button while a stop is in flight", () => {
    useStore.setState({ streaming: true, composerPhase: "stopping" });
    render(<Composer />);
    // The instant Stop is pressed (composerPhase === "stopping"): relabel for AT and
    // dim, before the backend cancel resolves.
    expect(stopButton()).toHaveAttribute("aria-label", "Stopping…");
    expect(stopButton().className).toContain("pc-stop--stopping");
    // And it's disabled so a second click can't fire a duplicate cancel.
    expect(stopButton()).toBeDisabled();
  });

  it("exposes an accessible name for the Stop control while streaming", () => {
    useStore.setState({ streaming: true });
    render(<Composer />);
    expect(screen.getByRole("button", { name: "Stop generating" })).toBe(stopButton());
  });

  it("keeps the Stop control at full strength (the dim is scoped to the input)", () => {
    useStore.setState({ streaming: true });
    render(<Composer />);
    const frame = stopButton().closest(".pc-neon-frame")!;
    expect(frame.className).not.toContain("opacity-70");
    expect(frame.className).not.toContain("saturate-[0.6]");
  });
});

describe("Composer neon frame (state-bearing)", () => {
  it("flows only while streaming via the data-busy flag", () => {
    const { rerender } = render(<Composer />);
    const frame = () => textarea().closest(".pc-neon-frame")!;
    // At rest: still + glowing (no busy flag → the CSS animation doesn't run).
    expect(frame()).not.toHaveAttribute("data-busy", "true");

    act(() => useStore.setState({ streaming: true }));
    rerender(<Composer />);
    // Streaming: the gradient flows.
    expect(frame()).toHaveAttribute("data-busy", "true");
    // The flow + the wrapper transitions both have a reduced-motion fallback.
    expect(frame().className).toContain("motion-reduce:transition-none");
  });
});

describe("Composer presence region", () => {
  const phaseText = (streaming: boolean, phase: ComposerPhase) => {
    useStore.setState({ activeId: "a", streaming, composerPhase: phase });
    render(<Composer />);
    return screen.getByRole("status").textContent;
  };

  it("is a polite, atomic live status region", () => {
    render(<Composer />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
  });

  it("reads 'ready when you are' at rest", () => {
    expect(phaseText(false, "idle")).toContain("ready when you are");
  });

  it("acknowledges the send with 'got it — reading…' (received)", () => {
    expect(phaseText(true, "received")).toContain("got it — reading…");
  });

  it("settles to 'thinking with you…' while working", () => {
    expect(phaseText(true, "thinking")).toContain("thinking with you…");
  });

  it("reads 'stopping…' the instant Stop is pressed", () => {
    expect(phaseText(true, "stopping")).toContain("stopping…");
  });

  it("names the running canonical tool while a tool_use is active", () => {
    useStore.setState({
      activeId: "a",
      streaming: true,
      composerPhase: "thinking",
      activeTool: "search_text",
    });
    render(<Composer />);
    expect(screen.getByRole("status").textContent).toContain("searching the project…");
  });

  it("falls back to a generic 'running <name>…' for an unmapped tool", () => {
    useStore.setState({
      activeId: "a",
      streaming: true,
      composerPhase: "thinking",
      activeTool: "mystery_tool",
    });
    render(<Composer />);
    expect(screen.getByRole("status").textContent).toContain("running mystery tool…");
  });

  it("never shows a residual tool label once streaming ends (streaming-gated)", () => {
    useStore.setState({
      activeId: "a",
      streaming: false,
      composerPhase: "idle",
      activeTool: "grep",
    });
    render(<Composer />);
    expect(screen.getByRole("status").textContent).toContain("ready when you are");
  });

  it("shows the generic 'thinking with you…' (not a tool) outside the thinking phase", () => {
    // An observed turn can be streaming with a stale activeTool while the phase is
    // still idle; the phase gate keeps the tool label from surfacing wrongly.
    useStore.setState({
      activeId: "a",
      streaming: true,
      composerPhase: "idle",
      activeTool: "grep",
    });
    render(<Composer />);
    const status = screen.getByRole("status").textContent;
    expect(status).toContain("thinking with you…");
    expect(status).not.toContain("searching the project…");
  });

  it("keeps the keyboard contract discoverable and switches to drafting guidance while busy", () => {
    seedDraft("one line");
    const { rerender } = render(<Composer />);
    expect(screen.getByText("Enter").tagName).toBe("KBD");
    expect(screen.getByText("Send")).toBeInTheDocument();
    expect(screen.getByText("Shift+Enter").tagName).toBe("KBD");
    expect(screen.getByText("New line")).toBeInTheDocument();

    act(() => useStore.setState({ streaming: true }));
    rerender(<Composer />);
    expect(
      screen.getByText("Keep drafting · send unlocks when this run finishes"),
    ).toBeInTheDocument();
  });
});

describe("Composer UsageMeter", () => {
  it("shows the selected model once and omits usage when the session has none", () => {
    useStore.setState({ sessions: [session({ model: "gpt-5.6-terra" })], activeId: "a" });
    render(<Composer />);
    expect(screen.getByRole("status").textContent).toContain("ready when you are");
    // The model lives in its labeled picker and is no longer repeated in telemetry.
    expect(screen.getAllByText("5.6 Terra")).toHaveLength(1);
    expect(screen.queryByRole("group", { name: /Session usage/i })).toBeNull();
  });

  it("omits the usage span when an active session has no recorded usage", () => {
    useStore.setState({ activeId: "a" });
    render(<Composer />);
    expect(screen.queryByRole("group", { name: /Session usage/i })).toBeNull();
  });

  it("labels cumulative session tokens and Codex billing", () => {
    const usage: Usage = { input: 1200, output: 300 };
    useStore.setState({
      sessions: [session({ model: "gpt-5.6-terra" })],
      activeId: "a",
      usage: { a: usage },
    });
    render(<Composer />);

    // fmtTokens(1500) -> "1.5k" while billing remains owned by Codex.
    expect(screen.getByText("1.5k tokens")).toBeInTheDocument();
    expect(screen.getByText("Codex plan or API billing")).toBeInTheDocument();
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByTitle("1,200 in · 300 out")).toBeInTheDocument();
    expect(
      screen.getByRole("group", {
        name: /Session usage: 1,500 tokens, 1,200 input and 300 output/i,
      }),
    ).toHaveClass("pc-composer-usage");
  });

  it("formats million-scale usage cleanly and keeps billing mode neutral", () => {
    useStore.setState({
      sessions: [session({ model: "gpt-5.6-sol" })],
      activeId: "a",
      usage: { a: { input: 2_000_000, output: 199_700 } },
      openAIAuthStatus: { signedIn: true, expiresAt: null, account: null, tier: null },
    });
    render(<Composer />);

    expect(screen.getByText("2.2M tokens")).toBeInTheDocument();
    expect(screen.getByText("Codex plan or API billing")).toBeInTheDocument();
    expect(screen.queryByText("2199.7k tokens")).toBeNull();
  });

  it("keeps ticking visuals out of the live region but exposes a stable accessible summary", () => {
    useStore.setState({
      sessions: [session({ model: "gpt-5.6-terra" })],
      activeId: "a",
      usage: { a: { input: 1200, output: 300 } },
    });
    render(<Composer />);

    const usageGroup = screen.getByRole("group", { name: /Session usage: 1,500 tokens/i });
    expect(usageGroup.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status").textContent).not.toContain("tokens");
    expect(usageGroup).toHaveAccessibleName(
      "Session usage: 1,500 tokens, 1,200 input and 300 output; Codex plan or API billing; GPT-5.6 Terra",
    );
  });

  it("keeps exact low-volume input/output counts in the title", () => {
    const usage: Usage = { input: 100, output: 0 };
    useStore.setState({
      sessions: [session({ model: "gpt-5.6-terra" })],
      activeId: "a",
      usage: { a: usage },
    });
    render(<Composer />);

    expect(screen.getByText("100 tokens")).toBeInTheDocument();
    expect(screen.getByText("Codex plan or API billing")).toBeInTheDocument();
    expect(screen.getByTitle("100 in · 0 out")).toBeInTheDocument();
  });

  it("keeps historical unknown-model usage readable without inventing pricing", () => {
    useStore.setState({
      sessions: [session({ model: "no-such-model" })],
      activeId: "a",
      usage: { a: { input: 5000, output: 0 } },
      settings: { ...initial.settings, model: "no-such-model" },
    });
    render(<Composer />);

    expect(screen.getByText("5.0k tokens")).toBeInTheDocument();
    expect(screen.getByText("Codex plan or API billing")).toBeInTheDocument();
    expect(screen.queryByText("$0.0000")).toBeNull();
    expect(screen.getByRole("group", { name: /no-such-model/i })).toBeInTheDocument();
  });
});

describe("Composer permission dropdown", () => {
  it("shows every permission mode in clearly separated groups", () => {
    render(<Composer />);

    expect(screen.queryByText("Access")).not.toBeInTheDocument();
    const picker = screen.getByRole("combobox", { name: "Permission mode" });
    expect(picker).toHaveValue("default");
    expect(picker).toHaveTextContent("Ask");

    fireEvent.click(picker);
    expect(screen.getByRole("group", { name: "Standard access" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Elevated access" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ask" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Edits allowed" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Plan only" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Auto configurable" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Bypass all" })).toBeInTheDocument();
  });

  it("persists any selected permission mode", async () => {
    render(<Composer />);

    fireEvent.click(screen.getByRole("combobox", { name: "Permission mode" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Bypass all" }));
    });

    expect(m.saveSettings).toHaveBeenCalledWith({ permissionMode: "bypass" });
    expect(useStore.getState().settings.permissionMode).toBe("bypass");
  });

  it("is hidden on the phone because permission policy is desktop-owned", () => {
    useStore.setState({ remoteMode: true, settings: { ...DEFAULT_SETTINGS } });
    render(<Composer />);

    expect(screen.queryByRole("combobox", { name: "Permission mode" })).not.toBeInTheDocument();
  });

  it("marks dangerous access and freezes policy changes during a run", () => {
    useStore.setState({
      streaming: true,
      settings: { ...DEFAULT_SETTINGS, permissionMode: "bypass" },
    });
    render(<Composer />);

    const picker = screen.getByRole("combobox", { name: "Permission mode" });
    expect(picker).toHaveTextContent("Bypass all");
    expect(picker).toHaveAttribute("title", expect.stringContaining("no permission prompts"));
    expect(picker).toHaveClass("pc-permission-select--danger");
    expect(picker).toBeDisabled();
  });

  it("freezes global permission policy while a background session runs", () => {
    useStore.setState({
      activeId: "a",
      runs: { b: run({ streaming: true }) },
      settings: { ...DEFAULT_SETTINGS, permissionMode: "default" },
    });
    render(<Composer />);

    expect(screen.getByRole("combobox", { name: "Permission mode" })).toBeDisabled();
  });

  it("removes the plan warning banner while keeping plan state clear in the composer", () => {
    useStore.setState({
      activeId: "a",
      settings: { ...DEFAULT_SETTINGS, permissionMode: "plan" },
    });
    render(<Composer />);

    expect(screen.queryByRole("button", { name: /Exit plan mode/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Dismiss plan mode notice/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Permission mode" })).toHaveTextContent(
      "Plan only",
    );
    expect(textarea()).toHaveAttribute(
      "aria-placeholder",
      "Describe what you want planned — files will stay untouched…",
    );
  });
});

describe("Composer recovery", () => {
  it("surfaces setting-save failures where they happened without hiding run status", () => {
    useStore.setState({ activeId: "a", settingsError: "database is locked" });
    render(<Composer />);

    expect(screen.getByRole("status")).toHaveTextContent("ready when you are");
    expect(screen.getByRole("alert")).toHaveTextContent("That setting wasn’t saved");
    expect(screen.getByRole("alert")).toHaveAttribute("title", "database is locked");

    fireEvent.click(screen.getByRole("button", { name: "Review settings" }));
    expect(useStore.getState().showSettings).toBe(true);
  });
});

describe("Composer run setup", () => {
  it("captures the rendered editor row height for a later animated collapse", () => {
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(24);

    render(<Composer />);

    expect(textarea()).toHaveStyle({ height: "0px" });
    clientHeight.mockRestore();
  });

  it("reflects the active Codex model and offers only OpenAI choices", () => {
    useStore.setState({
      sessions: [session({ id: "a", model: "gpt-5.6-terra" })],
      activeId: "a",
      messages: { a: [] },
    });
    render(<Composer />);

    const picker = screen.getByRole("button", { name: "Model, effort, and speed" });
    expect(screen.queryByText("Chat model")).not.toBeInTheDocument();
    expect(picker).toHaveTextContent("5.6 Terra");
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    // The bundled Codex engine exposes only its OpenAI catalogue here.
    expect(screen.getByRole("group", { name: "OpenAI · Codex" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "GPT-5.6 Sol" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Anthropic/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Claude/ })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Model" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(picker).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(picker);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(picker).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(document.body);
    expect(picker).toHaveAttribute("aria-expanded", "false");
  });

  it("changing the model updates the active session AND the last-used default", async () => {
    useStore.setState({
      sessions: [session({ id: "a", model: "gpt-5.6-terra" })],
      activeId: "a",
      messages: { a: [] },
    });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "Model, effort, and speed" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    fireEvent.click(screen.getByRole("option", { name: "GPT-5.6 Sol" }));

    // setSessionModel updates the session synchronously, then awaits the
    // last-used sync into settings.model (updateSettings -> ipc.saveSettings).
    expect(useStore.getState().sessions[0].model).toBe("gpt-5.6-sol");
    await Promise.resolve();
    await Promise.resolve();
    expect(m.saveSettings).toHaveBeenCalledWith({
      model: "gpt-5.6-sol",
      provider: "openai",
      reasoningEffort: "medium",
    });
    expect(useStore.getState().settings.model).toBe("gpt-5.6-sol");
  });

  it("is disabled while a turn is streaming", () => {
    useStore.setState({
      sessions: [session({ id: "a" })],
      activeId: "a",
      messages: { a: [] },
      streaming: true,
    });
    render(<Composer />);
    expect(screen.getByRole("button", { name: "Model, effort, and speed" })).toBeDisabled();
  });
});

describe("Composer OpenAI auth and reasoning", () => {
  const openAIModel = {
    id: "gpt-live",
    label: "GPT Live",
    provider: "openai" as const,
    reasoningEfforts: ["minimal", "high", "ultra"],
    defaultReasoningEffort: "high",
    serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, more usage" }],
  };

  it("routes an unassigned GPT session to Settings without an account prompt above the composer", () => {
    useStore.setState({
      sessions: [session({ model: "gpt-live", accountProfileId: null })],
      activeId: "a",
      drafts: { a: "ship it" },
      openAIModels: [openAIModel],
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-live" },
      openAIAuthStatus: null,
    });
    render(<Composer />);

    expect(
      screen.getByRole("button", {
        name: "Connect ChatGPT or an OpenAI Platform API key in Settings to send",
      }),
    ).toBeDisabled();
    expect(screen.queryByRole("group", { name: "Choose ChatGPT account" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "ChatGPT account for this conversation" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(useStore.getState().showSettings).toBe(true);
  });
  it("fails closed and removes OpenAI choices when this build disables the capability", () => {
    useStore.setState({
      sessions: [session({ model: "gpt-live", accountProfileId: null })],
      activeId: "a",
      drafts: { a: "ship it" },
      openAIModels: [],
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-live" },
      openAIAuthStatus: {
        signedIn: false,
        expiresAt: null,
        account: null,
        tier: null,
        available: false,
        unavailableReason: "Disabled in this build",
      },
    });
    render(<Composer />);

    expect(screen.getByRole("button", { name: "Disabled in this build" })).toBeDisabled();
    expect(
      screen
        .getAllByRole("status")
        .some((status) => status.textContent?.includes("Disabled in this build")),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Model and effort" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    expect(screen.queryByRole("group", { name: /OpenAI/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Anthropic/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Reasoning level" })).not.toBeInTheDocument();
  });

  it("enables sends when signed in and renders only advertised reasoning levels", () => {
    const account = openAIAccount();
    useStore.setState({
      sessions: [session({ model: "gpt-live", accountProfileId: account.id })],
      activeId: "a",
      drafts: { a: "ship it" },
      openAIModels: [openAIModel],
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [openAIModel], error: null },
      },
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "openai",
        model: "gpt-live",
        reasoningEffort: "high",
      },
      openAIAuthStatus: { signedIn: true, expiresAt: null, account: null, tier: null },
    });
    render(<Composer />);

    expect(sendButton()).toBeEnabled();
    const picker = screen.getByRole("button", { name: "Model, effort, and speed" });
    expect(screen.queryByText("Thinking default")).not.toBeInTheDocument();
    expect(picker).toHaveTextContent("Live");
    expect(picker).toHaveTextContent("High");
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("button", { name: /^Effort:/ }));
    expect(screen.getAllByRole("option", { name: /Minimal|High|Ultra/ })).toHaveLength(3);
    expect(screen.getByRole("option", { name: "High" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("option", { name: "Minimal" }));
    expect(m.saveSettings).toHaveBeenCalledWith({ reasoningEffort: "minimal" });
  });

  it("never renders a stale Ultra selection for Spark", () => {
    const account = openAIAccount();
    const sparkModel = {
      id: "gpt-5.3-codex-spark",
      label: "GPT-5.3 Codex Spark",
      provider: "openai" as const,
      reasoningEfforts: ["low" as const, "medium" as const, "high" as const, "xhigh" as const],
      defaultReasoningEffort: "high" as const,
    };
    useStore.setState({
      sessions: [session({ model: sparkModel.id, accountProfileId: account.id })],
      activeId: "a",
      openAIModels: [sparkModel],
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [sparkModel], error: null },
      },
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "openai",
        model: sparkModel.id,
        reasoningEffort: "ultra",
      },
    });
    render(<Composer />);

    const picker = screen.getByRole("button", { name: "Model and effort" });
    expect(picker).toHaveTextContent("High");
    expect(picker).not.toHaveTextContent("Ultra");
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("button", { name: /^Effort:/ }));
    expect(screen.queryByRole("option", { name: "Ultra" })).toBeNull();
    expect(screen.getByRole("option", { name: "High" })).toHaveAttribute("aria-selected", "true");
  });

  it("preserves the draft when a stale effort cannot be repaired before send", async () => {
    const account = openAIAccount();
    const sparkModel = {
      id: "gpt-5.3-codex-spark",
      label: "GPT-5.3 Codex Spark",
      provider: "openai" as const,
      reasoningEfforts: ["low" as const, "medium" as const, "high" as const, "xhigh" as const],
      defaultReasoningEffort: "high" as const,
    };
    useStore.setState({
      sessions: [session({ model: sparkModel.id, accountProfileId: account.id })],
      activeId: "a",
      drafts: { a: "keep this unsent task" },
      openAIModels: [sparkModel],
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [sparkModel], error: null },
      },
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "openai",
        model: sparkModel.id,
        reasoningEffort: "ultra",
      },
      openAIAuthStatus: { signedIn: true, expiresAt: null, account: null, tier: null },
    });
    m.saveSettings.mockRejectedValueOnce(new Error("settings write failed"));
    render(<Composer />);

    fireEvent.click(sendButton());

    await waitFor(() => expect(m.saveSettings).toHaveBeenCalledWith({ reasoningEffort: "high" }));
    expect(m.runAgent).not.toHaveBeenCalled();
    expect(useStore.getState().drafts.a).toBe("keep this unsent task");
    expect(textarea()).toHaveTextContent("keep this unsent task");
  });

  it("keeps the single Codex authentication slot out of per-chat controls", () => {
    const first = openAIAccount();
    const second = openAIAccount({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "two@chatgpt.test",
      tier: "ChatGPT Team",
    });
    useStore.setState({
      sessions: [session({ model: "gpt-live", accountProfileId: first.id })],
      activeId: "a",
      openAIModels: [openAIModel],
      openAIAccounts: [first, second],
      openAIModelCatalogs: {
        [first.id]: { status: "ready", models: [openAIModel], error: null },
        [second.id]: { status: "ready", models: [openAIModel], error: null },
      },
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-live" },
    });
    render(<Composer />);

    const controls = screen.getByRole("group", { name: "Turn controls" });
    const modelPicker = screen.getByRole("button", { name: "Model, effort, and speed" });
    expect(controls).toContainElement(modelPicker);
    expect(
      screen.queryByRole("combobox", { name: "ChatGPT account for this chat" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("one@chatgpt.test")).not.toBeInTheDocument();
    expect(screen.queryByText("Which ChatGPT account owns this conversation?")).toBeNull();
  });

  it("limits a pinned ChatGPT conversation's model picker to that provider", () => {
    const account = openAIAccount();
    useStore.setState({
      sessions: [session({ model: "gpt-live", accountProfileId: account.id })],
      activeId: "a",
      openAIModels: [openAIModel],
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [openAIModel], error: null },
      },
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-live" },
    });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "Model, effort, and speed" }));
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));

    expect(screen.getByRole("group", { name: /OpenAI/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "GPT Live" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Anthropic/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Claude/ })).not.toBeInTheDocument();
  });

  it("offers Fast with an explicit speed and usage tradeoff", async () => {
    useStore.setState({
      sessions: [session({ model: "gpt-live" })],
      activeId: "a",
      openAIModels: [openAIModel],
      openAIModelCatalogs: {
        "codex-primary": { status: "ready", models: [openAIModel], error: null },
      },
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "openai",
        model: "gpt-live",
        reasoningEffort: "high",
      },
    });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "Model, effort, and speed" }));
    fireEvent.click(screen.getByRole("button", { name: /^Speed:/ }));
    expect(screen.getByRole("option", { name: /Fast/ })).toHaveTextContent(
      "1.5x speed, more usage",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Fast/ }));
    });
    expect(m.saveSettings).toHaveBeenCalledWith({ responseSpeed: "fast" });
    expect(useStore.getState().settings.responseSpeed).toBe("fast");
    expect(screen.queryByText("Advanced")).not.toBeInTheDocument();
  });

  it("returns to the main setup panel when refreshed metadata removes Fast", () => {
    useStore.setState({
      sessions: [session({ model: openAIModel.id })],
      activeId: "a",
      openAIModels: [openAIModel],
      openAIModelCatalogs: {
        "codex-primary": { status: "ready", models: [openAIModel], error: null },
      },
      settings: { ...DEFAULT_SETTINGS, model: openAIModel.id },
    });
    render(<Composer />);

    fireEvent.click(screen.getByRole("button", { name: "Model, effort, and speed" }));
    fireEvent.click(screen.getByRole("button", { name: /^Speed:/ }));
    expect(screen.getByRole("listbox", { name: "Response speed" })).toBeInTheDocument();

    const standardOnlyModel = { ...openAIModel, serviceTiers: [] };
    act(() => {
      useStore.setState({
        openAIModels: [standardOnlyModel],
        openAIModelCatalogs: {
          "codex-primary": { status: "ready", models: [standardOnlyModel], error: null },
        },
      });
    });

    expect(screen.queryByRole("listbox", { name: "Response speed" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Model:/ })).toBeInTheDocument();
  });

  it("hides Fast and clears a stale Fast preference when Codex advertises Standard only", async () => {
    const standardOnlyModel = {
      ...openAIModel,
      id: "gpt-standard-only",
      label: "GPT Standard Only",
      serviceTiers: [],
    };
    useStore.setState({
      sessions: [session({ model: standardOnlyModel.id })],
      activeId: "a",
      openAIModels: [standardOnlyModel],
      openAIModelCatalogs: {
        "codex-primary": { status: "ready", models: [standardOnlyModel], error: null },
      },
      settings: {
        ...DEFAULT_SETTINGS,
        model: standardOnlyModel.id,
        responseSpeed: "fast",
      },
    });

    render(<Composer />);

    const setup = screen.getByRole("button", { name: "Model and effort" });
    expect(setup.querySelector(".pc-run-setup__bolt")).toBeNull();
    fireEvent.click(setup);
    expect(screen.queryByRole("button", { name: /^Speed:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Fast/ })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(m.saveSettings).toHaveBeenCalledWith({ responseSpeed: "standard" });
      expect(useStore.getState().settings.responseSpeed).toBe("standard");
    });
  });

  it("keeps remote sends available because subscription auth lives on the desktop", () => {
    useStore.setState({
      sessions: [session({ model: "gpt-live" })],
      activeId: "a",
      drafts: { a: "remote task" },
      openAIModels: [openAIModel],
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-live" },
      openAIAuthStatus: null,
      remoteMode: true,
      remoteConnected: true,
    });
    render(<Composer />);

    expect(sendButton()).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Model, effort, and speed" })).toBeNull();
    expect(screen.queryByRole("listbox", { name: "Reasoning level" })).toBeNull();
  });

  it("does not bypass authentication while remote mode is disconnected", () => {
    useStore.setState({
      sessions: [session({ model: "gpt-live", accountProfileId: null })],
      activeId: "a",
      drafts: { a: "remote task" },
      openAIModels: [openAIModel],
      settings: { ...DEFAULT_SETTINGS, provider: "openai", model: "gpt-live" },
      openAIAuthStatus: null,
      remoteMode: true,
      remoteConnected: false,
    });
    render(<Composer />);

    expect(
      screen.getByRole("button", {
        name: "Connect ChatGPT or an OpenAI Platform API key in Settings to send",
      }),
    ).toBeDisabled();
    expect(
      screen
        .getAllByRole("status")
        .some((status) =>
          status.textContent?.includes("Connect ChatGPT or an OpenAI Platform API key"),
        ),
    ).toBe(true);
  });

  it("silently assigns the configured default to an unassigned legacy GPT session", async () => {
    const account = openAIAccount();
    const legacy = session({ model: "gpt-live", accountProfileId: null });
    useStore.setState({
      sessions: [legacy],
      activeId: legacy.id,
      openAIModels: [openAIModel],
      openAIAccounts: [account],
      openAIModelCatalogs: {
        [account.id]: { status: "ready", models: [openAIModel], error: null },
      },
      lastOpenAIAccountProfileId: account.id,
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
    });
    m.pinSessionOpenAIAccount.mockResolvedValue({
      ...legacy,
      accountProfileId: account.id,
    });
    render(<Composer />);

    await waitFor(() => expect(useStore.getState().sessions[0].accountProfileId).toBe(account.id));
    expect(m.pinSessionOpenAIAccount).toHaveBeenCalledWith(legacy.id, account.id, "gpt-live");
    expect(screen.queryByRole("group", { name: "Choose ChatGPT account" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "ChatGPT account for this conversation" }),
    ).not.toBeInTheDocument();
  });

  it("keeps an existing GPT session on its assigned account when the default changes", () => {
    const first = openAIAccount();
    const second = openAIAccount({
      id: "00000000-0000-4000-8000-000000000002",
      accountLabel: "two@chatgpt.test",
      tier: "ChatGPT Team",
    });
    const existing = session({ model: "gpt-live", accountProfileId: first.id });
    useStore.setState({
      sessions: [existing],
      activeId: existing.id,
      openAIModels: [openAIModel],
      openAIAccounts: [first, second],
      openAIModelCatalogs: {
        [first.id]: { status: "ready", models: [openAIModel], error: null },
        [second.id]: { status: "ready", models: [openAIModel], error: null },
      },
      openAIAuthStatus: {
        signedIn: true,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
      lastOpenAIAccountProfileId: second.id,
    });
    render(<Composer />);

    expect(m.pinSessionOpenAIAccount).not.toHaveBeenCalled();
    expect(useStore.getState().sessions[0].accountProfileId).toBe(first.id);
    expect(screen.queryByRole("group", { name: "Choose ChatGPT account" })).not.toBeInTheDocument();
  });

  it("keeps a removed account's session readable without exposing the local UUID", () => {
    const removed = openAIAccount({
      accountLabel: null,
      state: "removed",
      expiresAt: null,
    });
    useStore.setState({
      sessions: [session({ model: "gpt-live", accountProfileId: removed.id })],
      activeId: "a",
      drafts: { a: "history remains" },
      openAIAccounts: [removed],
      openAIAuthStatus: {
        signedIn: false,
        expiresAt: null,
        account: null,
        tier: null,
        available: true,
      },
    });
    render(<Composer />);

    expect(
      screen.getByText("This session's Codex authentication is unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();
    expect(screen.queryByText(removed.id)).not.toBeInTheDocument();
    expect(textarea()).toHaveTextContent("history remains");
  });
});
