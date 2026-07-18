/**
 * Portcode's stable, provider-neutral tool vocabulary.
 *
 * Models and persisted transcripts may still send the original short names.
 * Keep those aliases at the presentation boundary so old chats, permissions,
 * and rules retain their meaning while every new surface speaks one language.
 */
export const CANONICAL_TOOL_NAMES = [
  "read_file",
  "list_directory",
  "find_files",
  "search_text",
  "write_file",
  "edit_file",
  "run_command",
  "delegate_task",
] as const;

export type CanonicalToolName = (typeof CANONICAL_TOOL_NAMES)[number];

export const LEGACY_TOOL_ALIASES = {
  fs_read: "read_file",
  list: "list_directory",
  glob: "find_files",
  grep: "search_text",
  fs_write: "write_file",
  fs_edit: "edit_file",
  shell: "run_command",
  task: "delegate_task",
} as const satisfies Record<string, CanonicalToolName>;

export type LegacyToolName = keyof typeof LEGACY_TOOL_ALIASES;

/** Known built-ins plus forward-compatible provider/integration tools. */
export type ToolName = CanonicalToolName | LegacyToolName | (string & Record<never, never>);

interface ToolPresentation {
  label: string;
  presence: string;
}

const TOOL_PRESENTATION: Record<CanonicalToolName, ToolPresentation> = {
  read_file: { label: "Read file", presence: "reading a file…" },
  list_directory: { label: "Browse folder", presence: "browsing a folder…" },
  find_files: { label: "Find files", presence: "finding files…" },
  search_text: { label: "Search project", presence: "searching the project…" },
  write_file: { label: "Write file", presence: "writing a file…" },
  edit_file: { label: "Edit file", presence: "editing a file…" },
  run_command: { label: "Run command", presence: "running a command…" },
  delegate_task: { label: "Delegate task", presence: "delegating a task…" },
};

const CANONICAL_TOOL_SET = new Set<string>(CANONICAL_TOOL_NAMES);
const ROUTINE_TOOL_SET = new Set<CanonicalToolName>([
  "read_file",
  "list_directory",
  "find_files",
  "search_text",
]);

/** Resolve a historical ID to its current ID. Unknown integrations pass through. */
export function canonicalToolName(name: string): CanonicalToolName | string {
  return Object.prototype.hasOwnProperty.call(LEGACY_TOOL_ALIASES, name)
    ? LEGACY_TOOL_ALIASES[name as LegacyToolName]
    : name;
}

export function isCanonicalToolName(name: string): name is CanonicalToolName {
  return CANONICAL_TOOL_SET.has(name);
}

/** Friendly transcript/settings label. Raw IDs belong in expanded diagnostics. */
export function toolLabel(name: string): string {
  const canonical = canonicalToolName(name);
  if (isCanonicalToolName(canonical)) return TOOL_PRESENTATION[canonical].label;
  return humanizeUnknownTool(name);
}

/** Short live-status phrase used while a concrete tool is executing. */
export function toolPresence(name: string): string {
  const canonical = canonicalToolName(name);
  if (isCanonicalToolName(canonical)) return TOOL_PRESENTATION[canonical].presence;
  return `running ${humanizeUnknownTool(name).toLocaleLowerCase()}…`;
}

export function isRoutineToolName(name: string): boolean {
  const canonical = canonicalToolName(name);
  return isCanonicalToolName(canonical) && ROUTINE_TOOL_SET.has(canonical);
}

export function isCommandToolName(name: string): boolean {
  return canonicalToolName(name) === "run_command";
}

export function toolNamesEquivalent(left: string, right: string): boolean {
  return canonicalToolName(left) === canonicalToolName(right);
}

function humanizeUnknownTool(name: string): string {
  const words = name
    .replace(/[-_:/.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return "Tool";
  return words[0].toLocaleUpperCase() + words.slice(1);
}
