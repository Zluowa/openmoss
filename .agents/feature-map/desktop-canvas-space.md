# Feature Map: Desktop Canvas & Data Space

**Primary Owners:** `moss-desktop-core`, `moss-qa-eval`
**Core Sources:** `apps/web/src/components/space/**`, `apps/web/src/components/spaceTypes/**`, `apps/web/src/components/pages/**`, `apps/web/src/components/pageApps/**`, `apps/server/src/pages/**`, `apps/desktop/src/mossCanvas*.ts`, `scripts/lib/moss-canvas-source-pin.json`

## User-Perspective Journeys & Proof Criteria

1. **Right-Dock Canvas Lifecycle & Toolbar Parity**
   - _User path:_ Open Canvas in an unsent or active chat, draw/add sticky notes, press `Ctrl+Y` to redo, and select shapes at 401px–415px dock width.
   - _Proof criteria:_ Canvas bundle loads at pinned commit with zero license watermark, 401px floating bar wraps without clipping `锁定`, selection chip appears compactly without enabling empty send, and `RightDockCanvas.browser.tsx` passes.
2. **Data Space Library & Document Header**
   - _User path:_ Browse Data Space, upload files, open a document (`文档`), and use title/action menus.
   - _Proof criteria:_ Unified `文档` terminology (never `页面` for the item), `MossDataSpaceDestination.browser.tsx` and `MossDataSpaceBoardStability.browser.tsx` pass, and upload/preview flows work without layout collapse.
3. **Slides & Deck Editor**
   - _User path:_ Create or open a presentation, switch/edit slides, enter presenter view, and export `.pptx`.
   - _Proof criteria:_ `migrateDeckV1` preserves shorthand slide elements, `deck-editor.html` renders zero `"Get a license for production"` watermark, and controls use shared `ui/*` primitives.
4. **Sheets, Dashboards & App Pages**
   - _User path:_ Open spreadsheet (`电子表格`), dashboard (`数据看板`), or interactive app page (`应用页`), evaluate formulas, and edit controls.
   - _Proof criteria:_ Formula evaluator computes cleanly, `ReadonlyAppItemFrame.browser.tsx` reaches `ready` without flake, and guest share pages (`/s/`, `/p/`) render safely.
5. **RightDock Width & Tab Residency**
   - _User path:_ Navigate from Canvas/Space to full-width routes (Images/Settings/Tasks) and return to chat.
   - _Proof criteria:_ `RightDock` re-measures width cleanly on return and `关闭画布` / tab close labels match `zh-CN-product-glossary.md`.
