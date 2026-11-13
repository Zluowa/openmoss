// FILE: designGuide.ts
// Purpose: The guide agents read (moss_design_guide) before writing a 设计: the artboard format,
//          sizes and layout on the canvas, links, tweaks, design systems, fonts, components,
//          canvas notes and craft rules.
// Layer: Shared model (served by the agent gateway; the web prompt builder quotes its short form)

export const DESIGN_AGENT_GUIDE = `# Moss 设计 (design canvas) guide

A 设计 is a canvas of live artboards. Each artboard is ONE self-contained HTML fragment with
inline styles, rendered in its own frame at the artboard's w×h. People edit it visually in Moss
(the editor rewrites the inline styles and text you wrote), so write clean, editable markup.

## Artboards
- Fields: id ([A-Za-z0-9_-], stable; links use it), name (shown above the frame, in the user's
  language), page, x, y, w, h (40–8000 px), html, layout ("fixed" default, or "page" for a web page /
  dashboard / app screen that should fill the window when played), interactive (true only when its
  links or controls really work), radius, guides, tweaks.
- Sizes: phone 390×844, tablet 834×1194, web page / desktop app 1280–1440 wide, poster 1080×1350,
  square post 1080×1080, story 1080×1920, slide-like 1920×1080.
- Placement: 80 px between frames in a row, 120 px between rows. Omit x/y to let Moss place a new
  artboard right of the top row. Put a title note 260 px above a row that shows a flow.
- The root element is FIXED at w×h for posters, mockups and phone screens (width/height in px).
  For layout "page" the root is fluid (max-width container, %, fr, flex-wrap) and must still work at
  phone width: menus stack, toolbars wrap, wide tables scroll in their own box.
- Lay out with flex or grid plus gap. Put every visual style inline (style="…"): that is what the
  properties panel edits. A <style> block is only for basics (hover colours, @font-face, resets).
- Real elements: <button>, <a href>, <input> with <label>, <h1>…<h6>, <p>, <ul>. Never role or onclick
  on a div. Icon-only buttons get aria-label. Decorative SVG gets aria-hidden="true".
- Icons: inline stroke SVG (24 grid, 1.5–2 stroke, currentColor). Never emoji.
- Images: https URLs or data: URIs only when the user gave the image; otherwise a labelled
  placeholder box. No other network; scripts run only when an interactive artboard is played.
- No filler: no lorem ipsum, no invented numbers or testimonials. Missing facts become
  placeholders in brackets: [价格], [公司名].
- Text contrast 4.5:1 (3:1 for 24 px+ text). Touch targets ≥ 44 px. No fake status bars.

## Links and prototypes
- <a href="board:<id>"> moves Play to that artboard; href="#id" scrolls; https:// opens a tab.
  Style the <a> itself as the button (a <button> inside an <a> swallows the click).
- Mark every artboard of a clickable flow interactive: true. One artboard per screen.

## Tweaks (levers, not copy)
- tweaks: [{name:"accent", label:"强调色", editor:"color", default:"#2a78d6", options?:[…]}]
  editors: color | range (min, max, step, unit) | enum (options) | boolean | text.
- The HTML reads a tweak as var(--tweak-<name>) (range values carry their unit) and booleans/enums as
  data-tweak-<name>="…" on the root element, e.g. [data-tweak-dense="true"] in a <style> rule.
- Declare few: a theme or density switch, a variant, one accent colour. Never a tweak for copy.

## Design systems
- A design installs one design system (moss_design_set_system). Its tokens reach every artboard as
  CSS variables: colours var(--ds-<name>), fonts var(--ds-font-sans|serif|mono), text styles
  var(--ds-text-<style>-size|line|weight), var(--ds-space-<name>), var(--ds-radius-<name>),
  var(--ds-shadow-<name>). Use them (with a fallback: var(--ds-ink, #141413)) instead of raw values.
- Read the system's readme and tokens before designing (moss_design_systems / moss_design_read).
- No system named and none installed: install "builtin:moss" (Moss 设计标准) unless the user's
  brand or brief implies another look. With a brand the user names, match its exact colours,
  type, spacing and radii.
- To make a design system from a codebase: read its styles (CSS variables, Tailwind config, theme
  files), list every colour, text style, spacing and radius with exact values, then create a design
  with ownSystem tokens (moss_design_set_system target "own") and artboards that preview colours,
  type and the main components. From scratch: 6–10 colours, 5–7 text styles, 4 spacing steps,
  3 radii, a short readme.

## Fonts
- Moss works in mainland China, where Google Fonts does not load. Use the design system's fonts
  (var(--ds-font-sans|serif|mono)), the fonts Moss ships ("Inter Variable", "JetBrains Mono
  Variable") or system stacks: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif for
  Chinese sans; "Songti SC", "SimSun", serif for Chinese serif. Never a fonts.googleapis.com link.

## Pictures, video, components
- Video: <video src="https://…" controls playsinline> with an inline size; only the user's own
  https videos (no data: video, it is too big).
- Components: a reusable piece (button, card, nav) is a component: moss_design_update
  upsertComponent {component:{id,name,html}} with data-design-component="<id>" on the root of its
  html; every instance in an artboard carries the same attribute. When you change a component,
  update the component and every instance the same way.
- Print: a long page meant for PDF gets print:"flow" and paper:"a4"|"letter" on its artboard;
  Moss breaks it onto pages between blocks.

## Canvas notes
- Notes sit on the canvas outside artboards: sticky {kind:"sticky", text, color}, title
  {kind:"title", text}, loose shapes {kind:"shape", shape:"rect"|"oval"|"line"|"arrow"|"path",
  x, y, w, h, points?:[x1,y1,x2,y2], d?, stroke?, fill?} for annotating a flow (an arrow from one
  artboard to the next), and link cards {kind:"link", text, href:"moss://space-page/<id>"|"https://…",
  subtitle?}. When you make a deck, doc or another item from this design, add a link card to it.

## Writing
- Create with moss_design_create, then add artboards ONE OR TWO PER CALL with
  moss_design_write_boards so the person watches the canvas fill in. Pass expectedRevision from the
  last result each time.
- Revising: read first (moss_design_read with the artboard ids you will change), change only what
  was asked, keep the person's hand edits. A conflict means someone saved meanwhile: read again,
  redo the edit.
- When the request names "this", "the selected" or "the one on the left", use the selection in the
  request context (selected artboards and element paths). An element path "2/0/1" counts element
  children from the artboard's top-level elements down.
- Tell the user what changed on the canvas, in their language; never describe the JSON.
`;
