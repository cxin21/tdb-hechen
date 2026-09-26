/**
 * V12-PROVIDER Phase 4 — concurrent same-first-message conversation guard.
 *
 * Header-less dsh clients key sessions by first-user-message hash, so two
 * conversations starting with the SAME text share one state machine. While
 * one is mid-form (pending_*), a fresh turn from the other must NOT burn
 * attemptCount (it would poison the shared machine to a sticky abandon).
 * A form-answer turn always carries a tool message (never fresh), so
 * isFreshConversation cleanly separates "new duplicate conversation" from
 * "the same conversation answering the form".
 */
import { describe, it, expect } from "vitest";
import { mapPendingStatusToStage } from "../codebuddy/init.js";

describe("mapPendingStatusToStage", () => {
  it("maps every pending status to its dsh form stage", () => {
    expect(mapPendingStatusToStage("pending_asset_confirm")).toBe("asset_confirm");
    expect(mapPendingStatusToStage("pending_team_select")).toBe("team");
    expect(mapPendingStatusToStage("pending_agent_select")).toBe("agent_select");
    expect(mapPendingStatusToStage("pending_task_select")).toBe("task_select");
    expect(mapPendingStatusToStage("pending_agent_task")).toBe("agent_task");
  });

  it("returns null for terminal/non-pending statuses", () => {
    expect(mapPendingStatusToStage("initialized")).toBeNull();
    expect(mapPendingStatusToStage("uninitialized")).toBeNull();
    expect(mapPendingStatusToStage(undefined)).toBeNull();
  });
});
