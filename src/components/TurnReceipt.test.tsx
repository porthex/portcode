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
    expect(liveStrip).toHaveAttribute("aria-label", "Working, Turn is in progress");

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("5s")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Turn in progress");
    expect(liveStrip).toHaveAttribute("aria-label", "Working, Turn is in progress");
  });

  it("marks the response complete, freezes its timer, and retains stable strip geometry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(12_000);
    const { rerender, container } = render(<TurnReceipt active startedAt={2_000} waiting />);

    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    const strip = container.querySelector(".pc-turn-receipt__strip");
    expect(strip).toBeInTheDocument();

    rerender(
      <TurnReceipt
        startedAt={2_000}
        finalizing
        receipt={receipt({
          startedAt: 2_000,
          completedAt: 9_000,
          durationMs: 10_000,
          agentDurationMs: 7_000,
          changeCertainty: "unavailable",
          changeState: "unknown",
        })}
      />,
    );
    expect(screen.getByText("Response complete · Checking file changes…")).toBeInTheDocument();
    expect(screen.getByText("7s")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Response complete. Checking file changes.",
    );
    expect(container.querySelector(".pc-turn-receipt__strip")).toBe(strip);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("7s")).toBeInTheDocument();
  });

  it("announces completion once when Git finalization is the terminal boundary", () => {
    const provisional = receipt({
      durationMs: 2_000,
      agentDurationMs: 2_000,
      changeCertainty: "unavailable",
      changeState: "unknown",
    });
    const { rerender } = render(<TurnReceipt active startedAt={1_000} />);

    rerender(<TurnReceipt finalizing startedAt={1_000} receipt={provisional} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Response complete. Checking file changes.",
    );

    rerender(
      <TurnReceipt
        receipt={receipt({
          durationMs: 7_000,
          agentDurationMs: 2_000,
          changeState: "none",
        })}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("2s")).toBeInTheDocument();
  });

  it.each([
    ["completed", "Done in", "Done in 1m 2s, 1 minute 2 seconds elapsed, Turn completed"],
    ["cancelled", "Stopped after", "Stopped after 1m 2s, 1 minute 2 seconds elapsed, Turn stopped"],
    ["error", "Failed after", "Failed after 1m 2s, 1 minute 2 seconds elapsed, Turn failed"],
    [
      "interrupted",
      "Interrupted after",
      "Interrupted after 1m 2s, 1 minute 2 seconds elapsed, Turn interrupted",
    ],
  ] as const)(
    "renders accessible %s terminal metadata without a live region",
    (status, visible, label) => {
      render(<TurnReceipt receipt={receipt({ status, durationMs: 62_000 })} />);
      expect(screen.getByText(visible).closest(".pc-turn-receipt__strip")).toHaveAttribute(
        "aria-label",
        label,
      );
      expect(screen.getByText("1m 2s")).toHaveAttribute("aria-hidden", "true");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    },
  );

  it("does not replay terminal announcements when settled history is mounted", () => {
    render(
      <>
        <TurnReceipt receipt={receipt({ turnId: "turn-1" })} />
        <TurnReceipt receipt={receipt({ turnId: "turn-2", status: "error" })} />
      </>,
    );

    expect(screen.queryAllByRole("status")).toHaveLength(0);
    expect(screen.getAllByLabelText(/Turn (completed|failed)/)).toHaveLength(2);
  });

  it.each([
    ["completed", "Turn completed"],
    ["cancelled", "Turn stopped"],
    ["error", "Turn failed"],
    ["interrupted", "Turn interrupted"],
  ] as const)(
    "announces a %s transition only for the same mounted live receipt",
    (status, announcement) => {
      const terminal = receipt({ status });
      const { rerender } = render(<TurnReceipt active startedAt={1_000} />);
      expect(screen.getByRole("status")).toHaveTextContent("Turn in progress");

      rerender(<TurnReceipt receipt={terminal} />);
      expect(screen.getByRole("status")).toHaveTextContent(announcement);

      rerender(<TurnReceipt receipt={terminal} />);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    },
  );

  it("gives hour-long terminal durations a speakable accessible name", () => {
    render(<TurnReceipt receipt={receipt({ durationMs: 3_660_000 })} />);
    expect(screen.getByText("Done in").closest(".pc-turn-receipt__strip")).toHaveAttribute(
      "aria-label",
      "Done in 1h 1m, 1 hour 1 minute elapsed, Turn completed",
    );
  });

  it("prefers frozen response time over legacy end-to-end receipt time", () => {
    render(<TurnReceipt receipt={receipt({ durationMs: 90_000, agentDurationMs: 5_000 })} />);
    expect(screen.getByText("5s")).toBeInTheDocument();
    expect(screen.queryByText("1m 30s")).not.toBeInTheDocument();
  });

  it("marks a settled success as quiet metadata while keeping exceptional states distinct", () => {
    const { rerender, container } = render(<TurnReceipt receipt={receipt()} />);
    const settled = container.querySelector(".pc-turn-receipt");
    expect(settled).toHaveClass("pc-turn-receipt--completed");
    expect(settled).toHaveAttribute("data-has-activity", "false");
    expect(screen.queryByText("Worked for")).not.toBeInTheDocument();

    rerender(<TurnReceipt receipt={receipt({ status: "error" })} />);
    expect(container.querySelector(".pc-turn-receipt")).toHaveClass("pc-turn-receipt--error");
    expect(screen.getByText("Failed after")).toBeInTheDocument();
  });

  it("renders durable, bounded failure diagnostics after a reload", () => {
    render(
      <TurnReceipt
        receipt={receipt({
          status: "error",
          stopReason: undefined,
          failure: {
            code: "provider_http",
            message: "OpenAI response was rejected (HTTP 400). Please retry.",
            provider: "openai",
            model: "gpt-5.6-sol",
            httpStatus: 400,
            transcriptMessages: 161,
            transcriptBytes: 1_709_912,
          },
        })}
      />,
    );

    expect(
      screen.getByText("OpenAI response was rejected (HTTP 400). Please retry."),
    ).toBeVisible();
    expect(screen.getByLabelText("Failure diagnostics")).toHaveTextContent(
      "Diagnostic: provider http · openai / gpt-5.6-sol · HTTP 400 · 161 transcript messages · 1.63 MiB transcript",
    );
  });

  it.each([
    [512, "512 B"],
    [128 * 1024, "128.0 KiB"],
  ])(
    "formats %s-byte transcript diagnostics without hiding the failure",
    (transcriptBytes, copy) => {
      render(
        <TurnReceipt
          receipt={receipt({
            status: "error",
            failure: {
              code: "agent_error",
              message: "The turn failed safely.",
              transcriptBytes,
            },
          })}
        />,
      );

      expect(screen.getByLabelText("Failure diagnostics")).toHaveTextContent(`${copy} transcript`);
    },
  );

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

  it("keeps a duration-less completed receipt grammatical", () => {
    render(<TurnReceipt receipt={receipt({ durationMs: undefined })} />);
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.queryByText("Done in")).not.toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("only exposes a disclosure for observable activity and preserves manual state", () => {
    const activity = <button type="button">Inspect observable call</button>;
    const { rerender } = render(
      <TurnReceipt active startedAt={1_000} activity={activity} activityCount={1} />,
    );
    const toggle = screen.getByRole("button", { name: /expand work activity/i });
    expect(toggle.closest(".pc-turn-receipt")).toHaveAttribute("data-has-activity", "true");
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
    const settledToggle = screen.getByRole("button", { name: /collapse work activity/i });
    expect(settledToggle).toHaveAttribute("aria-expanded", "true");
    expect(settledToggle).toHaveAccessibleName(
      "Done in 1m 2s, 1 minute 2 seconds elapsed, Turn completed, collapse work activity",
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
    ["exact", {}],
    ["observed", {}],
    ["ambiguous", {}],
    ["unavailable", {}],
    ["ambiguous", { status: "interrupted" as const }],
    ["exact", { status: "cancelled" as const }],
    ["exact", { status: "error" as const }],
    ["exact", { backgroundTasksRunning: true }],
    ["exact", { filesTruncated: true }],
  ] as const)("does not invent a Git summary for an empty %s receipt", (certainty, extra) => {
    const { container } = render(
      <TurnChangesCard receipt={receipt({ changeCertainty: certainty, ...extra })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

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

  it("uses listed files as evidence even when a stale count says zero", () => {
    render(
      <TurnChangesCard receipt={receipt({ changedFiles: [changedFile()], changedFileCount: 0 })} />,
    );
    expect(screen.getByText("Edited 1 file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review 1 changed file" })).toBeInTheDocument();
  });

  it.each(["none", "not_applicable"] as const)(
    "suppresses contradictory positive evidence when change state is %s",
    (changeState) => {
      const { container } = render(
        <TurnChangesCard
          receipt={receipt({
            changeState,
            changedFiles: [changedFile()],
            changedFileCount: 1,
            additions: 4,
            deletions: 1,
          })}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    },
  );

  it("does not show zero line totals or offer Review when Git capture is unavailable", () => {
    render(
      <TurnChangesCard
        receipt={receipt({
          changedFiles: [changedFile({ additions: 0, deletions: 0 })],
          changedFileCount: 1,
          changeCertainty: "unavailable",
        })}
      />,
    );

    expect(screen.getByText("Git changes could not be verified")).toBeInTheDocument();
    expect(screen.getByText("Git attribution unavailable")).toBeInTheDocument();
    expect(screen.queryByLabelText(/additions/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review/i })).not.toBeInTheDocument();
  });

  it("does not present confirmed writes as a net delta when Git capture is incomplete", () => {
    render(
      <TurnChangesCard
        receipt={receipt({
          changedFileCount: 2,
          filesTruncated: true,
          changeCertainty: "unavailable",
        })}
      />,
    );

    expect(screen.getByText("Git changes could not be verified")).toBeInTheDocument();
    expect(screen.queryByText(/At least 2 files changed/i)).not.toBeInTheDocument();
    expect(screen.getByText("File list truncated")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review/i })).not.toBeInTheDocument();
  });

  it("surfaces line-delta evidence even if the bounded file list is empty", () => {
    render(<TurnChangesCard receipt={receipt({ additions: 3, deletions: 1 })} />);
    expect(screen.getByText("File changes detected")).toBeInTheDocument();
    expect(screen.getByLabelText("3 additions, 1 deletions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review/i })).not.toBeInTheDocument();
  });

  it.each([
    [{ additions: 3, deletions: 0 }, "3 additions", "+3", "−0"],
    [{ additions: 0, deletions: 2 }, "2 deletions", "−2", "+0"],
  ] as const)(
    "renders only a nonzero one-sided global total: %s",
    (totals, accessible, visible, absent) => {
      render(<TurnChangesCard receipt={receipt(totals)} />);
      expect(screen.getByLabelText(accessible)).toBeInTheDocument();
      expect(screen.getByText(visible)).toBeInTheDocument();
      expect(screen.queryByText(absent)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/0 (additions|deletions)/)).not.toBeInTheDocument();
    },
  );

  it.each([
    [{ additions: 5, deletions: 0 }, "5 additions", "+5", "−0"],
    [{ additions: 0, deletions: 4 }, "4 deletions", "−4", "+0"],
  ] as const)(
    "renders only a nonzero one-sided per-file total: %s",
    (totals, accessible, visible, absent) => {
      render(
        <TurnChangesCard
          receipt={receipt({
            changedFiles: [changedFile(totals)],
            changedFileCount: 1,
            ...totals,
          })}
        />,
      );
      const row = screen.getByRole("listitem");
      expect(within(row).getByLabelText(accessible)).toBeInTheDocument();
      expect(within(row).getByText(visible)).toBeInTheDocument();
      expect(within(row).queryByText(absent)).not.toBeInTheDocument();
      expect(within(row).queryByLabelText(/0 (additions|deletions)/)).not.toBeInTheDocument();
    },
  );

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
    expect(screen.getByText("At least 8 files changed")).toBeInTheDocument();
    expect(screen.getByText("File list truncated")).toBeInTheDocument();
    expect(screen.getByText(/Background tasks are still running/)).toBeInTheDocument();
    expect(screen.getByText(/Changes may remain from an incomplete turn/)).toBeInTheDocument();
  });

  it("does not offer Review for a positive count without a listed manifest", () => {
    render(<TurnChangesCard receipt={receipt({ changedFileCount: 2 })} />);
    expect(screen.getByText("Edited 2 files")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review/i })).not.toBeInTheDocument();
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
