import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { teardownAllBackgroundListeners, useStore } from "../store/store";
import type { PendingCodexRequest, StreamEvent } from "../types";
import { CodexRequestPrompt } from "./CodexRequestPrompt";

vi.mock("../lib/ipc", () => ({
  resolveCodexRequest: vi.fn(),
  subscribeSessionEvents: vi.fn(),
  getMessagePage: vi.fn(),
  getCodexActivity: vi.fn(),
}));

import * as ipc from "../lib/ipc";

const m = vi.mocked(ipc);
const initialState = useStore.getState();
let emitSessionEvent: ((event: StreamEvent) => void) | null = null;

const show = (request: PendingCodexRequest): void => {
  useStore.setState({
    activeId: "session-1",
    pendingCodexRequest: request,
    remoteMode: false,
  });
};

beforeEach(() => {
  teardownAllBackgroundListeners();
  vi.clearAllMocks();
  useStore.setState(initialState, true);
  m.resolveCodexRequest.mockResolvedValue(undefined);
  m.subscribeSessionEvents.mockImplementation(async (_sessionId, onEvent) => {
    emitSessionEvent = onEvent;
    return () => {};
  });
  m.getMessagePage.mockResolvedValue({ messages: [], nextCursor: null });
  m.getCodexActivity.mockResolvedValue([]);
});

describe("CodexRequestPrompt", () => {
  it("submits request_user_input answers with question identities intact", async () => {
    show({
      id: "request-1",
      method: "item/tool/requestUserInput",
      params: {
        questions: [
          {
            id: "depth",
            header: "Approach",
            question: "How deeply should Codex investigate?",
            options: [
              { label: "Quick", description: "Use the most likely path." },
              { label: "Thorough", description: "Check every relevant path." },
            ],
          },
          {
            id: "token",
            header: "API token",
            question: "Enter the temporary token.",
            isSecret: true,
          },
        ],
      },
    });

    render(<CodexRequestPrompt />);

    expect(screen.getByRole("dialog", { name: "Codex needs your input" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Thorough/ }));
    const secret = screen.getByLabelText("API token");
    expect(secret).toHaveAttribute("type", "password");
    fireEvent.change(secret, { target: { value: "temporary-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    await waitFor(() =>
      expect(m.resolveCodexRequest).toHaveBeenCalledWith("request-1", {
        answers: {
          depth: { answers: ["Thorough"] },
          token: { answers: ["temporary-secret"] },
        },
      }),
    );
    expect(useStore.getState().pendingCodexRequest).toBeNull();
  });

  it("focuses the safe cancel action and unblocks a question request with no answers", async () => {
    show({
      id: "request-cancel",
      method: "item/tool/requestUserInput",
      params: {
        questions: [{ id: "name", header: "Name", question: "Which name should be used?" }],
      },
    });

    render(<CodexRequestPrompt />);

    const cancel = screen.getByRole("button", { name: "Cancel request" });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);

    await waitFor(() =>
      expect(m.resolveCodexRequest).toHaveBeenCalledWith("request-cancel", { answers: {} }),
    );
  });

  it("renders a typed MCP form and submits accepted structured content", async () => {
    show({
      id: "mcp-form",
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "Deploy MCP",
        mode: "form",
        message: "Choose deployment settings.",
        requestedSchema: {
          type: "object",
          required: ["project", "region"],
          properties: {
            project: { type: "string", title: "Project" },
            region: {
              type: "string",
              title: "Region",
              oneOf: [
                { const: "us", title: "United States" },
                { const: "eu", title: "Europe" },
              ],
            },
            logging: { type: "boolean", title: "Enable logs" },
            channels: {
              type: "array",
              title: "Channels",
              items: { type: "string", enum: ["email", "slack"] },
            },
          },
        },
      },
    });

    render(<CodexRequestPrompt />);

    expect(
      screen.getByRole("dialog", { name: "Deploy MCP is requesting input" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "portcode" } });
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "eu" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Enable logs/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "slack" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit to server" }));

    await waitFor(() =>
      expect(m.resolveCodexRequest).toHaveBeenCalledWith("mcp-form", {
        action: "accept",
        content: {
          project: "portcode",
          region: "eu",
          logging: true,
          channels: ["slack"],
        },
      }),
    );
  });

  it.each([
    ["Decline", { action: "decline" }],
    ["Cancel request", { action: "cancel" }],
  ] as const)("sends the MCP %s action without form content", async (buttonName, response) => {
    show({
      id: `mcp-${response.action}`,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "Calendar MCP",
        mode: "form",
        message: "Share an optional event title?",
        requestedSchema: { type: "object", properties: {} },
      },
    });

    render(<CodexRequestPrompt />);
    expect(screen.getByRole("button", { name: "Cancel request" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: buttonName }));

    await waitFor(() =>
      expect(m.resolveCodexRequest).toHaveBeenCalledWith(`mcp-${response.action}`, response),
    );
  });

  it("accepts openai/form content only after it parses as a JSON object", async () => {
    show({
      id: "mcp-openai-form",
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "Custom MCP",
        mode: "openai/form",
        message: "Provide structured details.",
        requestedSchema: true,
      },
    });

    render(<CodexRequestPrompt />);
    const editor = screen.getByLabelText("Structured response JSON");
    fireEvent.change(editor, { target: { value: "[]" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit to server" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a JSON object");
    expect(m.resolveCodexRequest).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: '{"team":"core"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Submit to server" }));
    await waitFor(() =>
      expect(m.resolveCodexRequest).toHaveBeenCalledWith("mcp-openai-form", {
        action: "accept",
        content: { team: "core" },
      }),
    );
  });

  it("keeps the prompt available when native response delivery fails", async () => {
    m.resolveCodexRequest.mockRejectedValueOnce(new Error("app-server disconnected"));
    show({
      id: "request-retry",
      method: "item/tool/requestUserInput",
      params: {
        questions: [{ id: "path", header: "Path", question: "Which path?" }],
      },
    });

    render(<CodexRequestPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("app-server disconnected");
    expect(useStore.getState().pendingCodexRequest?.id).toBe("request-retry");
    expect(screen.getByRole("button", { name: "Cancel request" })).toBeEnabled();
  });

  it("clears only the matching prompt when app-server resolves it externally", async () => {
    useStore.setState({
      activeId: "session-1",
      messages: { "session-1": [] },
      remoteMode: false,
    });
    await useStore.getState().selectSession("session-1");
    expect(emitSessionEvent).not.toBeNull();

    emitSessionEvent?.({
      type: "codex_request",
      id: "request-live",
      method: "item/tool/requestUserInput",
      params: { questions: [] },
    });
    expect(useStore.getState().pendingCodexRequest?.id).toBe("request-live");

    emitSessionEvent?.({
      type: "codex_request",
      id: "request-old",
      method: "serverRequest/resolved",
      params: {},
    });
    expect(useStore.getState().pendingCodexRequest?.id).toBe("request-live");

    emitSessionEvent?.({
      type: "codex_request",
      id: "request-live",
      method: "serverRequest/resolved",
      params: {},
    });
    expect(useStore.getState().pendingCodexRequest).toBeNull();
  });

  it("rejects unreadable and incomplete question payloads without sending them", async () => {
    show({
      id: "request-unreadable",
      method: "item/tool/requestUserInput",
      params: {},
    });

    const { rerender } = render(<CodexRequestPrompt />);
    expect(screen.getByRole("alert")).toHaveTextContent("did not contain any readable questions");

    const submit = screen.getByRole("button", { name: "Submit answers" });
    expect(submit).toBeDisabled();
    (submit as HTMLButtonElement).disabled = false;
    fireEvent.click(submit);
    expect(m.resolveCodexRequest).not.toHaveBeenCalled();

    show({
      id: "request-partially-readable",
      method: "item/tool/requestUserInput",
      params: {
        questions: [
          null,
          { id: "missing-fields" },
          {
            id: "valid",
            header: "Valid question",
            question: "What should Codex use?",
            options: [null, { label: "Missing description" }],
          },
        ],
      },
    });
    rerender(<CodexRequestPrompt />);

    expect(screen.getByLabelText("Valid question")).toBeInTheDocument();
    expect(screen.queryByText("Missing description")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(m.resolveCodexRequest).toHaveBeenCalledTimes(1));
  });

  it("supports enum labels, tolerant oneOf entries, anyOf arrays, and omitted optional values", async () => {
    show({
      id: "mcp-schema-variants",
      method: "mcpServer/elicitation/request",
      params: {
        mode: "form",
        requestedSchema: {
          type: "object",
          required: ["tier", "region"],
          properties: {
            tier: {
              type: "string",
              title: "Tier",
              oneOf: [{ title: "Missing value" }, { const: "pro", title: "Professional" }],
            },
            region: {
              type: "string",
              title: "Region",
              enum: ["red", 3, "blue"],
              enumNames: ["Rouge", null, "Bleu"],
            },
            labels: {
              type: "array",
              title: "Labels",
              items: {
                anyOf: [
                  null,
                  { title: "Missing value" },
                  { const: "alpha", title: "Alpha" },
                  { const: "beta" },
                ],
              },
            },
            note: { type: "string", title: "Note" },
          },
        },
      },
    });

    render(<CodexRequestPrompt />);
    fireEvent.change(screen.getByLabelText("Tier"), { target: { value: "pro" } });
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "blue" } });

    const alpha = screen.getByRole("checkbox", { name: "Alpha" });
    fireEvent.click(alpha);
    fireEvent.click(alpha);
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "temporary" } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit to server" }));

    await waitFor(() =>
      expect(m.resolveCodexRequest).toHaveBeenCalledWith("mcp-schema-variants", {
        action: "accept",
        content: { tier: "pro", region: "blue", labels: ["beta"] },
      }),
    );
  });

  it("accepts URL-mode MCP requests and exposes only safe browser links", async () => {
    show({
      id: "mcp-url",
      method: "mcpServer/elicitation/request",
      params: {
        mode: "url",
        serverName: "Login MCP",
        url: "https://example.test/authorize",
      },
    });

    render(<CodexRequestPrompt />);
    expect(screen.getByRole("link", { name: "Open secure request" })).toHaveAttribute(
      "href",
      "https://example.test/authorize",
    );
    fireEvent.click(screen.getByRole("button", { name: "I completed it" }));

    await waitFor(() =>
      expect(m.resolveCodexRequest).toHaveBeenCalledWith("mcp-url", { action: "accept" }),
    );
  });

  it("cancels unsupported request types once while native delivery is busy", async () => {
    let release!: () => void;
    m.resolveCodexRequest.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    show({ id: "unsupported", method: "future/request", params: {} });

    render(<CodexRequestPrompt />);
    const cancel = screen.getByRole("button", { name: "Cancel request" });
    fireEvent.click(cancel);
    await waitFor(() => expect(m.resolveCodexRequest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(cancel).toBeDisabled());

    (cancel as HTMLButtonElement).disabled = false;
    fireEvent.click(cancel);
    expect(m.resolveCodexRequest).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(useStore.getState().pendingCodexRequest).toBeNull());
  });
});
