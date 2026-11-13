// FILE: dashboardGuide.ts
// Purpose: What an agent reads before building or changing a 数据看板 (data dashboard):
//          the store, datasets, the page API, marks, filters, tokens, design defaults and how
//          to check its work and hand over.
// Layer: Agent gateway (returned by moss_dashboard_guide)
// Spec: docs/design/data-claude-teardown.md

export const DASHBOARD_GUIDE = `# Moss data dashboards (数据看板)

A data dashboard is a page that works itself out again each time it is opened. You write it as
documents: datasets say where every number comes from, and the page (HTML) draws them. The user's
request wins over every default below.

## Tools
- moss_dashboard_create {scopeSpaceId, spaceId, parentPageId, title} makes an empty dashboard
  in the 资料空间 (create it first, so the user sees it at once).
- moss_dashboard_read {scopeSpaceId, pageId} returns the documents, a static check, and the last
  report from the user's open view: faults (what threw, marks that disagree with the data), how
  each source loaded, and the page as text. The report says which revision it describes.
- moss_dashboard_attach_file attaches a data file over about 1.5 MB (see Documents).
- moss_dashboard_write {scopeSpaceId, pageId, expectedRevision, writes:[{op, path, data}]} applies
  set / update / delete writes in one save. Paths: meta, params, settings, look, system, datasets/<id>,
  files/<name>. update merges at every depth; {"__delete__": true} removes a key. Stamp each
  dataset and file with edit: {via: "moss", at: <UTC ISO now>}.

## Documents
- meta {title, lang?}: lang is the page language (default zh-CN).
- params {name: default}: filter defaults. Every {{name}} a query uses needs one.
- settings {updates}: how old a live answer may be when the page opens: "viewed" (run on each
  open), "5min", "hour", "day", "week" or a number of minutes.
- look {name, light, dark}: optional colours; leave it out for Moss's own look.
- system {source}: wear a design system: "builtin:moss" (also editorial, night, fresh) or
  "page:<pageId>" of a 设计 item that keeps its own system (read moss_design_systems). Write
  only the source; Moss copies the tokens and derives the look (colours, font, text size,
  radius), and the page also gets the system's --ds-* variables. Delete it to go back to a look.
- datasets/<id> {title, description?, source, langs?, updated?, schedule?, staleAfterHours?, fixed?}.
  id: up to 64 letters, digits, _ and -. title: a few words that stand alone; description: one
  sentence on what the source is.
  - Attached file: source {kind:"file", name, format?: csv|tsv|json|text, text}. Put the file's
    text inline (UTF-8, under 1.5 MB). Add updated {at, by}. fixed: true when the user wants it
    kept as is. CSV cells arrive as text and empty cells as null: convert before arithmetic.
    Rows you made up go in a dataset whose title starts with "示例" (sample) and whose
    description says how you made them.
  - Live query: source {kind:"call", connector, tool, args, rules?}. One read-only tool call on a
    connector the user added in Moss (a Moss 应用 or a Settings connector), with the args that
    worked when you ran it. Tools that change data are refused. A {{name}} in args is a filter the
    page fills; rules says what each may hold, using only: type (string, number, integer, boolean,
    array), enum, pattern (whole value), minLength, maxLength, minimum, maximum, items, minItems,
    maxItems. A blank that is a whole argument becomes the value itself; inside text it becomes
    its characters (lists joined by commas), so you write the quotes. Keep values out of quotes'
    reach: pin each blank with an enum, a pattern, or a number rule. Answers that are objects
    whose values are cells (bare, or under rows, data or results) are rows; anything else needs a
    dash.loader. langs names an argument that is code ({query: "sql"}).
  - A larger file (over about 1.5 MB, up to 15 MB): moss_dashboard_attach_file {pageId,
    expectedRevision, datasetId, path, title} copies it into the user's 资料库 and writes the
    dataset; the dashboard reads it from there (source.library {itemId, size}). Everyone who can
    open the dashboard can read the whole file; tell the user when you attach one.
- files/<name> {text}: index.html is the page; names are flat. A <script src> or stylesheet
  <link> naming another file loads it.

## The page
It is mounted in <div id="dash-root"> inside an isolated frame. Scripts run in order once the
page is in place, each in its own scope (share through window). Dropped: script src / link href
naming anything but the dashboard's files, type=module, on…= attributes, iframe, object, embed,
base, form. No network, storage or cookies. Data values are untrusted: use textContent / d3
.text(), never innerHTML with data.

Start index.html with <meta name="dash-one-writer">: words you know when writing are in the HTML;
what the data decides goes in elements marked data-draw="name" stored with at most "—" (a
table body, list or select stored empty). Outside drawings a script only listens and sets class,
style, hidden, open, disabled, checked, selected, value, tabindex or aria-*. The user can edit
the page's words by hand, so keep to this.

Globals: d3 (v7) and dash:
- dash.data(id) → {status, data, columns, message, refreshing, meta}; status ok, loading,
  connect, declined, error or missing. data is [] until ok (null for a calc). Reading a source
  loads it; while it refreshes it stays ok with the last rows.
- dash.onData(fn): runs now and whenever data, a filter or the width changes.
- dash.calc(id, {inputs, fn, title, description}): a value worked out from datasets (a share, a
  total, a join). Read like a dataset. fn gets each input's rows (a calc input gives its value).
  The user sees fn's text, so name its parameters for what they hold.
- dash.loader(id, {description, fn}): turns an answer that is not rows into rows;
  fn({answer, args}) returns rows, {rows} or {data}. Only reshape here.
- dash.draw(name, fn | {mount, update, unmount}): fills each data-draw="name" after the scripts and
  again on data, filter, page width or element width changes. fn replaces or joins its contents
  and puts "—" back when a status is not ok. dash.draw(name) reruns it.
- dash.colors: series colours as var(--dash-chart-N) strings; set them as styles.
- dash.refresh(id) (never from a drawing), dash.params(), dash.setParams({name: value}),
  dash.resetParams(), dash.setLink(name).

Marks: the smallest element showing a value has data-source="<id>" and data-field="<column>",
plus data-where="col=value" (a=1&amp;b=2 for two) or data-row="0" when it comes from one row. A
number in a sentence gets an element of its own. A chart container lists its source ids
separated by spaces. A table is marked once: data-source and data-row-key="<column>" on the
<table>, data-field on each <th>. Give headings, cards and charts an id: comments and selections
name the nearest id. Every figure, chart and table comes from a dataset or a calc; only a fixed
reference the user chose (a goal) is a constant in the script. A table over a long dataset
draws at most about 200 rows and says how many there are; totals come from calcs over all rows.

States: marks get data-dash-source-state="loading|refreshing|error|empty"; #dash-root gets
data-dash-state. Fade refreshing ones: [data-dash-source-state=refreshing]{opacity:.5}. Class
dash-skeleton paints a placeholder until your drawing removes it. Give a chart box a min-height.
Where a status is error, draw a quiet "没有载入" in the chart's place.

## Look
The page follows the user's light/dark theme through these tokens only:
--dash-fg, --dash-fg-muted, --dash-bg, --dash-panel, --dash-line, --dash-ok, --dash-warn, --dash-bad,
--dash-chart-1…8, --dash-chart-muted, --dash-chart-critical, --dash-chart-grid, --dash-chart-axis,
--dash-chart-reference, --dash-tip-bg, --dash-tip-line, --dash-tip-shadow, --dash-font,
--dash-font-number, --dash-font-mono, --dash-size-caption|body|heading|title (12/14/15/22 px),
--dash-weight-medium, --dash-gap-xs|sm|md|lg|xl, --dash-pad-xs|sm|md|lg|xl, --dash-radius.
Cards: --dash-panel, 1px --dash-line border, --dash-radius, --dash-pad-lg. Style your own classes,
never body, html or bare tags. <select class="dash-select"> is the styled select. Motion only
inside @media (prefers-reduced-motion: no-preference).

## Design defaults
- Under the title, one sentence says what the numbers say now, filled from the data.
- A headline figure shows its signed change and comparison period, coloured by good or bad,
  not by sign. A card says its window ("近 28 天").
- Works at full width and at about 400 px: no fixed widths; size drawings from clientWidth;
  svg width="100%" with a viewBox. Tables wider than the pane scroll in an overflow-x wrapper.
- Every chart that plots values has a tooltip inside the page (absolute in a relative box) and
  prints the values worth reading at a glance. svg role="img" and an aria-label.
- Measure margins from drawn labels (getComputedTextLength) and keep labels apart.
- Format numbers and dates; a date-only string is UTC midnight, so format with d3.utcFormat.
- Lines go point to point. Define a metric in plain words where it first appears.

## Drafts (another shape)
When the user picks another shape under 外观, the view opens a draft (\`draft {shape, files, datasets,
params?}\`) and asks you to fill it. Write the new page with moss_dashboard_write paths
draft/files/<name> (the whole page: the old page's files do not carry over, so copy in each
dash.calc, dash.loader or helper it needs), draft/datasets/<id> only for a source that is new or
whose call changes (it replaces that source), and draft/params to replace all filter defaults.
Keep each calc's id and fn and each dataset's call unless the shape needs otherwise. A story
carries less than a dashboard: start from what it is for and keep what tells it; words that turn
on the data are filled from it. Nothing changes for the user until they press 保存 (the draft
replaces the page) or 取消 (it is dropped). While the draft shows, the view's report describes it
(report.draft is true). A shape the user asks for in chat without a draft replaces the page
directly: say so before you write.

## Check and hand over
After writing, call moss_dashboard_read until the report's revision matches yours, then fix every
fault it lists (scripts that threw, marks that disagree, sources that failed). If no report
comes, nobody has the dashboard open: say so. Hand over in the user's language, briefly: what it
shows, what you assumed, which numbers are sample, that live queries run on the user's own
connector each time it opens (within the refresh window), and what they can do next: ask for any
chart or filter by name, open 数据来源 to see where a number comes from, download a source as
CSV, edit a file or a query there, or comment on the page and send it to Moss.
`;
