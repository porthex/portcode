import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TurnChangedFile, TurnReceipt as TurnReceiptData } from "../types";
import { TurnChangesCard, TurnReceipt } from "./TurnReceipt";

const changedFile = (over: Partial<TurnChangedFile> = {}): TurnChangedFile => ({
  path: "src/app.ts",
  status: "modified",
  additions: 4,
  deletions: 1,
  binary: false,
  certainty: "exact",
  ...over,
});

const receipt = (over: Partial<TurnReceiptData> = {}): TurnReceiptData => ({
  turnId: "turn-1",
  status: "completed",
  stopReason: "end_turn",
  startedAt: 1_000,
  completedAt: 63_000,
  durationMs: 62_000,
  changedFiles: [],
  changedFileCount: 0,
  additions: 0,
  deletions: 0,
  filesTruncated: false,
  changeCertainty: "exact",
  backgroundTasksRunning: false,
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TurnReceipt strip", () => {
  it("renders nothing without live or durable turn facts", () => {
    const { container } = render(<TurnReceipt />);
    expect(container).toBeEmptyDOMElement();
  });

  it("moves from Starting to a tabular live timer without announcing each tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { rerender } = render(<TurnReceipt active startedAt={null} />);

    expect(screen.getByText("Starting")).toBeInTheDocument();
    expect(screen.getByText("…")).toHaveClass("pc-turn-receipt__time");
    expect(screen.getByRole("status")).toHaveTextContent("Turn started");

    rerender(<TurnReceipt active startedAt={10_000} />);
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("<1s")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Turn in progress");
    expect(screen.getByRole("status")).not.toHaveTextContent(/second|\d+s/i);
    const liveStrip = screen.getByText("Working").closest(".pc-turn-receipt__strip");
    expect(liveStrip).toHaveAttribute("aria-label", "Turn is in progress");

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("5s")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Turn in progress");
    expect(liveStrip).toHaveAttribute("aria-label", "Turn is in progress");
  });

  it("uses Waiting and Finalizing lifecycle copy while retaining stable strip geometry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(12_000);
    const { rerender, container } = render(<TurnReceipt active startedAt={2_000} waiting />);

    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    const strip = container.querySelector(".pc-turn-receipt__strip");
    expect(strip).toBeInTheDocument();

    rerender(<TurnReceipt startedAt={2_000} finalizing />);
    expect(screen.getByText("Finalizing")).toBeInTheDocument();
    expect(container.querySelector(".pc-turn-receipt__strip")).toBe(strip);
  });

  it.each([
    ["completed", "Worked for", "Turn completed"],
    ["cancelled", "Stopped after", "Turn stopped"],
    ["error", "Failed after", "Turn failed"],
    ["interrupted", "Interrupted after", "Turn interrupted"],
  ] as const)("renders %s terminal copy", (status, visible, announced) => {
    render(<TurnReceipt receipt={receipt({ status, durationMs: 62_000 })} />);
    expect(screen.getByText(visible)).toBeInTheDocument();
    expect(screen.getByText("1m 2s")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status")).toHaveTextContent(announced);
  });

  it("does not invent a duration for a turn recovered after a process interruption", () => {
    render(
      <TurnReceipt
        receipt={receipt({
          status: "interrupted",
          stopReason: "process_interrupted",
          durationMs: undefined,
        })}
      />,
    );

    expect(screen.getByText("Interrupted")).toBeInTheDocument();
    expect(screen.getByText("—")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText("Interrupted after")).not.toBeInTheDocument();
  });

  it("only exposes a disclosure for observable activity and preserves manual state", () => {
    const activity = <button type="button">Inspect observable call</button>;
    const { rerender } = render(
      <TurnReceipt active startedAt={1_000} activity={activity} activityCount={1} />,
    );
    const toggle = screen.getByRole("button", { name: /expand work activity/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const stableDetails = screen.getByText("Inspect observable call").closest("[data-open]");
    expect(stableDetails).toHaveAttribute("data-open", "false");
    expect(stableDetails).toHaveAttribute("aria-hidden", "true");
    expect(stableDetails).toHaveAttribute("inert");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Inspect observable call")).toBeInTheDocument();
    expect(stableDetails).toHaveAttribute("data-open", "true");
    expect(stableDetails).not.toHaveAttribute("inert");

    // Terminal arrival must not surprise-collapse a disclosure the person opened.
    rerender(<TurnReceipt receipt={receipt()} activity={activity} activityCount={1} />);
    expect(screen.getByRole("button", { name: /collapse work activity/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Inspect observable call")).toBeInTheDocument();
  });

  it("returns focus to the disclosure toggle when Escape collapses activity", () => {
    render(
      <TurnReceipt
        receipt={receipt()}
        activity={<button type="button">Focused activity</button>}
        activityCount={1}
      />,
    );
    const toggle = screen.getByRole("button", { name: /expand work activity/i });
    fireEvent.click(toggle);
    const activity = screen.getByRole("button", { name: "Focused activity" });
    activity.focus();
    fireEvent.keyDown(activity, { key: "Escape" });

    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Focused activity").closest("[data-open]")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});

describe("TurnChangesCard", () => {
  it("does not render a clean exact receipt", () => {
    const { container } = render(<TurnChangesCard receipt={receipt()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the first three files, totals, special file states, and no Undo", () => {
    render(
      <TurnChangesCard
        receipt={receipt({
          changedFiles: [
            changedFile({ path: "src/a.ts", status: "modified" }),
            changedFile({
              path: "src/new.ts",
              oldPath: "src/old.ts",
              status: "renamed",
              certainty: "observed",
            }),
            changedFile({
              path: "assets/hero.png",
              status: "added",
              additions: undefined,
              deletions: undefined,
              binary: true,
            }),
            changedFile({ path: "src/deleted.ts", status: "deleted" }),
          ],
          changedFileCount: 4,
          additions: 12,
          deletions: 5,
        })}
      />,
    );

    const card = screen.getByRole("region", {
      name: /Edited 4 files, 12 additions, 5 deletions/i,
    });
    expect(within(card).getByText("src/a.ts")).toBeInTheDocument();
    expect(within(card).getByText("src/old.ts → src/new.ts")).toBeInTheDocument();
    expect(within(card).getByText("observed")).toBeInTheDocument();
    expect(within(card).getByText("assets/hero.png")).toBeInTheDocument();
    expect(within(card).getByText("binary")).toBeInTheDocument();
    expect(within(card).queryByText("src/deleted.ts")).not.toBeInTheDocument();
    expect(within(card).getByText("+12")).toHaveAttribute("aria-hidden", "true");
    expect(within(card).getByText("−5")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText(/undo/i)).not.toBeInTheDocument();
  });

  it("bounds Show more to twenty file rows and states what remains unlisted", () => {
    const files = Array.from({ length: 25 }, (_, index) =>
      changedFile({ path: `src/file-${index}.ts` }),
    );
    render(
      <TurnChangesCard
        receipt={receipt({ changedFiles: files, changedFileCount: 30, additions: 30 })}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Show 17 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(20);
    expect(screen.getByText("10 additional files not listed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it.each([
    ["ambiguous", "Changes may remain", "Attribution is ambiguous"],
    ["unavailable", "Changes unavailable", "Git attribution unavailable"],
  ] as const)(
    "renders the %s provenance state without guessing files",
    (certainty, title, note) => {
      render(<TurnChangesCard receipt={receipt({ changeCertainty: certainty })} />);
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.getByText(note)).toBeInTheDocument();
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /review/i })).not.toBeInTheDocument();
    },
  );

  it.each([
    ["exact", "Edited 1 file"],
    ["observed", "1 file changed during this turn"],
    ["ambiguous", "1 file changed while this turn ran"],
  ] as const)("uses ownership-safe copy for %s nonzero changes", (certainty, title) => {
    render(
      <TurnChangesCard
        receipt={receipt({
          changedFiles: [changedFile({ certainty })],
          changedFileCount: 1,
          changeCertainty: certainty,
        })}
      />,
    );
    expect(screen.getByText(title)).toBeInTheDocument();
  });

  it("surfaces truncation, incomplete-turn provenance, and running background work", () => {
    render(
      <TurnChangesCard
        receipt={receipt({
          status: "error",
          changedFiles: [changedFile()],
          changedFileCount: 8,
          filesTruncated: true,
          backgroundTasksRunning: true,
        })}
      />,
    );
    expect(screen.getByText("File list truncated")).toBeInTheDocument();
    expect(screen.getByText(/Background tasks are still running/)).toBeInTheDocument();
    expect(screen.getByText(/Changes may remain from an incomplete turn/)).toBeInTheDocument();
  });

  it("calls the explicit Review seam and falls back to a provider-neutral data event", () => {
    const terminal = receipt({
      changedFiles: [changedFile()],
      changedFileCount: 1,
    });
    const onReview = vi.fn();
    const { rerender } = render(<TurnChangesCard receipt={terminal} onReview={onReview} />);
    fireEvent.click(screen.getByRole("button", { name: "Review 1 changed file" }));
    expect(onReview).toHaveBeenCalledWith(terminal);

    const observed = vi.fn();
    window.addEventListener("portcode:review-turn", observed);
    rerender(<TurnChangesCard receipt={terminal} />);
    fireEvent.click(screen.getByRole("button", { name: "Review 1 changed file" }));
    expect(observed).toHaveBeenCalledTimes(1);
    const event = observed.mock.calls[0][0] as CustomEvent<{ turnId: string }>;
    expect(event.detail).toEqual({ turnId: "turn-1" });
    window.removeEventListener("portcode:review-turn", observed);
  });
});
