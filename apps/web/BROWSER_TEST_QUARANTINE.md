# Browser test quarantine

The blocking browser suite selects every test whose full name does not contain
`[geometry:linux]`. Adding that marker is therefore a reviewed quarantine
change, not a broad file exclusion. Runtime, event-stream, teardown, and
unhandled errors must never be added here.

Owner for every entry: `web/transcript`.

Removal criterion: remove an entry after the underlying estimator, font, or
layout behavior is corrected and the untagged test passes in three consecutive
blocking Ubuntu CI runs.

The original Linux failure evidence is commit `7c80c0dee`, whose CI run reported
12+ ChatView geometry failures after browser tests first moved to hosted Ubuntu.
The current quarantine is intentionally narrower and contains only assertions
whose result depends directly on pixel/font/layout measurements.

| Full test name                                                                                                                                   | Cases | Reason                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----: | -------------------------------------------------------------------------------------- |
| `ChatView transcript geometry (full app) [geometry:linux] clamps long user messages to twelve rendered lines at the $name viewport`              |     1 | Compares rendered text height with the twelve-line clamp at the desktop viewport.      |
| `ChatView transcript geometry (full app) [geometry:linux] tracks wrapping parity while resizing an existing ChatView across the viewport matrix` |     1 | Compares rendered wrapping after desktop, tablet, mobile, and narrow viewport resizes. |
| `ChatView transcript geometry (full app) [geometry:linux] collapses header actions into overflow before they can overlap the thread title`       |     1 | Compares bounding rectangles under a narrow viewport.                                  |
| `ChatView transcript geometry (full app) [geometry:linux] keeps the composer visible while a long assistant response forces a viewport relayout` |     1 | Compares composer, host, and scroll-container geometry across viewport sizes.          |
| `ChatView transcript geometry (full app) [geometry:linux] keeps user attachments inside their rendered row at the $name viewport`                |     1 | Compares rendered attachment-row containment at the narrow viewport.                   |

Total quarantined cases: **5**. This inventory reflects the existing source tags;
the CI partition change adds no quarantine markers.

Explicitly not quarantined:

- delayed attachment loading must remain bottom-stuck;
- optimistic user sends must re-stick to the bottom, and the sent message must
  glide to its anchor in one motion and hold it;
- the sent-message anchor's 900 ms limit and transcript reveal's 50 ms limit;
- orchestration event replay/deduplication and keybinding config notifications;
- any browser runtime or unhandled error.
