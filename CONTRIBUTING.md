# Contributing

Thanks for helping with Moss. Small, focused pull requests are the most likely to be accepted: bug fixes, reliability and performance fixes, and tightly scoped maintenance. Please open an issue before starting anything large or direction-changing.

## How this repository works

This repository is a mirror. Moss is developed in a private repository that also holds the hosted backend; each sync publishes the open-source part here as a single commit whose message names the source commit (`Source-Commit: …`).

Pull requests are reviewed here as usual. When one is accepted, a maintainer applies it to the private repository with you as the commit author or co-author, and it reaches this repository in the next sync. The pull request is then closed with a link to the sync commit rather than merged.

## Before you open a pull request

- Run `bun fmt`, `bun lint`, and `bun typecheck`, and the tests for the packages you changed (`bun run test`; do not use `bun test`).
- Explain what changed and why, and include screenshots for UI changes.
- Keep unrelated changes out of the pull request.

## Assets in the open-source build

Official Moss builds use a commercially licensed icon set. This repository ships [Tabler Icons](https://tabler.io/icons) (MIT) under the same icon names instead, plus neutral placeholders for a few decorative images. Please don't add assets you don't have the right to publish under this repository's license.
