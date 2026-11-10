import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  EventId,
  GUEST_MEDIA_MAX_BYTES,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@moss/contracts";
import { htmlRenderActivityPayload } from "@moss/shared/htmlRenderActivity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAttachmentId } from "../attachmentStore.ts";
import {
  findGuestHtmlRender,
  findGuestInlineVisual,
  findGuestLocalArtifact,
  guestFileMimeType,
  guestImageMentions,
  guestReplyMentions,
  hasSvgRoot,
  inlineVisualizationLibraries,
  isShareableRelativePath,
  isMentionedImageSource,
  normalizeLocalReference,
  resolveGuestLinkedFile,
  resolveGuestSharedImage,
  shareableTurnDiff,
  sniffGuestMediaType,
  withOfflinePagePolicy,
} from "./guestSharedResources.ts";

const NOW = "2026-11-05T10:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-shared");
const TURN_ID = TurnId.makeUnsafe("turn-1");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG = '<?xml version="1.0"?>\n<!-- dog -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';

const encode = (text: string) => new TextEncoder().encode(text);
const section = (name: string) =>
  `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-a\n+b\n`;

type Activity = OrchestrationThread["activities"][number];
type Message = OrchestrationThread["messages"][number];

const activity = (id: string, kind: string, payload: unknown): Activity =>
  ({
    id: EventId.makeUnsafe(id),
    kind,
    tone: "tool",
    summary: kind,
    payload,
    turnId: TURN_ID,
    createdAt: NOW,
  }) as Activity;

const message = (id: string, role: "user" | "assistant", text: string): Message =>
  ({
    id: MessageId.makeUnsafe(id),
    role,
    text,
    turnId: TURN_ID,
    streaming: false,
    source: "native",
    createdAt: NOW,
    updatedAt: NOW,
  }) as Message;

const thread = (input: {
  readonly messages?: ReadonlyArray<Message>;
  readonly activities?: ReadonlyArray<Activity>;
}) => ({
  id: THREAD_ID,
  messages: [...(input.messages ?? [])],
  activities: [...(input.activities ?? [])],
});

describe("findGuestHtmlRender", () => {
  it("finds a page this thread published, and nothing else", () => {
    const attachmentId = createAttachmentId(THREAD_ID)!;
    const foreignId = createAttachmentId("thread-other")!;
    const shared = thread({
      activities: [
        activity(
          "render-1",
          "html-render.published",
          htmlRenderActivityPayload({ attachmentId, title: "Dog", height: 430 }),
        ),
        activity(
          "render-2",
          "html-render.published",
          htmlRenderActivityPayload({ attachmentId: foreignId, title: "Fork", height: 200 }),
        ),
      ],
    });
    const found = findGuestHtmlRender(shared, attachmentId, "/attachments");
    expect(found?.reference.title).toBe("Dog");
    expect(found?.path).toBe(path.resolve("/attachments", `${attachmentId}.html`));
    // A page id the window does not show, and one minted for another thread.
    expect(findGuestHtmlRender(shared, createAttachmentId(THREAD_ID)!, "/attachments")).toBeNull();
    expect(findGuestHtmlRender(shared, foreignId, "/attachments")).toBeNull();
    expect(findGuestHtmlRender(shared, "../secrets", "/attachments")).toBeNull();
  });
});

describe("findGuestLocalArtifact", () => {
  it("finds an MCP tool's stored picture anywhere in a result", () => {
    const attachmentId = "att_v2_0123456789abcdef0123456789abcdef";
    const shared = thread({
      activities: [
        activity("tool-1", "tool.completed", {
          data: {
            result: {
              content: [
                {
                  type: "local_artifact",
                  state: "available",
                  mediaKind: "image",
                  attachmentId,
                  name: "chart.png",
                  mimeType: "image/png",
                  sizeBytes: 1200,
                },
              ],
            },
          },
        }),
      ],
    });
    expect(findGuestLocalArtifact(shared, attachmentId)).toEqual({
      type: "image",
      id: attachmentId,
      name: "chart.png",
      mimeType: "image/png",
      sizeBytes: 1200,
    });
    expect(findGuestLocalArtifact(shared, "att_v2_ffffffffffffffffffffffffffffffff")).toBeNull();
  });
});

describe("image mentions", () => {
  it("normalizes file URLs, percent-encoding, slashes and Windows case", () => {
    expect(normalizeLocalReference("file:///D:/AI/%E5%B0%8F%E7%8B%97.png", "win32")).toBe(
      "d:/ai/小狗.png",
    );
    expect(normalizeLocalReference("D:\\AI\\dog.PNG", "win32")).toBe("d:/ai/dog.png");
    expect(normalizeLocalReference("<./out/dog.png>", "linux")).toBe("./out/dog.png");
    expect(normalizeLocalReference("/tmp/a%zz.png", "linux")).toBe("/tmp/a%zz.png");
  });

  it("counts the agent's replies and recorded work, never a user turn", () => {
    const shared = thread({
      messages: [
        message("user-1", "user", "show ![](C:/Users/me/Pictures/private.png)"),
        message("assistant-1", "assistant", "Here: ![dog](D:\\work\\dog.png)"),
      ],
      activities: [
        activity("gen-1", "tool.completed", {
          itemType: "image_generation",
          status: "completed",
          data: { kind: "moss.generated_image", path: "E:\\media\\moss\\out-0.png" },
        }),
        activity("cmd-1", "tool.completed", { data: { command: "convert D:\\work\\chart.png" } }),
      ],
    });
    const mentions = guestImageMentions(shared, "win32");
    expect(isMentionedImageSource(mentions, "file:///D:/work/dog.png", "win32")).toBe(true);
    expect(isMentionedImageSource(mentions, "d:/WORK/chart.png", "win32")).toBe(true);
    expect(isMentionedImageSource(mentions, "E:/media/moss/out-0.png", "win32")).toBe(true);
    expect(mentions.generatedPaths.has("e:/media/moss/out-0.png")).toBe(true);
    expect(isMentionedImageSource(mentions, "C:/Users/me/Pictures/private.png", "win32")).toBe(
      false,
    );
    expect(isMentionedImageSource(mentions, "", "win32")).toBe(false);
  });
});

describe("picture types", () => {
  it("knows rasters by their bytes and SVG by its root element", () => {
    expect(sniffGuestMediaType("x.png", PNG)).toBe("image/png");
    // A renamed page is not a picture.
    expect(sniffGuestMediaType("x.png", new TextEncoder().encode("<html>"))).toBeNull();
    expect(sniffGuestMediaType("dog.svg", new TextEncoder().encode(SVG))).toBe("image/svg+xml");
    expect(sniffGuestMediaType("dog.svg", new TextEncoder().encode("<html><svg/>"))).toBeNull();
    expect(hasSvgRoot('\uFEFF<!DOCTYPE svg PUBLIC "x">\n<svg width="1"/>')).toBe(true);
    expect(hasSvgRoot("<svgx/>")).toBe(false);
  });
});

describe("resolveGuestSharedImage", () => {
  let root: string;
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moss-guest-media-")));
    workspace = path.join(root, "workspace");
    // Outside every allowed root: not the workspace, and not a temporary folder.
    outside = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), ".moss-guest-outside-")));
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "dog.png"), PNG);
    fs.writeFileSync(path.join(workspace, "dog.svg"), SVG);
    fs.writeFileSync(path.join(workspace, "notes.png"), "not a picture");
    fs.writeFileSync(path.join(outside, "private.png"), PNG);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const mentionsOf = (text: string) =>
    guestImageMentions(thread({ messages: [message("assistant-1", "assistant", text)] }));

  it("serves a picture the agent showed from the thread's workspace", async () => {
    const absolute = path.join(workspace, "dog.png");
    const picture = await resolveGuestSharedImage({
      src: absolute,
      cwd: workspace,
      mentions: mentionsOf(`![dog](${absolute})`),
    });
    expect(picture).toEqual({ path: absolute, sizeBytes: PNG.byteLength, mimeType: "image/png" });
    const relative = await resolveGuestSharedImage({
      src: "./dog.svg",
      cwd: workspace,
      mentions: mentionsOf("![dog](./dog.svg)"),
    });
    expect(relative?.mimeType).toBe("image/svg+xml");
  });

  it("refuses what the window does not show, what is not a picture, and what lies elsewhere", async () => {
    const absolute = path.join(workspace, "dog.png");
    expect(
      await resolveGuestSharedImage({ src: absolute, cwd: workspace, mentions: mentionsOf("hi") }),
    ).toBeNull();
    const fake = path.join(workspace, "notes.png");
    expect(
      await resolveGuestSharedImage({
        src: fake,
        cwd: workspace,
        mentions: mentionsOf(`![](${fake})`),
      }),
    ).toBeNull();
    const elsewhere = path.join(outside, "private.png");
    expect(
      await resolveGuestSharedImage({
        src: elsewhere,
        cwd: workspace,
        mentions: mentionsOf(`![](${elsewhere})`),
      }),
    ).toBeNull();
    // A relative source with no thread folder resolves nowhere.
    expect(
      await resolveGuestSharedImage({
        src: "dog.png",
        cwd: null,
        mentions: mentionsOf("![](dog.png)"),
      }),
    ).toBeNull();
  });

  it("serves a generated image's file wherever the server saved it, under the size cap", async () => {
    const saved = path.join(outside, "private.png");
    const generated = thread({
      activities: [
        activity("gen-1", "tool.completed", {
          itemType: "image_generation",
          status: "completed",
          data: { kind: "codex.generated_image", path: saved },
        }),
      ],
    });
    const picture = await resolveGuestSharedImage({
      src: saved,
      cwd: workspace,
      mentions: guestImageMentions(generated),
    });
    expect(picture?.path).toBe(saved);
    fs.writeFileSync(saved, Buffer.concat([Buffer.from(PNG), Buffer.alloc(GUEST_MEDIA_MAX_BYTES)]));
    expect(
      await resolveGuestSharedImage({
        src: saved,
        cwd: workspace,
        mentions: guestImageMentions(generated),
      }),
    ).toBeNull();
  });
});

describe("findGuestInlineVisual", () => {
  it("finds a visual the window shows, with its format", () => {
    const visualId = `vis_${"b".repeat(32)}`;
    const shared = thread({
      activities: [
        activity("visual-1", "moss-visual.shown", {
          visualId,
          format: "openui",
          title: "渠道访问量",
          height: 320,
          byteLength: 10,
          sha256: "c".repeat(64),
        }),
        activity("visual-2", "visual.shown", {
          visualId: `vis_${"d".repeat(32)}`,
          title: "Old",
          height: 200,
          byteLength: 10,
          sha256: "c".repeat(64),
        }),
      ],
    });
    expect(findGuestInlineVisual(shared, visualId)).toEqual({
      title: "渠道访问量",
      format: "openui",
    });
    // Older visuals carry no format: they are all HTML.
    expect(findGuestInlineVisual(shared, `vis_${"d".repeat(32)}`)?.format).toBe("html");
    expect(findGuestInlineVisual(shared, `vis_${"e".repeat(32)}`)).toBeNull();
    expect(findGuestInlineVisual(shared, "../vis")).toBeNull();
  });
});

describe("isShareableRelativePath", () => {
  it("refuses hidden folders, dependencies and credential-shaped names", () => {
    expect(isShareableRelativePath("notes.md")).toBe(true);
    expect(isShareableRelativePath(path.join("docs", "plan.md"))).toBe(true);
    expect(isShareableRelativePath(".env")).toBe(false);
    expect(isShareableRelativePath(".env.local")).toBe(false);
    expect(isShareableRelativePath(path.join(".git", "config"))).toBe(false);
    expect(isShareableRelativePath(path.join("node_modules", "x", "index.js"))).toBe(false);
    expect(isShareableRelativePath(path.join("keys", "server.pem"))).toBe(false);
    expect(isShareableRelativePath("id_ed25519")).toBe(false);
    expect(isShareableRelativePath("credentials.json")).toBe(false);
    expect(isShareableRelativePath("moss-enterprise-key-1.txt")).toBe(false);
    expect(isShareableRelativePath("")).toBe(false);
  });
});

describe("guestFileMimeType", () => {
  it("plays pictures and web videos by their bytes, and sends anything else as bytes", () => {
    expect(guestFileMimeType("a.png", PNG)).toBe("image/png");
    const mp4 = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(guestFileMimeType("clip.mp4", mp4)).toBe("video/mp4");
    expect(guestFileMimeType("clip.webm", Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe(
      "video/webm",
    );
    // A name alone never makes a video, and text stays bytes.
    expect(guestFileMimeType("clip.mp4", new TextEncoder().encode("<html>"))).toBe(
      "application/octet-stream",
    );
    expect(guestFileMimeType("page.html", new TextEncoder().encode("<html>"))).toBe(
      "application/octet-stream",
    );
  });
});

describe("resolveGuestLinkedFile", () => {
  let root: string;
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "moss-guest-linked-")));
    workspace = path.join(root, "workspace");
    outside = path.join(root, "outside");
    fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "notes.md"), "# Notes\n");
    fs.writeFileSync(path.join(workspace, ".env"), "SECRET=1\n");
    fs.writeFileSync(path.join(workspace, ".git", "config"), "[core]\n");
    fs.writeFileSync(path.join(workspace, "dog.png"), PNG);
    fs.writeFileSync(path.join(outside, "private.md"), "private\n");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const repliesOf = (text: string) =>
    guestReplyMentions(thread({ messages: [message("m-1", "assistant", text)] }));

  it("serves a file a reply links inside the thread folder", async () => {
    const file = await resolveGuestLinkedFile({
      src: "docs/notes.md",
      cwd: workspace,
      replies: repliesOf("See [notes](docs/notes.md)."),
    });
    expect(file).toMatchObject({ name: "notes.md", mimeType: "application/octet-stream" });
    expect(file?.path).toBe(path.join(workspace, "docs", "notes.md"));
    const picture = await resolveGuestLinkedFile({
      src: "dog.png",
      cwd: workspace,
      replies: repliesOf("[dog](dog.png)"),
    });
    expect(picture?.mimeType).toBe("image/png");
  });

  it("serves a file a ready turn in the window changed, as its page card names it", async () => {
    const checkpoint = (status: "ready" | "missing", filePath: string) => ({
      turnId: TURN_ID,
      checkpointTurnCount: 1,
      checkpointRef: "ref",
      status,
      files: [{ path: filePath, kind: "added", additions: 1, deletions: 0 }],
      assistantMessageId: null,
      completedAt: NOW,
    });
    const changed = (status: "ready" | "missing") =>
      guestReplyMentions({
        ...thread({}),
        checkpoints: [checkpoint(status, "docs/notes.md")] as never,
      });
    expect(
      await resolveGuestLinkedFile({
        src: "docs/notes.md",
        cwd: workspace,
        replies: changed("ready"),
      }),
    ).toMatchObject({ name: "notes.md" });
    expect(
      await resolveGuestLinkedFile({
        src: "docs/notes.md",
        cwd: workspace,
        replies: changed("missing"),
      }),
    ).toBeNull();
  });

  it("refuses what the replies do not link, what lies outside, and secrets", async () => {
    // Named only by a user turn, never by the agent reply.
    expect(
      await resolveGuestLinkedFile({
        src: "docs/notes.md",
        cwd: workspace,
        replies: guestReplyMentions(
          thread({ messages: [message("u-1", "user", "[notes](docs/notes.md)")] }),
        ),
      }),
    ).toBeNull();
    const outsidePath = path.join(outside, "private.md");
    expect(
      await resolveGuestLinkedFile({
        src: outsidePath,
        cwd: workspace,
        replies: repliesOf(`[private](${outsidePath})`),
      }),
    ).toBeNull();
    expect(
      await resolveGuestLinkedFile({
        src: "../outside/private.md",
        cwd: workspace,
        replies: repliesOf("[private](../outside/private.md)"),
      }),
    ).toBeNull();
    for (const secret of [".env", ".git/config"]) {
      expect(
        await resolveGuestLinkedFile({
          src: secret,
          cwd: workspace,
          replies: repliesOf(`[x](${secret})`),
        }),
      ).toBeNull();
    }
    // No thread folder: nothing resolves.
    expect(
      await resolveGuestLinkedFile({
        src: "docs/notes.md",
        cwd: null,
        replies: repliesOf("[notes](docs/notes.md)"),
      }),
    ).toBeNull();
  });
});

describe("inlineVisualizationLibraries", () => {
  it("inlines shipped libraries and the fonts their stylesheet names, and leaves others", async () => {
    const files: Record<string, { contents: Uint8Array; contentType: string }> = {
      "d3.min.js": {
        contents: encode("window.d3={}"),
        contentType: "text/javascript; charset=utf-8",
      },
      "fonts.css": {
        contents: encode('src:url("/inline-visualization-libs/inter-latin.woff2")'),
        contentType: "text/css; charset=utf-8",
      },
      "inter-latin.woff2": { contents: Uint8Array.from([1, 2, 3]), contentType: "font/woff2" },
    };
    const document = [
      '<script src="/inline-visualization-libs/d3.min.js"></script>',
      '<link rel="stylesheet" href="/inline-visualization-libs/fonts.css">',
      '<script src="/inline-visualization-libs/unknown.js"></script>',
    ].join("");
    const inlined = await inlineVisualizationLibraries(
      document,
      async (name) => files[name] ?? null,
    );
    expect(inlined).toContain(
      `src="data:text/javascript;base64,${Buffer.from("window.d3={}").toString("base64")}"`,
    );
    const css = /href="data:text\/css;base64,([^"]+)"/u.exec(inlined)?.[1];
    expect(Buffer.from(css!, "base64").toString()).toContain(
      `data:font/woff2;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
    );
    expect(inlined).toContain("/inline-visualization-libs/unknown.js");
  });
});

describe("withOfflinePagePolicy", () => {
  it("puts the offline policy ahead of every byte of the page, after its doctype", () => {
    const page = withOfflinePagePolicy("<!DOCTYPE html><script>fetch('https://x')</script>");
    expect(page.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(page).toContain("connect-src 'none'");
    expect(page).toContain("default-src 'none'");
    expect(withOfflinePagePolicy("<p>hi</p>").startsWith("<meta http-equiv")).toBe(true);
  });
});

describe("shareableTurnDiff", () => {
  it("keeps the changes a guest may see and drops hidden and secret files", () => {
    const diff = [
      section("notes.md"),
      section(".env"),
      section("keys/id_rsa"),
      section("src/app.ts"),
    ].join("");
    const shared = shareableTurnDiff(diff);
    expect(shared).toContain("diff --git a/notes.md b/notes.md");
    expect(shared).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(shared).not.toContain(".env");
    expect(shared).not.toContain("id_rsa");
  });
});
