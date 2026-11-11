---
name: design-review
description: Use for any change a user can see, including its text - check it against the Moss design standard with the static checks and in a real render, both themes and both languages.
---

# Design review

## When to use

For every change a person can see: layout, components, motion, icons, colours,
and user-facing text (until a separate `copy-review` skill exists). Run it as the
author before `open-pr`, and as a reviewer inside `review-pr`. Not for changes
with no visible effect.

## Inputs

- `docs/design/moss-design-standard.md`: the rules (it wins over everything else
  on design).
- `docs/design/visual-system.md`: the values and where each one comes from.
- `docs/zh-CN-product-glossary.md`: the terms user-facing zh-CN text must use.
- The two `docs/design/` files are kept in the private repository. Without them,
  use `apps/web/README.md` and the static checks below.
- A running isolated instance of the change (`run-isolated`).

## Steps

1. Read the sections of the design standard that cover what changed (colour,
   text, sizes, radius, elevation, icons, motion, component rules, the do-not
   list), and the matching values in `visual-system.md`.
2. Run the static checks:
   - `bun run design:check` (fails when any file gains hard-coded colours,
     size-named or one-off radii, one-off sizes or shadows, extra bold weights or
     bare `<button>`s over `scripts/design-check-baseline.json`);
   - `bun run brand:check`;
   - `bun run --cwd apps/web test src/uiFontSize.test.ts`.
3. If your change lowered a file's counts, lock them in with
   `bun run design:check --update` and commit the baseline. Never raise it.
4. Render it. Start the change with `run-isolated` and take headless screenshots
   of every surface it touches: light and dark, zh-CN and en, and a narrow window.
5. Walk the change against the standard:
   - controls come from `apps/web/src/components/ui/` (`Button`, `Input`,
     `Textarea`, `Select`, menus), not hand-drawn ones;
   - radius by role, two font weights, `text-ui*` and `text-chat*` sizes,
     colours from the theme tokens;
   - open and close motion from `apps/web/src/lib/disclosureMotion.ts`;
   - in chat replies: no card frames, no primary buttons, comparisons as list rows;
   - Moss is the only name and mark on screen.
6. Walk the text:
   - every string and aria label is in `apps/web/src/localization.tsx` with zh-CN
     and en, and reads naturally in both;
   - terms follow the glossary;
   - a failure is one plain sentence plus one action (retry, sign in, install,
     view logs); no command lines, file paths, raw English errors or stack text;
   - sign-in is browser authorization and install is a spinner, never a terminal.
7. Check the layout rules learned from the owner, where they apply:
   - model picker: agents in a left column, that agent's accounts and models on
     the right, both visible;
   - the browser panel owns its own controls; its divider shows on hover and
     drags; menus never flash;
   - clicking an image opens it larger; only the canvas chip opens Canvas;
   - a settings row is one plain line with one action;
   - a shared chat shows the viewer exactly what the owner sees.
8. Compare with the reference the standard names by measuring (sizes, spacing,
   timing), not by eye.

## Checks

- The three static checks pass, with their output quoted.
- Each screenshot exists for both themes and both languages and is attached to
  the PR.

## Output

`design-review: pass`, or a numbered list of findings, each with the screenshot
name, what is wrong, the rule in the design standard, and the fix.

## Traps

- A Moss-named file can still hold an old drawing: look at the image, not only
  its name.
- Menus and dropdowns appear without animation on purpose (the standard says
  why); do not "fix" that.
- Screenshots are evidence for the PR. They never go into the repository.
- Study other products for behaviour only. Never copy their code, fonts, icons or
  other assets into Moss.
- Screenshots and browser tests run headless. A window you start must not appear
  on the owner's screen or take focus.
- Before changing a size scale, re-check which density the reference uses today;
  it has changed between versions.
