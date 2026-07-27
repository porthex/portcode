import {
  installQaAgentInterceptor,
  installQaValidationInterceptor,
  validateAttachments,
} from "../lib/ipc";
import { useStore } from "../store/store";
import type { Session, SyncFrame } from "../types";
import { createQaRuntime, type QaRuntime } from "./runtime";

type LocalFixtureInput = {
  sessions?: Array<{ id: string; title?: string }>;
  activeId?: string;
  draft?: string;
};

type QaControls = QaRuntime & {
  resetScenario: () => void;
  seedLocalComposer: (input?: LocalFixtureInput) => void;
  session: {
    select: (id: string) => Promise<void>;
    disappear: (id: string) => void;
  };
  remote: {
    enter: (input: { sessions: Session[]; activeId?: string }) => void;
    emit: (frame: SyncFrame) => void;
    leave: () => void;
  };
};

declare global {
  interface Window {
    __PORTCODE_QA__?: QaControls;
  }
}

const QA_PROFILE_ID = "qa-codex";
const QA_MODEL_ID = "gpt-5.2-codex";

function fixtureSession(id: string, title = `QA ${id}`): Session {
  return {
    id,
    title,
    workspace: null,
    model: QA_MODEL_ID,
    accountProfileId: QA_PROFILE_ID,
    createdAt: 1,
    updatedAt: 1,
  };
}

function readyMessageLoads(sessions: Session[]) {
  return Object.fromEntries(
    sessions.map((session) => [
      session.id,
      {
        phase: "ready" as const,
        loadedAt: 1,
        lastAccessedAt: 1,
        requestId: 0,
        error: null,
        nextCursor: null,
        loadingOlder: false,
      },
    ]),
  );
}

function omitKey<T>(record: Record<string, T>, id: string): Record<string, T> {
  if (!(id in record)) return record;
  const next = { ...record };
  delete next[id];
  return next;
}

export function installQaControls(): QaControls {
  if (window.__PORTCODE_QA__) return window.__PORTCODE_QA__;
  const runtime = createQaRuntime({ validateAttachments });
  installQaValidationInterceptor((paths, validateNative) =>
    runtime.interceptValidation(paths, validateNative),
  );
  installQaAgentInterceptor((sessionId, text, onEvent, attachmentPaths, _attachmentDisplayNames) =>
    runtime.interceptAgent(sessionId, text, onEvent, attachmentPaths),
  );

  const resetScenario = () => {
    runtime.reset();
    useStore.setState({
      sessions: [],
      activeId: null,
      pendingSession: null,
      messages: {},
      messageLoads: {},
      messagePaging: {},
      usage: {},
      agents: {},
      backgroundTasks: {},
      codexActivity: {},
      codexActivityPaging: {},
      drafts: {},
      attachments: {},
      attachmentBusy: {},
      attachmentErrors: {},
      attachmentSendErrors: {},
      attachmentRetryPaths: {},
      runs: {},
      streaming: false,
      cancel: null,
      pendingPermission: null,
      pendingCodexRequest: null,
      scrollTargetId: null,
      transcriptScrollRequest: null,
      remoteMode: false,
      remoteConnected: false,
      remoteVerified: false,
      remoteChatOpen: false,
      composerPhase: "idle",
      activeTool: null,
    });
  };

  const controls: QaControls = Object.assign(runtime, {
    resetScenario,
    seedLocalComposer(input: LocalFixtureInput = {}) {
      runtime.reset();
      const sessions = (input.sessions ?? [{ id: "qa-session-a" }, { id: "qa-session-b" }]).map(
        (session) => fixtureSession(session.id, session.title),
      );
      const activeId = input.activeId ?? sessions[0]?.id ?? null;
      useStore.setState((state) => ({
        sessions,
        activeId,
        pendingSession: null,
        messages: Object.fromEntries(sessions.map((session) => [session.id, []])),
        messageLoads: readyMessageLoads(sessions),
        messagePaging: {},
        usage: {},
        agents: {},
        backgroundTasks: {},
        codexActivity: {},
        codexActivityPaging: {},
        drafts: activeId && input.draft ? { [activeId]: input.draft } : {},
        attachments: {},
        attachmentBusy: {},
        attachmentErrors: {},
        attachmentSendErrors: {},
        attachmentRetryPaths: {},
        runs: {},
        streaming: false,
        cancel: null,
        pendingPermission: null,
        pendingCodexRequest: null,
        scrollTargetId: null,
        transcriptScrollRequest: null,
        composerPhase: "idle",
        activeTool: null,
        remoteMode: false,
        remoteConnected: false,
        remoteVerified: false,
        remoteChatOpen: false,
        openAIAccounts: [
          {
            id: QA_PROFILE_ID,
            accountLabel: "QA Codex",
            tier: "test",
            expiresAt: null,
            state: "connected",
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: null,
          },
        ],
        openAIModels: [
          {
            id: QA_MODEL_ID,
            label: "QA Codex",
            provider: "openai",
            reasoningEfforts: ["medium"],
            defaultReasoningEffort: "medium",
          },
        ],
        openAIModelCatalogs: {
          [QA_PROFILE_ID]: {
            status: "ready",
            models: [
              {
                id: QA_MODEL_ID,
                label: "QA Codex",
                provider: "openai",
                reasoningEfforts: ["medium"],
                defaultReasoningEffort: "medium",
              },
            ],
            error: null,
          },
        },
        lastOpenAIAccountProfileId: QA_PROFILE_ID,
        settings: { ...state.settings, model: QA_MODEL_ID, reasoningEffort: "medium" },
      }));
    },
    session: {
      select: (id: string) => useStore.getState().selectSession(id),
      disappear(id: string) {
        useStore.setState((state) => {
          const sessions = state.sessions.filter((session) => session.id !== id);
          return {
            sessions,
            activeId: state.activeId === id ? (sessions[0]?.id ?? null) : state.activeId,
            messages: omitKey(state.messages, id),
            messageLoads: omitKey(state.messageLoads, id),
            drafts: omitKey(state.drafts, id),
            attachments: omitKey(state.attachments, id),
            attachmentBusy: omitKey(state.attachmentBusy, id),
            attachmentErrors: omitKey(state.attachmentErrors, id),
            attachmentSendErrors: omitKey(state.attachmentSendErrors, id),
            attachmentRetryPaths: omitKey(state.attachmentRetryPaths, id),
            runs: omitKey(state.runs, id),
          };
        });
      },
    },
    remote: {
      enter(input: { sessions: Session[]; activeId?: string }) {
        runtime.reset();
        useStore.setState({
          activeId: input.activeId ?? input.sessions[0]?.id ?? null,
          remoteMode: true,
          remoteConnected: true,
          remoteVerified: true,
          remoteChatOpen: true,
          runs: {},
        });
        useStore.getState().applyFrame({ t: "session_list", sessions: input.sessions });
      },
      emit(frame: SyncFrame) {
        useStore.getState().applyFrame(frame);
      },
      leave() {
        runtime.reset();
        useStore.setState({
          remoteMode: false,
          remoteConnected: false,
          remoteVerified: false,
          remoteChatOpen: false,
          runs: {},
        });
      },
    },
  });

  window.__PORTCODE_QA__ = controls;
  return controls;
}
