import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MODELS,
  DEFAULT_SETTINGS,
  fastServiceTierForModel,
  MODELS,
  OPENAI_FALLBACK_MODELS,
  mergeOpenAIModels,
  modelSupportsFast,
  modelCatalog,
  modelInfo,
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
  it("defaults new and preview sessions to the bundled Codex engine", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
  });

  it("keeps the offline GPT-5.6 effort matrix model-specific", () => {
    const byId = new Map(OPENAI_FALLBACK_MODELS.map((model) => [model.id, model]));
    expect(byId.get("gpt-5.6-sol")).toMatchObject({
      defaultReasoningEffort: "low",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });
    expect(byId.get("gpt-5.6-terra")).toMatchObject({
      defaultReasoningEffort: "medium",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    });
    expect(byId.get("gpt-5.6-luna")).toMatchObject({
      defaultReasoningEffort: "medium",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(byId.has("gpt-5.3-codex-spark")).toBe(false);
    expect(OPENAI_FALLBACK_MODELS.every(modelSupportsFast)).toBe(true);
  });

  it("uses Codex service-tier metadata instead of guessing Fast support from model names", () => {
    const [fast, standardOnly] = mergeOpenAIModels([
      {
        id: "future-model-alpha",
        label: "Future Alpha",
        reasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        serviceTiers: [
          { id: "future-priority", name: "Fast", description: "Catalog-provided speed boost" },
          { id: "", name: "Invalid", description: "Ignored" },
        ],
      },
      {
        id: "gpt-5.999-ultra-fast-looking-name",
        label: "Misleading Name",
        reasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        serviceTiers: [],
      },
    ]);

    expect(modelSupportsFast(fast)).toBe(true);
    expect(fastServiceTierForModel(fast)).toEqual({
      id: "future-priority",
      name: "Fast",
      description: "Catalog-provided speed boost",
    });
    expect(modelSupportsFast(standardOnly)).toBe(false);
  });

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

  it("offers only Codex models while retaining legacy Claude labels for history", () => {
    const live = mergeOpenAIModels([
      {
        id: "new-codex-model",
        label: "New Codex Model",
        reasoningEfforts: ["custom"],
        defaultReasoningEffort: "custom",
      },
    ]);
    expect(providerGroups(live)).toEqual([{ id: "openai", label: "OpenAI · Codex", models: live }]);
    expect(modelCatalog(live)).toEqual(live);
    expect(MODELS.every((model) => model.provider === "openai")).toBe(true);
    expect(modelInfo(ANTHROPIC_MODELS[0].id, live)).toEqual(ANTHROPIC_MODELS[0]);
    expect(providerForModel("new-codex-model", live)).toBe("openai");
    expect(providerForModel("gpt-future", live)).toBe("openai");
    expect(providerForModel("claude-future", live)).toBe("anthropic");
    expect(providerForModel("future-model-with-no-known-prefix", live)).toBe("openai");
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
    expect(
      reasoningEffortForModel("gpt-empty", "ultra", [
        {
          id: "gpt-empty",
          label: "GPT Empty",
          provider: "openai",
          reasoningEfforts: [],
        },
      ]),
    ).toBe("medium");
    expect(reasoningEffortLabel("xhigh")).toBe("Extra high");
    expect(reasoningEffortLabel("future_mode")).toBe("Future Mode");
  });

  it("sanitizes malformed live effort metadata and never carries Ultra into Spark", () => {
    const live = mergeOpenAIModels([
      {
        id: "gpt-5.3-codex-spark",
        label: "GPT-5.3 Codex Spark",
        reasoningEfforts: ["low", "", "high", "high", "xhigh"],
        defaultReasoningEffort: "ultra",
      },
    ]);

    expect(live[0]).toMatchObject({
      reasoningEfforts: ["low", "high", "xhigh"],
      defaultReasoningEffort: "low",
    });
    expect(reasoningEffortForModel("gpt-5.3-codex-spark", "ultra", live)).toBe("low");
  });

  it("trims live ids and labels before applying last-row-wins deduplication", () => {
    const live = mergeOpenAIModels([
      {
        id: "  gpt-trimmed  ",
        label: " First label ",
        reasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
      },
      {
        id: "gpt-trimmed",
        label: "   ",
        reasoningEfforts: ["high"],
        defaultReasoningEffort: "high",
      },
    ]);

    expect(live).toEqual([
      {
        id: "gpt-trimmed",
        label: "gpt-trimmed",
        provider: "openai",
        reasoningEfforts: ["high"],
        defaultReasoningEffort: "high",
      },
    ]);
  });
});
