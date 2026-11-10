import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "./branding";
import {
  acceptFeedbackImages,
  buildFeedbackSubmission,
  FEEDBACK_IMAGE_LIMITS,
  FEEDBACK_IMAGE_UNREADABLE_MESSAGE,
  FEEDBACK_NETWORK_MESSAGE,
  FEEDBACK_RATE_LIMITED_MESSAGE,
  FEEDBACK_REJECTED_MESSAGE,
  FEEDBACK_TOO_LARGE_MESSAGE,
  FEEDBACK_UNAVAILABLE_MESSAGE,
  feedbackImageType,
  formatFeedbackSummary,
  prepareFeedbackAttachments,
  submitFeedback,
  type FeedbackDiagnostics,
  type FeedbackThreadContext,
} from "./feedback";

const CONTEXT: FeedbackThreadContext = {
  provider: "codex",
  model: "gpt-5.6-sol",
  projectKind: "project",
  environmentMode: "worktree",
  runtimeMode: "full-access",
  interactionMode: "default",
  sessionStatus: "running",
  latestTurnState: "error",
  messageCount: 12,
  activityCount: 8,
  hasPendingApproval: false,
  hasPendingUserInput: true,
  hasThreadError: true,
};

const DIAGNOSTICS: FeedbackDiagnostics = {
  ...CONTEXT,
  appVersion: "0.5.1",
  submittedAt: "2026-07-15T18:00:00.000Z",
  userAgent: "Moss test agent",
  platform: "MacIntel",
  language: "en-US",
  viewport: "1440x900",
};

describe("formatFeedbackSummary", () => {
  it("falls back to a neutral opening and omits fields the session never set", () => {
    const summary = formatFeedbackSummary({
      category: null,
      diagnostics: {
        ...DIAGNOSTICS,
        projectKind: null,
        environmentMode: null,
        sessionStatus: null,
        latestTurnState: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        hasThreadError: false,
      },
    });

    expect(summary).toContain("I have some feedback in Moss 0.5.1, using codex with gpt-5.6-sol.");
    expect(summary).toContain("Report type: Unspecified");
    expect(summary).toContain("At submission: nothing pending.");
    expect(summary).not.toContain("Screenshot:");
    expect(summary).not.toContain("Project kind:");
    expect(summary).not.toContain("Session status:");
  });

  it("describes feedback sent outside an active chat without inventing provider context", () => {
    const summary = formatFeedbackSummary({
      category: "other",
      diagnostics: {
        ...DIAGNOSTICS,
        provider: null,
        model: null,
        projectKind: null,
        environmentMode: null,
        runtimeMode: null,
        interactionMode: null,
        sessionStatus: null,
        latestTurnState: null,
      },
    });

    expect(summary).toContain("I have some feedback in Moss 0.5.1 outside an active chat.");
    expect(summary).not.toContain("Provider:");
    expect(summary).not.toContain("Model:");
  });
});

describe("buildFeedbackSubmission", () => {
  it("adds useful runtime diagnostics without adding project or conversation content", () => {
    const submission = buildFeedbackSubmission({
      category: "bug",
      details: "  The composer stopped responding.  ",
      context: CONTEXT,
      now: new Date("2026-07-15T18:00:00.000Z"),
      userAgent: "Moss test agent",
      platform: "MacIntel",
      language: "en-US",
      viewport: { width: 1_440, height: 900 },
    });

    expect(submission).toMatchObject({
      category: "bug",
      details: "The composer stopped responding.",
      diagnostics: {
        provider: "codex",
        model: "gpt-5.6-sol",
        submittedAt: "2026-07-15T18:00:00.000Z",
        userAgent: "Moss test agent",
        platform: "MacIntel",
        language: "en-US",
        viewport: "1440x900",
      },
    });
    expect(submission.summary).toBe(
      [
        `I ran into a bug in Moss ${APP_VERSION}, using codex with gpt-5.6-sol.`,
        "",
        "Report type: Bug",
        `App version: ${APP_VERSION}`,
        "Provider: codex",
        "Model: gpt-5.6-sol",
        "Project kind: project",
        "Environment mode: worktree",
        "Runtime mode: full-access",
        "Interaction mode: default",
        "Session status: running",
        "Latest turn state: error",
        "Thread size: 12 messages, 8 activities",
        "At submission: the thread was in an error state, the agent was waiting for input.",
        "Platform: MacIntel, viewport 1440x900",
        "Language: en-US",
        "User agent: Moss test agent",
        "Submitted at: 2026-07-15T18:00:00.000Z",
      ].join("\n"),
    );
    expect(submission.summary).not.toContain("The composer stopped responding.");
    expect(submission).not.toHaveProperty("screenshot");
    expect(submission.diagnostics).not.toHaveProperty("projectPath");
    expect(submission.diagnostics).not.toHaveProperty("threadTitle");
    expect(submission.diagnostics).not.toHaveProperty("messages");
    expect(submission.diagnostics).not.toHaveProperty("logs");
  });

  it("carries an ID for retries and the prepared screenshots", () => {
    const attachments = [
      { name: "screen.png", mimeType: "image/webp" as const, dataBase64: "UklGRg==" },
    ];
    const submission = buildFeedbackSubmission({
      category: null,
      details: "x",
      context: CONTEXT,
      attachments,
      viewport: { width: 1, height: 1 },
      userAgent: "a",
      platform: "b",
      language: "c",
    });
    expect(submission.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(submission.attachments).toEqual(attachments);
    expect(
      buildFeedbackSubmission({
        category: null,
        details: "x",
        context: CONTEXT,
        attachments: [],
        viewport: { width: 1, height: 1 },
        userAgent: "a",
        platform: "b",
        language: "c",
      }),
    ).not.toHaveProperty("attachments");
  });
});

const file = (name: string, type: string, size = 10) => ({ name, type, size });

describe("feedback screenshots", () => {
  it("takes PNG, JPEG and WebP, also when the source leaves the type empty", () => {
    expect(feedbackImageType(file("a.png", "image/png"))).toBe("image/png");
    expect(feedbackImageType(file("a.jpg", "image/jpeg"))).toBe("image/jpeg");
    expect(feedbackImageType(file("a.webp", "image/webp"))).toBe("image/webp");
    expect(feedbackImageType(file("Shot.JPEG", ""))).toBe("image/jpeg");
    expect(feedbackImageType(file("a.gif", "image/gif"))).toBeNull();
    expect(feedbackImageType(file("a.png", "application/pdf"))).toBeNull();
    expect(feedbackImageType(file("notes.txt", ""))).toBeNull();
  });

  it("refuses other types, files over 5 MB and anything past five images", () => {
    const { accepted, rejected } = acceptFeedbackImages(
      [
        file("1.png", "image/png"),
        file("big.png", "image/png", FEEDBACK_IMAGE_LIMITS.maxBytes + 1),
        file("edge.png", "image/png", FEEDBACK_IMAGE_LIMITS.maxBytes),
        file("doc.pdf", "application/pdf"),
        file("2.webp", "image/webp"),
        file("3.jpg", "image/jpeg"),
      ],
      2,
    );
    expect(accepted.map((entry) => entry.name)).toEqual(["1.png", "edge.png", "2.webp"]);
    expect(rejected).toEqual(["size", "type", "count"]);
    expect(acceptFeedbackImages([file("a.png", "image/png")], 5)).toEqual({
      accepted: [],
      rejected: ["count"],
    });
  });

  it("re-encodes each screenshot for sending and fails plainly when one cannot be read", async () => {
    const images = [new File(["a"], "a.png", { type: "image/png" })];
    expect(
      await prepareFeedbackAttachments(images, async () => new Uint8Array([82, 73, 70, 70])),
    ).toEqual([{ name: "a.png", mimeType: "image/webp", dataBase64: "UklGRg==" }]);
    await expect(prepareFeedbackAttachments(images, async () => null)).rejects.toThrow(
      FEEDBACK_IMAGE_UNREADABLE_MESSAGE,
    );
    await expect(
      prepareFeedbackAttachments(images, async () => {
        throw new Error("decode");
      }),
    ).rejects.toThrow(FEEDBACK_IMAGE_UNREADABLE_MESSAGE);
  });
});

describe("submitFeedback", () => {
  const submission = () =>
    buildFeedbackSubmission({
      category: "bug",
      details: "x",
      context: CONTEXT,
      viewport: { width: 1, height: 1 },
      userAgent: "a",
      platform: "b",
      language: "c",
    });
  beforeEach(() => {
    vi.stubEnv("VITE_FEEDBACK_ENDPOINT", "https://moss-devs.example.test/feedback");
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts the report as JSON to the configured endpoint", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    const report = submission();
    await submitFeedback(report, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith(
      "https://moss-devs.example.test/feedback",
      expect.objectContaining({ method: "POST", body: JSON.stringify(report) }),
    );
  });

  it.each([
    [413, FEEDBACK_TOO_LARGE_MESSAGE],
    [429, FEEDBACK_RATE_LIMITED_MESSAGE],
    [400, FEEDBACK_REJECTED_MESSAGE],
    [503, FEEDBACK_UNAVAILABLE_MESSAGE],
  ])("turns a %i answer into a plain message, never the service's text", async (status, text) => {
    const fetcher = async () =>
      Response.json({ error: "Invalid feedback attachments" }, { status });
    await expect(submitFeedback(submission(), fetcher as typeof fetch)).rejects.toThrow(text);
  });

  it("says so when the network fails", async () => {
    const fetcher = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(submitFeedback(submission(), fetcher as typeof fetch)).rejects.toThrow(
      FEEDBACK_NETWORK_MESSAGE,
    );
  });
});
