import { describe, expect, it } from "vitest";

import { translateZhCnPullRequestText } from "./zhCNPullRequests";

describe("translateZhCnPullRequestText", () => {
  it("translates list, filter, detail, comment, code, and unavailable states", () => {
    expect(translateZhCnPullRequestText("Pull requests")).toBe("拉取请求");
    expect(translateZhCnPullRequestText("Reviewing")).toBe("待我审查");
    expect(translateZhCnPullRequestText("Ready for review")).toBe("可供审查");
    expect(translateZhCnPullRequestText("squash")).toBe("压缩合并");
    expect(translateZhCnPullRequestText("Leave a comment")).toBe("发表评论");
    expect(translateZhCnPullRequestText("Severity")).toBe("严重度");
    expect(translateZhCnPullRequestText("Loading pull request diff…")).toBe(
      "正在加载拉取请求差异…",
    );
    expect(translateZhCnPullRequestText("GitHub CLI is required")).toBe("需要 GitHub CLI");
  });

  it("translates sidebar and environment-panel copy", () => {
    expect(
      translateZhCnPullRequestText("The pull request review count is temporarily incomplete"),
    ).toBe("拉取请求审查数量暂时不完整");
    expect(translateZhCnPullRequestText("Open pull request file changes")).toBe(
      "打开拉取请求文件更改",
    );
    expect(translateZhCnPullRequestText("No checks reported for this PR.")).toBe(
      "此拉取请求未报告检查。",
    );
    expect(translateZhCnPullRequestText("More review comments may be available on GitHub.")).toBe(
      "GitHub 上可能还有更多审查评论。",
    );
  });

  it("preserves project names, PR numbers, branches, actors, and error details", () => {
    expect(translateZhCnPullRequestText("Filter pull requests by project: Moss Desktop")).toBe(
      "按项目筛选拉取请求：Moss Desktop",
    );
    expect(translateZhCnPullRequestText("Pin pull request #42 in Moss Desktop")).toBe(
      "固定拉取请求 #42（Moss Desktop）",
    );
    expect(translateZhCnPullRequestText("2 projects")).toBe("2 个项目");
    expect(translateZhCnPullRequestText("Pin pull request #42 in 2 projects")).toBe(
      "固定拉取请求 #42（涉及 2 个项目）",
    );
    expect(translateZhCnPullRequestText("Unpin pull request #42 in 2 projects")).toBe(
      "取消固定拉取请求 #42（涉及 2 个项目）",
    );
    expect(translateZhCnPullRequestText("Pin pull request #42 in 2 个项目")).toBe(
      "固定拉取请求 #42（2 个项目）",
    );
    expect(translateZhCnPullRequestText("Conflicts with release/0.5.5")).toBe(
      "与 release/0.5.5 冲突",
    );
    expect(translateZhCnPullRequestText("octocat opened this pull request")).toBe(
      "octocat 打开了此拉取请求",
    );
    expect(translateZhCnPullRequestText("dependabot[bot] opened this pull request")).toBe(
      "dependabot[bot] 打开了此拉取请求",
    );
    expect(translateZhCnPullRequestText("github-actions[bot] reviewed")).toBe(
      "github-actions[bot] 已审查",
    );
    expect(translateZhCnPullRequestText("reviewdog[bot] commented")).toBe("reviewdog[bot] 已评论");
    expect(translateZhCnPullRequestText("Couldn't load review comments: HTTP 403")).toBe(
      "无法加载审查评论：HTTP 403",
    );
  });

  it("translates generated counts and confirmation copy", () => {
    expect(
      translateZhCnPullRequestText("At least 12 pull requests are waiting for your review"),
    ).toBe("至少有 12 个拉取请求等待你审查");
    expect(translateZhCnPullRequestText("3 failing checks")).toBe("3 项检查失败");
    expect(translateZhCnPullRequestText("20+ comments")).toBe("20+ 条评论");
    expect(translateZhCnPullRequestText("12 files")).toBe("12 个文件");
    expect(translateZhCnPullRequestText("This will merge #359 using squash.")).toBe(
      "将以压缩合并方式合并 #359。",
    );
    expect(
      translateZhCnPullRequestText(
        "2 project repositories were unavailable. Healthy repositories are still shown.",
      ),
    ).toBe("2 个项目的仓库不可用；正常仓库仍会显示。");
  });

  it("leaves repository, branch, user, path, check names, and unknown copy untouched", () => {
    expect(translateZhCnPullRequestText("Open")).toBe("Open");
    expect(translateZhCnPullRequestText("owner/repository")).toBe("owner/repository");
    expect(translateZhCnPullRequestText("feature/merge-work")).toBe("feature/merge-work");
    expect(translateZhCnPullRequestText("octocat")).toBe("octocat");
    expect(translateZhCnPullRequestText("src/pullRequest.ts")).toBe("src/pullRequest.ts");
    expect(translateZhCnPullRequestText("CI / lint (node-22)")).toBe("CI / lint (node-22)");
    expect(translateZhCnPullRequestText("A user-authored review body")).toBe(
      "A user-authored review body",
    );
  });
});
