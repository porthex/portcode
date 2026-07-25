import { describe, expect, it, vi } from "vitest";
import type { AttachmentValidationResult } from "../types";
import { createQaRuntime } from "./runtime";

const result: AttachmentValidationResult = { attachments: [], errors: [] };

describe("QA runtime validation control", () => {
  it("defers one native validation result until explicitly released", async () => {
    const native = vi.fn(async () => result);
    const runtime = createQaRuntime({ validateAttachments: native });
    const operationId = runtime.validation.deferNext({ useNativeResult: true });

    const pending = runtime.interceptValidation(["D:/qa/fixture.txt"]);
    await Promise.resolve();

    expect(native).toHaveBeenCalledWith(["D:/qa/fixture.txt"]);
    expect(runtime.snapshot().pendingOperations).toEqual([operationId]);
    await expect(Promise.race([pending, Promise.resolve("pending")])).resolves.toBe("pending");

    runtime.validation.resolve(operationId);
    await expect(pending).resolves.toEqual(result);
    expect(runtime.snapshot().pendingOperations).toEqual([]);
  });

  it("passes unarmed manual validation through to the native validator", async () => {
    const native = vi.fn(async () => result);
    const runtime = createQaRuntime({ validateAttachments: native });

    await expect(runtime.interceptValidation(["D:/qa/manual.txt"])).resolves.toEqual(result);
    expect(native).toHaveBeenCalledWith(["D:/qa/manual.txt"]);
  });

  it("makes deferred operations inert after reset", async () => {
    const native = vi.fn(async () => result);
    const runtime = createQaRuntime({ validateAttachments: native });

    const operationId = runtime.validation.deferNext({ useNativeResult: true });
    const pending = runtime.interceptValidation(["D:/qa/stale.txt"]);
    runtime.reset();
    runtime.validation.resolve(operationId);

    await expect(pending).rejects.toThrow("QA scenario was reset");
    expect(runtime.snapshot().pendingOperations).toEqual([]);
  });
});

describe("QA runtime agent control", () => {
  it("denies unarmed provider calls and drives acceptance plus events without native IPC", async () => {
    const runtime = createQaRuntime({ validateAttachments: async () => result });
    const events: Array<{ type: string; text?: string }> = [];

    await expect(
      runtime.interceptAgent("session-a", "hello", (event) => events.push(event), []),
    ).rejects.toThrow("QA agent is not armed");

    const operationId = runtime.agent.deferNext();
    const pending = runtime.interceptAgent("session-a", "hello", (event) => events.push(event), [
      "D:/qa/fixture.txt",
    ]);
    expect(runtime.snapshot().pendingOperations).toEqual([operationId]);

    runtime.agent.accept(operationId);
    const handle = await pending;
    runtime.agent.emit(operationId, { type: "text_delta", text: "working" });
    expect(events).toEqual([{ type: "text_delta", text: "working" }]);

    handle.dispose();
    runtime.agent.emit(operationId, { type: "text_delta", text: "late" });
    expect(events).toHaveLength(1);
  });
});
