import { describe, expect, it } from "vitest";
import { skillFilePath, skillMarkdownBody } from "./skillContent";

describe("skill instructions presentation", () => {
  it("hides complete frontmatter while preserving instruction separators and code", () => {
    const raw =
      "\uFEFF---\r\nname: example\r\ndescription: Example\r\n---\r\n# Instructions\r\n\r\n---\r\n```sh\r\necho ready\r\n```";
    expect(skillMarkdownBody(raw)).toBe("# Instructions\r\n\r\n---\r\n```sh\r\necho ready\r\n```");
  });

  it("does not discard an incomplete frontmatter block or ordinary markdown", () => {
    expect(skillMarkdownBody("---\nname: example\n# Instructions")).toBe(
      "---\nname: example\n# Instructions",
    );
    expect(skillMarkdownBody("# Instructions\n---\nRead this")).toBe(
      "# Instructions\n---\nRead this",
    );
  });

  it("maps registered file and directory descriptors to native file actions", () => {
    expect(skillFilePath("/home/user/skills/example/SKILL.md")).toBe(
      "/home/user/skills/example/SKILL.md",
    );
    expect(skillFilePath("/home/user/skills/example/")).toBe("/home/user/skills/example/SKILL.md");
    expect(skillFilePath("C:\\Users\\user\\skills\\example")).toBe(
      "C:\\Users\\user\\skills\\example\\SKILL.md",
    );
    expect(skillFilePath("skill://remote/example")).toBeNull();
    expect(skillFilePath("https://example.com/SKILL.md")).toBeNull();
    expect(skillFilePath("relative/example")).toBeNull();
  });
});
