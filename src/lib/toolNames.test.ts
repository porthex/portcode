import { describe, expect, it } from "vitest";

import {
  CANONICAL_TOOL_NAMES,
  canonicalToolName,
  isCommandToolName,
  isRoutineToolName,
  toolLabel,
  toolNamesEquivalent,
  toolPresence,
} from "./toolNames";

describe("tool names", () => {
  it("publishes the complete provider-neutral catalogue", () => {
    expect(CANONICAL_TOOL_NAMES).toEqual([
      "read_file",
      "list_directory",
      "find_files",
      "search_text",
      "write_file",
      "edit_file",
      "run_command",
      "delegate_task",
    ]);
  });

  it.each([
    ["fs_read", "read_file"],
    ["list", "list_directory"],
    ["glob", "find_files"],
    ["grep", "search_text"],
    ["fs_write", "write_file"],
    ["fs_edit", "edit_file"],
    ["shell", "run_command"],
    ["task", "delegate_task"],
  ])("maps legacy %s to %s", (legacy, canonical) => {
    expect(canonicalToolName(legacy)).toBe(canonical);
    expect(toolNamesEquivalent(legacy, canonical)).toBe(true);
  });

  it("gives canonical and legacy IDs the same friendly presentation", () => {
    expect(toolLabel("read_file")).toBe("Read file");
    expect(toolLabel("fs_read")).toBe("Read file");
    expect(toolPresence("search_text")).toBe("searching the project…");
    expect(toolPresence("grep")).toBe("searching the project…");
  });

  it("recognizes routine and command tools through either vocabulary", () => {
    expect(isRoutineToolName("list_directory")).toBe(true);
    expect(isRoutineToolName("list")).toBe(true);
    expect(isRoutineToolName("write_file")).toBe(false);
    expect(isCommandToolName("run_command")).toBe(true);
    expect(isCommandToolName("shell")).toBe(true);
  });

  it("humanizes unknown integration IDs without changing their identity", () => {
    expect(canonicalToolName("acme__deploy-preview")).toBe("acme__deploy-preview");
    expect(toolLabel("acme__deploy-preview")).toBe("Acme deploy preview");
    expect(toolPresence("acme__deploy-preview")).toBe("running acme deploy preview…");
  });

  it.each([
    ["constructor", "Constructor"],
    ["toString", "ToString"],
    ["__proto__", "Proto"],
  ])("does not mistake inherited object key %s for a legacy alias", (name, label) => {
    expect(canonicalToolName(name)).toBe(name);
    expect(toolLabel(name)).toBe(label);
  });
});
