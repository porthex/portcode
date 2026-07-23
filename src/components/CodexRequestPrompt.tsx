import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useStore } from "../store/store";
import type { CodexRequestResponse, PendingCodexRequest } from "../types";

type JsonObject = Record<string, unknown>;

interface UserInputOption {
  label: string;
  description: string;
}

interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[];
}

interface McpField {
  name: string;
  required: boolean;
  schema: JsonObject;
}

const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const parseQuestions = (params: unknown): UserInputQuestion[] => {
  const raw = asObject(params)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((candidate) => {
    const question = asObject(candidate);
    const id = asString(question?.id);
    const prompt = asString(question?.question);
    const header = asString(question?.header);
    if (!question || !id || !prompt || !header) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((candidateOption) => {
          const option = asObject(candidateOption);
          const label = asString(option?.label);
          const description = asString(option?.description);
          return option && label && description ? [{ label, description }] : [];
        })
      : [];
    return [
      {
        id,
        header,
        question: prompt,
        isOther: question.isOther === true,
        isSecret: question.isSecret === true,
        options,
      },
    ];
  });
};

const mcpFields = (params: unknown): McpField[] => {
  const schema = asObject(asObject(params)?.requestedSchema);
  const properties = asObject(schema?.properties);
  if (!properties) return [];
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  return Object.entries(properties).flatMap(([name, value]) => {
    const fieldSchema = asObject(value);
    return fieldSchema ? [{ name, required: required.has(name), schema: fieldSchema }] : [];
  });
};

const fieldOptions = (schema: JsonObject): { value: string; label: string }[] => {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.flatMap((candidate) => {
      const option = asObject(candidate);
      const value = asString(option?.const);
      if (!value) return [];
      return [{ value, label: asString(option?.title) ?? value }];
    });
  }
  if (Array.isArray(schema.enum)) {
    const labels = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.flatMap((candidate, index) =>
      typeof candidate === "string"
        ? [{ value: candidate, label: asString(labels[index]) ?? candidate }]
        : [],
    );
  }
  return [];
};

const arrayFieldOptions = (schema: JsonObject): { value: string; label: string }[] => {
  const items = asObject(schema.items);
  if (!items) return [];
  if (Array.isArray(items.anyOf)) {
    return items.anyOf.flatMap((candidate) => {
      const option = asObject(candidate);
      const value = asString(option?.const);
      if (!value) return [];
      return [{ value, label: asString(option?.title) ?? value }];
    });
  }
  return Array.isArray(items.enum)
    ? items.enum.flatMap((candidate) =>
        typeof candidate === "string" ? [{ value: candidate, label: candidate }] : [],
      )
    : [];
};

const initialMcpValues = (fields: McpField[]): JsonObject =>
  Object.fromEntries(
    fields.flatMap((field) =>
      field.schema.default !== undefined && field.schema.default !== null
        ? [[field.name, field.schema.default]]
        : field.schema.type === "boolean"
          ? [[field.name, false]]
          : [],
    ),
  );

const hasRequiredValue = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  (typeof value !== "string" || value.trim().length > 0) &&
  (!Array.isArray(value) || value.length > 0);

const acceptedMcpContent = (fields: McpField[], values: JsonObject): JsonObject =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const value = values[field.name];
      if (value === undefined || value === null || (!field.required && value === "")) return [];
      return [[field.name, value]];
    }),
  );

/** Inline prompt for app-server requests that need structured user input. */
export function CodexRequestPrompt() {
  const request = useStore((state) => state.pendingCodexRequest);
  const activeId = useStore((state) => state.activeId);
  const resolve = useStore((state) => state.resolveCodexRequest);

  if (!request || !activeId) return null;
  return (
    <CodexRequestPanel
      key={request.id}
      request={request}
      respond={(response) => resolve(activeId, request.id, response)}
    />
  );
}

function CodexRequestPanel({
  request,
  respond,
}: {
  request: PendingCodexRequest;
  respond: (response: CodexRequestResponse) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const send = async (response: CodexRequestResponse): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await respond(response);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby={`codex-request-${request.id}`}
      className="pc-gate shrink-0 px-6 py-4"
    >
      {request.method === "item/tool/requestUserInput" ? (
        <UserInputForm
          request={request}
          busy={busy}
          cancelRef={cancelRef}
          onRespond={(response) => void send(response)}
        />
      ) : request.method === "mcpServer/elicitation/request" ? (
        <McpElicitationForm
          request={request}
          busy={busy}
          cancelRef={cancelRef}
          onRespond={(response) => void send(response)}
        />
      ) : (
        <UnsupportedRequest
          request={request}
          busy={busy}
          cancelRef={cancelRef}
          onCancel={() => void send({ action: "cancel" })}
        />
      )}
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          Could not send the response: {error}
        </p>
      )}
    </section>
  );
}

function UserInputForm({
  request,
  busy,
  cancelRef,
  onRespond,
}: {
  request: PendingCodexRequest;
  busy: boolean;
  cancelRef: RefObject<HTMLButtonElement | null>;
  onRespond: (response: CodexRequestResponse) => void;
}) {
  const questions = useMemo(() => parseQuestions(request.params), [request.params]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const complete =
    questions.length > 0 && questions.every((question) => answers[question.id]?.trim());

  const submit = (): void => {
    if (!complete) return;
    onRespond({
      answers: Object.fromEntries(
        questions.map((question) => [question.id, { answers: [answers[question.id].trim()] }]),
      ),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 id={`codex-request-${request.id}`} className="text-[13px] font-medium text-fg">
          Codex needs your input
        </h2>
        <p className="mt-1 text-[11.5px] text-muted">
          Your answers go directly to the running Codex tool.
        </p>
      </div>

      {questions.length === 0 ? (
        <p role="alert" className="text-[12px] text-danger">
          This request did not contain any readable questions. Cancel it to continue safely.
        </p>
      ) : (
        questions.map((question) => {
          const optionValues = new Set(question.options.map((option) => option.label));
          const otherValue = optionValues.has(answers[question.id])
            ? ""
            : (answers[question.id] ?? "");
          return (
            <fieldset key={question.id} className="rounded border border-border bg-panel-2 p-3">
              <legend className="px-1 text-[11px] font-medium uppercase tracking-wide text-accent-2">
                {question.header}
              </legend>
              <p className="mb-2 text-[12.5px] leading-relaxed text-fg">{question.question}</p>
              {question.options.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {question.options.map((option) => (
                    <label
                      key={option.label}
                      className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-white/5"
                    >
                      <input
                        type="radio"
                        name={`${request.id}-${question.id}`}
                        value={option.label}
                        checked={answers[question.id] === option.label}
                        disabled={busy}
                        onChange={() =>
                          setAnswers((current) => ({ ...current, [question.id]: option.label }))
                        }
                      />
                      <span>
                        <span className="block text-[12px] text-fg">{option.label}</span>
                        <span className="block text-[11px] text-muted">{option.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {(question.options.length === 0 || question.isOther) && (
                <label className="mt-2 block text-[11px] text-muted">
                  {question.options.length > 0 ? "Other answer" : question.header}
                  <input
                    aria-label={question.header}
                    type={question.isSecret ? "password" : "text"}
                    autoComplete={question.isSecret ? "off" : undefined}
                    value={question.options.length > 0 ? otherValue : (answers[question.id] ?? "")}
                    disabled={busy}
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }))
                    }
                    className="mt-1 w-full rounded border border-border bg-panel px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent-2"
                  />
                </label>
              )}
            </fieldset>
          );
        })
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!complete || busy}
          onClick={submit}
          className="pc-btn-allow px-3.5 py-1.5 text-[12.5px] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Submit answers
        </button>
        <button
          ref={cancelRef}
          type="button"
          disabled={busy}
          onClick={() => onRespond({ answers: {} })}
          className="pc-btn-deny px-3.5 py-1.5 text-[12.5px] disabled:opacity-50"
        >
          Cancel request
        </button>
      </div>
    </div>
  );
}

function McpElicitationForm({
  request,
  busy,
  cancelRef,
  onRespond,
}: {
  request: PendingCodexRequest;
  busy: boolean;
  cancelRef: RefObject<HTMLButtonElement | null>;
  onRespond: (response: CodexRequestResponse) => void;
}) {
  const params = asObject(request.params);
  const mode = asString(params?.mode) ?? "unknown";
  const serverName = asString(params?.serverName) ?? "MCP server";
  const message = asString(params?.message) ?? "This server needs more information.";
  const fields = useMemo(() => mcpFields(request.params), [request.params]);
  const [values, setValues] = useState<JsonObject>(() => initialMcpValues(fields));
  const [rawJson, setRawJson] = useState("{}");
  const [rawError, setRawError] = useState<string | null>(null);
  const requiredComplete = fields.every(
    (field) => !field.required || hasRequiredValue(values[field.name]),
  );

  const accept = (): void => {
    if (mode === "form") {
      if (!requiredComplete) return;
      onRespond({ action: "accept", content: acceptedMcpContent(fields, values) });
      return;
    }
    if (mode === "openai/form") {
      try {
        const content = JSON.parse(rawJson) as unknown;
        if (!asObject(content)) throw new Error("Enter a JSON object.");
        setRawError(null);
        onRespond({ action: "accept", content });
      } catch (cause) {
        setRawError(errorText(cause));
      }
      return;
    }
    if (mode === "url") onRespond({ action: "accept" });
  };

  const url = asString(params?.url);
  const safeUrl = url && /^https?:\/\//i.test(url) ? url : null;
  const canAccept =
    mode === "url" || mode === "openai/form" || (mode === "form" && requiredComplete);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 id={`codex-request-${request.id}`} className="text-[13px] font-medium text-fg">
          {serverName} is requesting input
        </h2>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{message}</p>
      </div>

      {mode === "form" && (
        <div className="grid gap-3 rounded border border-border bg-panel-2 p-3">
          {fields.length === 0 ? (
            <p className="text-[12px] text-muted">No form fields were requested.</p>
          ) : (
            fields.map((field) => (
              <McpFieldInput
                key={field.name}
                field={field}
                value={values[field.name]}
                disabled={busy}
                onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
              />
            ))
          )}
        </div>
      )}

      {mode === "openai/form" && (
        <label className="text-[11px] text-muted">
          Structured response (JSON object)
          <textarea
            aria-label="Structured response JSON"
            value={rawJson}
            disabled={busy}
            onChange={(event) => setRawJson(event.target.value)}
            className="mt-1 min-h-24 w-full rounded border border-border bg-panel px-2.5 py-2 font-mono text-[12px] text-fg outline-none focus:border-accent-2"
          />
          {rawError && (
            <span role="alert" className="mt-1 block text-danger">
              {rawError}
            </span>
          )}
        </label>
      )}

      {mode === "url" && (
        <div className="rounded border border-border bg-panel-2 p-3 text-[12px] text-muted">
          Complete the request in your browser, then confirm here.
          {safeUrl ? (
            <a
              href={safeUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 block break-all text-accent-2 underline"
            >
              Open secure request
            </a>
          ) : url ? (
            <code className="mt-2 block break-all text-danger">{url}</code>
          ) : null}
        </div>
      )}

      {!["form", "openai/form", "url"].includes(mode) && (
        <p role="alert" className="text-[12px] text-danger">
          This MCP request uses an unsupported mode. Decline or cancel it safely.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {canAccept && (
          <button
            type="button"
            disabled={busy || !canAccept}
            onClick={accept}
            className="pc-btn-allow px-3.5 py-1.5 text-[12.5px] disabled:opacity-50"
          >
            {mode === "url" ? "I completed it" : "Submit to server"}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => onRespond({ action: "decline" })}
          className="pc-btn-deny px-3.5 py-1.5 text-[12.5px] disabled:opacity-50"
        >
          Decline
        </button>
        <button
          ref={cancelRef}
          type="button"
          disabled={busy}
          onClick={() => onRespond({ action: "cancel" })}
          className="pc-btn-deny px-3.5 py-1.5 text-[12.5px] disabled:opacity-50"
        >
          Cancel request
        </button>
      </div>
    </div>
  );
}

function McpFieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: McpField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const title = asString(field.schema.title) ?? field.name;
  const description = asString(field.schema.description);
  const options = fieldOptions(field.schema);
  const arrayOptions = arrayFieldOptions(field.schema);
  const type = asString(field.schema.type) ?? "string";
  const label = `${title}${field.required ? " *" : ""}`;

  if (type === "boolean") {
    return (
      <label className="flex items-start gap-2 text-[12px] text-fg">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          <span className="block">{label}</span>
          {description && <span className="block text-[11px] text-muted">{description}</span>}
        </span>
      </label>
    );
  }

  if (type === "array" && arrayOptions.length > 0) {
    const selected = Array.isArray(value)
      ? value.filter((candidate): candidate is string => typeof candidate === "string")
      : [];
    return (
      <fieldset>
        <legend className="text-[11px] text-muted">{label}</legend>
        {description && <p className="mb-1 text-[11px] text-muted">{description}</p>}
        <div className="flex flex-wrap gap-3">
          {arrayOptions.map((option) => (
            <label key={option.value} className="flex items-center gap-1.5 text-[12px] text-fg">
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((candidate) => candidate !== option.value),
                  )
                }
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  if (options.length > 0) {
    return (
      <label className="text-[11px] text-muted">
        {label}
        {description && <span className="ml-1">— {description}</span>}
        <select
          aria-label={title}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 w-full rounded border border-border bg-panel px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent-2"
        >
          <option value="">Select…</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const inputType =
    type === "number" || type === "integer"
      ? "number"
      : field.schema.format === "email"
        ? "email"
        : field.schema.format === "date"
          ? "date"
          : field.schema.format === "date-time"
            ? "datetime-local"
            : field.schema.format === "uri"
              ? "url"
              : "text";
  return (
    <label className="text-[11px] text-muted">
      {label}
      {description && <span className="ml-1">— {description}</span>}
      <input
        aria-label={title}
        type={inputType}
        value={typeof value === "string" || typeof value === "number" ? value : ""}
        disabled={disabled}
        required={field.required}
        min={typeof field.schema.minimum === "number" ? field.schema.minimum : undefined}
        max={typeof field.schema.maximum === "number" ? field.schema.maximum : undefined}
        minLength={typeof field.schema.minLength === "number" ? field.schema.minLength : undefined}
        maxLength={typeof field.schema.maxLength === "number" ? field.schema.maxLength : undefined}
        onChange={(event) =>
          onChange(
            type === "number" || type === "integer"
              ? event.target.value === ""
                ? undefined
                : Number(event.target.value)
              : event.target.value,
          )
        }
        className="mt-1 w-full rounded border border-border bg-panel px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent-2"
      />
    </label>
  );
}

function UnsupportedRequest({
  request,
  busy,
  cancelRef,
  onCancel,
}: {
  request: PendingCodexRequest;
  busy: boolean;
  cancelRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 id={`codex-request-${request.id}`} className="text-[13px] font-medium text-fg">
        Codex is waiting for a response
      </h2>
      <p role="alert" className="text-[12px] text-danger">
        Portcode does not recognize this request type ({request.method}). Cancel it safely.
      </p>
      <button
        ref={cancelRef}
        type="button"
        disabled={busy}
        onClick={onCancel}
        className="pc-btn-deny w-fit px-3.5 py-1.5 text-[12.5px] disabled:opacity-50"
      >
        Cancel request
      </button>
    </div>
  );
}
