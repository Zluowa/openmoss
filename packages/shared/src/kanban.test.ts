import { describe, expect, it } from "vitest";
import {
  KANBAN_STUCK_HARD_MS,
  deriveKanbanAttention,
  deriveKanbanColumnV2,
  type KanbanThreadDerivationInput,
} from "./kanban";

const NOW = Date.parse("2026-03-09T12:00:00.000Z");
const FRESH_NOW = { now: NOW };
const STALE_ISO = new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString();

type Turn = NonNullable<KanbanThreadDerivationInput["latestTurn"]>;
type Session = NonNullable<KanbanThreadDerivationInput["session"]>;

const makeInput = (
  overrides: Partial<KanbanThreadDerivationInput> = {},
): KanbanThreadDerivationInput => ({ latestTurn: null, session: null, ...overrides });

const makeTurn = (overrides: Partial<Turn> = {}): Turn => ({
  state: "completed",
  startedAt: "2026-03-09T10:00:00.000Z",
  completedAt: "2026-03-09T10:05:00.000Z",
  ...overrides,
});

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  status: "idle",
  updatedAt: new Date(NOW).toISOString(),
  ...overrides,
});

const liveInput = (overrides: Partial<KanbanThreadDerivationInput> = {}) =>
  makeInput({
    latestTurn: makeTurn({ state: "running", completedAt: null }),
    session: makeSession({ status: "running" }),
    ...overrides,
  });

describe("deriveKanbanColumnV2", () => {
  it("puts never-ran threads in draft", () => {
    expect(deriveKanbanColumnV2(makeInput())).toBe("draft");
  });

  it("puts live turn work in progress", () => {
    expect(deriveKanbanColumnV2(liveInput())).toBe("inProgress");
  });

  it("hoists actionable pending approvals to awaitingYou", () => {
    expect(deriveKanbanColumnV2(makeInput({ hasPendingApprovals: true }), FRESH_NOW)).toBe(
      "awaitingYou",
    );
  });

  it("puts settled threads in done", () => {
    expect(deriveKanbanColumnV2(makeInput({ latestTurn: makeTurn() }))).toBe("done");
  });
});

describe("first-send status table", () => {
  const CREATED_AT = "2026-03-09T11:00:00.000Z";
  const SENT_AT = "2026-03-09T11:00:05.000Z";
  const COPIED_AT = "2026-03-09T09:00:00.000Z";
  const sentHere = (
    session: Session | null,
    overrides: Partial<KanbanThreadDerivationInput> = {},
  ) => makeInput({ createdAt: CREATED_AT, latestUserMessageAt: SENT_AT, session, ...overrides });

  it.each<[string, KanbanThreadDerivationInput, string, string[]]>([
    ["nothing sent", makeInput({ createdAt: CREATED_AT }), "draft", []],
    ["sent, provider starting", sentHere(makeSession({ status: "starting" })), "inProgress", []],
    [
      "sent and running",
      liveInput({ createdAt: CREATED_AT, latestUserMessageAt: SENT_AT }),
      "inProgress",
      [],
    ],
    [
      "sent, start failed with the error still on the session",
      sentHere(makeSession({ status: "error", lastError: "Provider turn start timed out" })),
      "awaitingYou",
      ["failed"],
    ],
    [
      "sent, rejected before acceptance, error since cleared",
      sentHere(makeSession({ status: "stopped", lastError: null })),
      "awaitingYou",
      ["failed"],
    ],
    [
      "sent, stopped before the turn began",
      sentHere(makeSession({ status: "interrupted" })),
      "awaitingYou",
      ["failed"],
    ],
    [
      "sent, provider up but the turn not accepted yet (not failed)",
      sentHere(makeSession({ status: "ready" })),
      "draft",
      [],
    ],
    [
      "fork with a copied transcript, nothing sent in it",
      makeInput({ createdAt: CREATED_AT, latestUserMessageAt: COPIED_AT }),
      "draft",
      [],
    ],
    [
      "import with an older transcript and a stopped session",
      sentHere(makeSession({ status: "stopped" }), { latestUserMessageAt: COPIED_AT }),
      "draft",
      [],
    ],
    [
      "turn failed after the provider accepted it",
      sentHere(makeSession({ status: "error" }), {
        latestTurn: makeTurn({ state: "error" }),
      }),
      "awaitingYou",
      ["failed"],
    ],
    [
      "turn stopped by the person",
      sentHere(makeSession({ status: "interrupted" }), {
        latestTurn: makeTurn({ state: "interrupted" }),
      }),
      "done",
      [],
    ],
    [
      "turn finished",
      sentHere(makeSession({ status: "ready" }), { latestTurn: makeTurn() }),
      "done",
      [],
    ],
  ])("%s", (_label, input, column, attention) => {
    expect(deriveKanbanColumnV2(input, FRESH_NOW)).toBe(column);
    expect(deriveKanbanAttention(input, FRESH_NOW)).toEqual(attention);
  });
});

describe("deriveKanbanAttention", () => {
  it("maps pending approval to its pill", () => {
    expect(deriveKanbanAttention(makeInput({ hasPendingApprovals: true }), FRESH_NOW)).toEqual([
      "awaiting-approval",
    ]);
  });
});

describe("stuck timing", () => {
  it("trips stuck past the hard threshold; fresh heartbeats stay in progress", () => {
    const stale = liveInput({
      session: makeSession({ status: "running", updatedAt: STALE_ISO }),
    });
    expect(deriveKanbanColumnV2(stale, FRESH_NOW)).toBe("awaitingYou");
    expect(deriveKanbanAttention(stale, FRESH_NOW)).toEqual(["stuck"]);
    expect(deriveKanbanColumnV2(liveInput(), FRESH_NOW)).toBe("inProgress");
  });
});
