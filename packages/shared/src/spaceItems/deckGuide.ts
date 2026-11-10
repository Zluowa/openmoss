// FILE: deckGuide.ts
// Purpose: The short guide agents read (moss_slides_guide) before making or editing a deck:
//          how to plan a good deck and how to drive the moss_slides_* tools.
// Layer: Shared model (served by the agent gateway; also shown in the agent guide docs)

import { LAYOUT_LABELS } from "./deckLayouts";
import { DECK_THEMES } from "./deckThemes";
import { DECK_TEMPLATES } from "./deckTemplates";
import { SLIDE_LAYOUTS } from "./slidesDeck";

export const DECK_AGENT_GUIDE = `# Making Moss decks (幻灯片)

## Plan first
- One idea per slide. A slide's title states its point as a sentence ("1.0.4 修好了登录的三个问题"), not a topic ("登录").
- 6-12 slides for most requests: cover → (agenda) → sections → closing / ask. Group slides into sections (2-5 sections).
- Body text: at most 5 bullets of at most ~20 Chinese characters (or 12 English words) each. Put detail in speaker notes (notes), not on the slide.
- Use a table for comparisons and numbers, a chart (column/bar/line/pie) for trends and shares, two-columns for before/after or pros/cons, quote for one memorable line, image-caption for a screenshot or picture.
- Write in the user's language. Keep names, numbers and dates exact; never invent data — leave a clear placeholder ("[数据待补]") instead.

## Make it
1. moss_slides_create with an outline (preferred), a templateId, or a full deck. The outline picks layouts from content: bullets → 要点, table → 表格, left/right → 两栏, quote → 引用, image → 图片+说明, nothing but a title → 章节.
2. moss_slides_read (format "outline") to check what you made, then fix it with moss_slides_edit.
3. Pictures: generate with moss_media_generate (only when the user asked for generated images), then put the output's path or https URL on a slide with moss_slides_image. Uploads the user made are /api/... paths you can use directly.

## Edit it
- moss_slides_edit takes ordered ops. On a deck someone else touched, edits are filed as one change that the open deck editor applies right away (the person can undo it); say in one sentence what you changed. Only a deck you created in this conversation that nobody has changed since may be edited directly (mode "apply"). If a result lists layoutFaults, fix them (move or resize the boxes) before you answer.
- Address slides and elements by the ids from moss_slides_read. Change words with {op:"set-text"}; restyle with {op:"update-element", set:{...}}; replace a slide's content with {op:"update-slide", content:{...}}.
- When the user points at "this slide" or a selection, the request names the slide and element ids it is about (target). Change only those unless asked.

## Look
- Stage is 1920×1080 px. Keep 128 px outer margins; align left edges; at least 48 px between blocks.
- Colors: use theme references ("@accent", "@text", "@muted", "@inverse.background") instead of hex so theme changes recolor the deck. One accent color per slide.
- Text styles: display 96 (cover), title 72, heading 48, subheading 36, body 28, caption 20, label 18. Don't go below 20 on a slide.
- Dark statement slides: background "@inverse.background" with text "@inverse.text".

## Reference
Layouts: ${SLIDE_LAYOUTS.map((id) => `${id} (${LAYOUT_LABELS[id].zh})`).join(", ")}.
Themes: ${DECK_THEMES.map((entry) => `${entry.id} (${entry.theme.name})`).join(", ")}.
Templates: ${DECK_TEMPLATES.map((t) => `${t.id} (${t.title})`).join(", ")}.
Ops: add-slide {layout?, index?, sectionId?, content?, notes?} · update-slide {slideId, set:{background?, transition?, hidden?, notes?, sectionId?, layout?}, content?} · delete-slide {slideId} · move-slide {slideId, index} · duplicate-slide {slideId} · add-element {slideId, element, index?} · update-element {slideId, elementId, set} · delete-element {slideId, elementId} · reorder-element {slideId, elementId, index} · set-text {slideId, elementId, text} · apply-theme {theme: id or fields, restyle?} · upsert-section {section:{id,title}, index?} · delete-section {sectionId} · set-cover {slideId}. Skip a slide in present mode: update-slide set:{hidden:true}.
Content fields: title, subtitle, body, bullets[], left, right, leftTitle, rightTitle, quote, attribution, image, imageAlt, caption, table[][], eyebrow.
Elements: text {x,y,w,h, role?, text or body:{paragraphs:[{runs:[{text,bold?,color?}], list?, level?}], style, size?, color?, align, vAlign, autofit}} · image {src, fit, crop?} · shape {shape: rect|roundRect|ellipse|diamond|triangle|arrowRight|arrowLeft|arrowUp|arrowDown, fill, text?} · line {points:[{x,y},{x,y}], stroke:{color,width}, endArrow?} · table {rows:[[...cells]], header?, banded?} · chart {kind: column|bar|line|pie|donut, labels[], series:[{name, values[]}], showValues?}. Common: fill, border, radius, shadow, opacity, rotation.
`;
