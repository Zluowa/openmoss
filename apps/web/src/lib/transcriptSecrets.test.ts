import { describe, expect, it } from "vitest";

import { findTranscriptSecrets, rehypeRedactSecrets } from "./transcriptSecrets";

const fakeGithub = `ghp_${"a1".repeat(18)}`;
const fakeMoss = `moss_sk_${"Ab3".repeat(8)}`;

describe("findTranscriptSecrets", () => {
  it("finds known credential shapes and their kinds", () => {
    const text = `key ${fakeMoss} and token ${fakeGithub} done`;
    const found = findTranscriptSecrets(text);
    expect(found.map((match) => match.kind)).toEqual(["moss", "github"]);
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe(fakeMoss);
  });

  it("prefers the specific Anthropic prefix over the generic one", () => {
    const key = `sk-ant-api03-${"x".repeat(40)}`;
    expect(findTranscriptSecrets(key).map((match) => match.kind)).toEqual(["anthropic"]);
  });

  it("leaves ordinary words, hashes and short ids alone", () => {
    expect(findTranscriptSecrets("commit 66bbd0c0e on main, sk-short, AKIA123")).toEqual([]);
  });
});

describe("rehypeRedactSecrets", () => {
  it("wraps secrets in text and inline code, but not fenced code", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          children: [{ type: "text", value: `use ${fakeGithub} now` }],
        },
        { type: "element", tagName: "pre", children: [{ type: "text", value: fakeGithub }] },
      ],
    };
    rehypeRedactSecrets()(tree);
    const paragraph = tree.children[0]!.children!;
    expect(paragraph.map((node) => ("tagName" in node ? node.tagName : node.type))).toEqual([
      "text",
      "moss-secret",
      "text",
    ]);
    expect(tree.children[1]!.children![0]).toEqual({ type: "text", value: fakeGithub });
  });
});
