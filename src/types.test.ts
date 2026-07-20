import { describe, expect, it } from "vitest";

import {
  OPENAI_FALLBACK_MODELS,
  mergeOpenAIModels,
  openAIAccountLabel,
  providerForModel,
  providerGroups,
  reasoningEffortForModel,
  reasoningEffortLabel,
} from "./types";

const account = (
  id: string,
  accountLabel: string | null,
  createdAt: number,
): import("./types").OpenAIAccountSummary => ({
  id,
  accountLabel,
  tier: null,
  expiresAt: null,
  state: "connected",
  createdAt,
  updatedAt: createdAt,
  lastUsedAt: null,
});

describe("OpenAI model catalogue helpers", () => {
  it("disambiguates duplicate and missing account labels without exposing profile ids", () => {
    const accounts = [
      account("opaque-z", "same@example.test", 20),
      account("opaque-a", null, 10),
      account("opaque-b", "same@example.test", 10),
      account("opaque-c", null, 30),
      account("opaque-unique", "unique@example.test", 40),
    ];

    expect(openAIAccountLabel(accounts[0], accounts)).toBe("same@example.test 2");
    expect(openAIAccountLabel(accounts[2], accounts)).toBe("same@example.test 1");
    expect(openAIAccountLabel(accounts[1], accounts)).toBe("ChatGPT account 1");
    expect(openAIAccountLabel(accounts[3], accounts)).toBe("ChatGPT account 2");
    expect(openAIAccountLabel(accounts[4], accounts)).toBe("unique@example.test");
    expect(accounts.map((item) => openAIAccountLabel(item, accounts)).join(" ")).not.toContain(
      "opaque-",
    );
  });
  it("uses conservative fallbacks only when the live catalogue is empty", () => {
    expect(mergeOpenAIModels([])).toEqual(OPENAI_FALLBACK_MODELS);

    const live = mergeOpenAIModels([
      {
        id: "gpt-5.5-codex",
        label: "GPT-5.5 Codex",
        reasoningEfforts: ["minimal", "high", "high", "ultra"],
        defaultReasoningEffort: "high",
      },
      {
        id: "gpt-5.5-codex",
        label: "duplicate",
        reasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
      },
    ]);

    expect(live).toEqual([
      {
        id: "gpt-5.5-codex",
        label: "duplicate",
        provider: "openai",
        reasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
      },
    ]);
    expect(live.some((model) => model.id === "gpt-5.6-sol")).toBe(false);
  });

  it("groups both providers and resolves known, live, and conservative slug providers", () => {
    const live = mergeOpenAIModels([
      {
        id: "new-codex-model",
        label: "New Codex Model",
        reasoningEfforts: ["custom"],
        defaultReasoningEffort: "custom",
      },
    ]);
    expect(providerGroups(live).map((group) => group.id)).toEqual(["anthropic", "openai"]);
    expect(providerForModel("new-codex-model", live)).toBe("openai");
    expect(providerForModel("gpt-future", live)).toBe("openai");
    expect(providerForModel("claude-future", live)).toBe("anthropic");
  });

  it("falls back to the advertised reasoning default and labels unknown levels", () => {
    const live = mergeOpenAIModels([
      {
        id: "gpt-test",
        label: "GPT Test",
        reasoningEfforts: ["minimal", "ultra"],
        defaultReasoningEffort: "ultra",
      },
    ]);
    expect(reasoningEffortForModel("gpt-test", "medium", live)).toBe("ultra");
    expect(reasoningEffortForModel("gpt-test", "minimal", live)).toBe("minimal");
    expect(reasoningEffortLabel("xhigh")).toBe("Extra high");
    expect(reasoningEffortLabel("future_mode")).toBe("Future Mode");
  });
});
