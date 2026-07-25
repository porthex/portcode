import type { AgentRunHandle } from "../lib/ipc";
import type { AttachmentValidationResult, StreamEvent } from "../types";

type ValidationArm = {
  id: string;
  useNativeResult: boolean;
  rejection?: string;
};

type PendingValidation = {
  generation: number;
  nativeResult: Promise<AttachmentValidationResult>;
  resolve: (value: AttachmentValidationResult) => void;
  reject: (error: Error) => void;
};

type AgentOperation = {
  generation: number;
  accepted: boolean;
  disposed: boolean;
  onEvent: (event: StreamEvent) => void;
  resolve: (handle: AgentRunHandle) => void;
  reject: (error: Error) => void;
};

type QaRuntimeDependencies = {
  validateAttachments: (paths: string[]) => Promise<AttachmentValidationResult>;
};

export function createQaRuntime(dependencies: QaRuntimeDependencies) {
  let generation = 0;
  let nextOperation = 1;
  let validationArm: ValidationArm | null = null;
  let agentArm: string | null = null;
  const pendingValidations = new Map<string, PendingValidation>();
  const agentOperations = new Map<string, AgentOperation>();

  const validation = {
    deferNext(options: { useNativeResult?: boolean } = {}): string {
      if (validationArm) throw new Error("QA validation is already armed");
      const id = `qa-validation-${nextOperation++}`;
      validationArm = { id, useNativeResult: options.useNativeResult ?? false };
      return id;
    },

    rejectNext(message: string): string {
      if (validationArm) throw new Error("QA validation is already armed");
      const id = `qa-validation-${nextOperation++}`;
      validationArm = { id, useNativeResult: false, rejection: message };
      return id;
    },

    resolve(operationId: string): void {
      const operation = pendingValidations.get(operationId);
      if (!operation || operation.generation !== generation) return;
      pendingValidations.delete(operationId);
      void operation.nativeResult.then(operation.resolve, operation.reject);
    },

    reject(operationId: string, message: string): void {
      const operation = pendingValidations.get(operationId);
      if (!operation || operation.generation !== generation) return;
      pendingValidations.delete(operationId);
      operation.reject(new Error(message));
    },
  };

  const agent = {
    deferNext(): string {
      if (agentArm) throw new Error("QA agent is already armed");
      const id = `qa-agent-${nextOperation++}`;
      agentArm = id;
      return id;
    },

    accept(operationId: string): void {
      const operation = agentOperations.get(operationId);
      if (!operation || operation.generation !== generation || operation.accepted) return;
      operation.accepted = true;
      operation.resolve({
        cancel: async () => {
          operation.disposed = true;
          agentOperations.delete(operationId);
        },
        dispose: () => {
          operation.disposed = true;
          agentOperations.delete(operationId);
        },
      });
    },

    reject(operationId: string, message: string): void {
      const operation = agentOperations.get(operationId);
      if (!operation || operation.generation !== generation || operation.accepted) return;
      agentOperations.delete(operationId);
      operation.reject(new Error(message));
    },

    emit(operationId: string, event: StreamEvent): void {
      const operation = agentOperations.get(operationId);
      if (
        !operation ||
        operation.generation !== generation ||
        !operation.accepted ||
        operation.disposed
      ) {
        return;
      }
      operation.onEvent(event);
    },
  };

  async function interceptValidation(
    paths: string[],
    validateNative = dependencies.validateAttachments,
  ): Promise<AttachmentValidationResult> {
    const arm = validationArm;
    validationArm = null;
    if (!arm) return validateNative(paths);
    if (arm.rejection) throw new Error(arm.rejection);

    const operationGeneration = generation;
    const nativeResult = arm.useNativeResult
      ? validateNative(paths)
      : Promise.resolve({ attachments: [], errors: [] });

    return new Promise<AttachmentValidationResult>((resolve, reject) => {
      pendingValidations.set(arm.id, {
        generation: operationGeneration,
        nativeResult,
        resolve,
        reject,
      });
    });
  }

  async function interceptAgent(
    _sessionId: string,
    _text: string,
    onEvent: (event: StreamEvent) => void,
    _attachmentPaths: string[],
  ): Promise<AgentRunHandle> {
    const operationId = agentArm;
    agentArm = null;
    if (!operationId) throw new Error("QA agent is not armed");
    const operationGeneration = generation;
    return new Promise<AgentRunHandle>((resolve, reject) => {
      agentOperations.set(operationId, {
        generation: operationGeneration,
        accepted: false,
        disposed: false,
        onEvent,
        resolve,
        reject,
      });
    });
  }

  function reset(): void {
    generation += 1;
    validationArm = null;
    agentArm = null;
    for (const operation of pendingValidations.values()) {
      operation.reject(new Error("QA scenario was reset"));
    }
    pendingValidations.clear();
    for (const operation of agentOperations.values()) {
      if (!operation.accepted) operation.reject(new Error("QA scenario was reset"));
      operation.disposed = true;
    }
    agentOperations.clear();
  }

  function snapshot() {
    return {
      pendingOperations: [
        ...pendingValidations.keys(),
        ...[...agentOperations.entries()]
          .filter(([, operation]) => !operation.accepted)
          .map(([id]) => id),
      ],
    };
  }

  return { validation, agent, interceptValidation, interceptAgent, reset, snapshot };
}

export type QaRuntime = ReturnType<typeof createQaRuntime>;
