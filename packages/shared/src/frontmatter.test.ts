import { describe, expect, it } from "vitest";

import {
  parseScalarFrontmatter,
  parseSkillFrontmatter,
  readBooleanField,
  readStringField,
} from "./frontmatter";

describe("parseScalarFrontmatter", () => {
  it("parses scalar metadata with quoted strings and booleans", () => {
    expect(
      parseScalarFrontmatter(`---
name: check-code
description: "Review: recent code changes"
disable-model-invocation: true
---

# Check Code
`),
    ).toEqual({
      name: "check-code",
      description: "Review: recent code changes",
      "disable-model-invocation": true,
    });
  });

  it("parses folded and literal block scalars while retaining only top-level scalar fields", () => {
    expect(
      parseScalarFrontmatter(`---
name: real-name
description: >-
  Use when writing a pull request
  so reviewers go fast.
disable-model-invocation: true
tags:
  - review
  - pull-request
allowed-tools: [Read, Grep]
metadata:
  name: nested-name
  description: nested description
  short-description: Compact summary
---
`),
    ).toEqual({
      name: "real-name",
      description: "Use when writing a pull request so reviewers go fast.",
      "disable-model-invocation": true,
      "short-description": "Compact summary",
    });

    expect(
      parseScalarFrontmatter(`---
name: literal
description: |
  First line
  Second line
---
`),
    ).toEqual({ name: "literal", description: "First line\nSecond line" });
  });

  it("returns an empty record when there is no frontmatter block", () => {
    expect(parseScalarFrontmatter("# Title\n\nBody only.\n")).toEqual({});
  });

  it("skips comments, blank lines, and keyless/valueless lines", () => {
    expect(
      parseScalarFrontmatter(`---
# a comment
name: hook
: orphan-value
empty:
enabled: false
---
Body.
`),
    ).toEqual({ name: "hook", enabled: false });
  });

  it("falls back to the lenient reader when the frontmatter is not valid YAML", () => {
    expect(
      parseScalarFrontmatter(`---
name: loose
description: Use when: the user asks for it
---
`),
    ).toEqual({ name: "loose", description: "Use when: the user asks for it" });
  });

  it("normalizes CRLF input and single-quoted values", () => {
    expect(parseScalarFrontmatter("---\r\nname: 'crlf hook'\r\n---\r\nBody.\r\n")).toEqual({
      name: "crlf hook",
    });
  });

  it("keeps parseSkillFrontmatter as an identical alias", () => {
    expect(parseSkillFrontmatter).toBe(parseScalarFrontmatter);
  });
});

describe("readStringField / readBooleanField", () => {
  const frontmatter = {
    name: "  padded  ",
    empty: "",
    enabled: false,
    flagText: "true",
  } as const;

  it("returns the first non-empty trimmed string across keys", () => {
    expect(readStringField(frontmatter, ["missing", "name"])).toBe("padded");
    expect(readStringField(frontmatter, ["empty"])).toBeUndefined();
    expect(readStringField(frontmatter, ["enabled"])).toBeUndefined();
  });

  it("returns only real booleans", () => {
    expect(readBooleanField(frontmatter, ["enabled"])).toBe(false);
    expect(readBooleanField(frontmatter, ["flagText"])).toBeUndefined();
    expect(readBooleanField(frontmatter, ["missing"])).toBeUndefined();
  });
});
