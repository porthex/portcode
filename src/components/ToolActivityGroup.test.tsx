import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { isRoutineToolName, ToolActivityGroup, type ActivityCall } from "./ToolActivityGroup";

function tool(id: string, name: string, input: unknown): ActivityCall["tool"] {
  return { kind: "tool_use", id, name, input };
}

function result(toolUseId: string): NonNullable<ActivityCall["result"]> {
  return { kind: "tool_result", toolUseId, output: "done", isError: false };
}

describe("ToolActivityGroup", () => {
  it("keeps a legacy read compact until raw details are requested", () => {
    render(
      <ToolActivityGroup
        calls={[
          {
            tool: tool("read-1", "fs_read", { path: "src/App.tsx" }),
            result: result("read-1"),
          },
        ]}
      />,
    );

    const summary = screen.getByRole("button", {
      name: /Read file, src\/App\.tsx, completed, expand details/i,
    });
    expect(screen.queryByRole("region", { name: "Raw activity details" })).toBeNull();

    fireEvent.click(summary);
    const raw = screen.getByRole("region", { name: "Raw activity details" });
    expect(within(raw).getByText("1 operation")).toBeInTheDocument();
    const read = within(raw).getByRole("button", {
      name: /Read file src\/App\.tsx, completed, expand output/i,
    });
    fireEvent.click(read);
    expect(within(raw).getByText("fs_read")).toBeInTheDocument();
  });

  it("summarizes canonical and legacy exploration calls by operation kind", () => {
    render(
      <ToolActivityGroup
        calls={[
          {
            tool: tool("read-1", "read_file", { path: "src/App.tsx" }),
            result: result("read-1"),
          },
          {
            tool: tool("search-1", "grep", { pattern: "TODO" }),
            result: result("search-1"),
          },
          {
            tool: tool("list-1", "list_directory", { path: "src" }),
            result: result("list-1"),
          },
        ]}
      />,
    );

    const summary = screen.getByRole("button", {
      name: /Explored project, 1 file read · 1 search · 1 folder listed, completed, expand details/i,
    });
    fireEvent.click(summary);

    const raw = screen.getByRole("region", { name: "Raw activity details" });
    expect(within(raw).getByText("3 operations")).toBeInTheDocument();
    expect(
      within(raw).getByRole("button", { name: /Read file src\/App\.tsx/ }),
    ).toBeInTheDocument();
    expect(within(raw).getByRole("button", { name: /Search project TODO/ })).toBeInTheDocument();
    expect(within(raw).getByRole("button", { name: /Browse folder src/ })).toBeInTheDocument();
  });

  it("switches from present to settled wording when a pending search completes", () => {
    const search = tool("search-1", "search_text", { pattern: "TODO" });
    const { rerender } = render(<ToolActivityGroup calls={[{ tool: search }]} />);

    const running = screen.getByRole("button", {
      name: /Searching project, TODO, running, expand details/i,
    });
    expect(running.closest(".pc-toolcall")).toHaveClass("pc-toolcall--active");

    rerender(<ToolActivityGroup calls={[{ tool: search, result: result("search-1") }]} />);

    const completed = screen.getByRole("button", {
      name: /Searched project, TODO, completed, expand details/i,
    });
    expect(completed.closest(".pc-toolcall")).not.toHaveClass("pc-toolcall--active");
    expect(screen.queryByText("Searching project")).toBeNull();
  });

  it("recognizes both provider-neutral and historical routine tool IDs", () => {
    for (const name of [
      "read_file",
      "fs_read",
      "list_directory",
      "list",
      "find_files",
      "glob",
      "search_text",
      "grep",
    ]) {
      expect(isRoutineToolName(name)).toBe(true);
    }
    expect(isRoutineToolName("run_command")).toBe(false);
    expect(isRoutineToolName("shell")).toBe(false);
  });
});
