import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Session } from "../types";
import { SessionActionDialog } from "./SessionActionDialog";

const session: Session = {
  id: "s1",
  title: "Sidebar redesign",
  workspace: "C:/work/portcode",
  branch: "feature/sidebar",
  model: "claude-opus-4-8",
  createdAt: 1,
  updatedAt: 2,
};

describe("SessionActionDialog", () => {
  it("describes dirty branch work, focuses Cancel, and closes on Escape", () => {
    const onCancel = vi.fn();
    render(
      <SessionActionDialog
        state={{
          kind: "archive",
          session,
          warning: {
            workspace: session.workspace!,
            branch: session.branch!,
            detachedHead: null,
            changedFiles: 3,
            untrackedFiles: 1,
            additions: 20,
            deletions: 4,
          },
        }}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Uncommitted work on this branch" });
    expect(dialog).toHaveTextContent("feature/sidebar");
    expect(dialog).toHaveTextContent("3 changed");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("traps focus between delete actions and invokes permanent confirmation", () => {
    const onConfirm = vi.fn();
    render(
      <SessionActionDialog
        state={{ kind: "delete", session }}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Delete archived session?" });
    const keep = within(dialog).getByRole("button", { name: "Keep session" });
    const remove = within(dialog).getByRole("button", { name: "Delete forever" });

    remove.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(keep).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(remove).toHaveFocus();

    fireEvent.click(remove);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps a busy error dialog open and supports backdrop cancellation when idle", () => {
    const busyCancel = vi.fn();
    const first = render(
      <SessionActionDialog
        state={{ kind: "archiveError", session, message: "Git status timed out" }}
        busy
        onCancel={busyCancel}
        onConfirm={vi.fn()}
      />,
    );

    const busyDialog = screen.getByRole("dialog", { name: "Couldn’t check the worktree" });
    expect(busyDialog).toHaveTextContent("Git status timed out");
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    fireEvent.keyDown(busyDialog, { key: "Tab" });
    fireEvent.keyDown(busyDialog, { key: "Escape" });
    fireEvent.mouseDown(busyDialog.parentElement!);
    expect(busyCancel).not.toHaveBeenCalled();
    first.unmount();

    const idleCancel = vi.fn();
    render(
      <SessionActionDialog
        state={{ kind: "archiveError", session, message: "Git status failed" }}
        onCancel={idleCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(idleCancel).toHaveBeenCalledTimes(1);
  });
});
