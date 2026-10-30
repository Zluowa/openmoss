interface ReleaseSourceRefPolicyInput {
  readonly tag: string;
  readonly publishRelease: boolean;
  readonly refType: string | undefined;
  readonly refName: string | undefined;
  readonly sourceCommit: string;
  readonly resolveTagCommit: (tag: string) => string;
}

export function resolveReleaseSourceTag(input: ReleaseSourceRefPolicyInput): string {
  if (input.refType === "tag" && input.refName === input.tag) {
    const tagCommit = input.resolveTagCommit(input.tag).toLowerCase();
    if (tagCommit !== input.sourceCommit.toLowerCase()) {
      throw new Error(
        `Release tag ${input.tag} points to ${tagCommit}, not ${input.sourceCommit}.`,
      );
    }
    return input.tag;
  }

  // Moss publishes updater assets into a separate public repository. The
  // source repository therefore proves exact current main, not a same-name
  // source tag that may not and need not exist.
  if (input.refType === "branch" && input.refName === "main") {
    return "";
  }

  if (input.publishRelease) {
    throw new Error(
      `Publishing requires exact source branch main or exact source tag ${input.tag}; got ${input.refType || "<none>"}/${input.refName || "<none>"}.`,
    );
  }
  return "";
}
