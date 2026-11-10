// FILE: pageAppAuthorGuide.ts
// Purpose: What an agent needs to write a working 应用页 (runnable HTML page
// in the user's 资料空间): the runtime API `moss.use()` and its rules.
// Served by the `moss_app_guide` tool; the harness policy points to it.
// Layer: Server agent gateway

export const PAGE_APP_AUTHOR_GUIDE = `# Writing a Moss 应用页 (runnable page)

An 应用页 is one self-contained HTML document that Moss stores in the user's 资料空间, versions (newest 100 kept) and runs in an isolated, sandboxed frame. Publish it with moss_app_publish.

## The sandbox
- No network: fetch, XHR, WebSocket, EventSource and beacons are blocked (CSP connect-src 'none'). Never call an external API; use the capabilities below.
- Scripts and styles may load only from https://cdn.jsdelivr.net, https://cdnjs.cloudflare.com and https://unpkg.com (pin exact versions). Prefer inline code. Fonts: Google Fonts or data: URIs. Images: data: or blob: URLs only.
- Offline classic libraries: use exactly https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js or https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.js in ordinary synchronous script tags. Moss supplies its hash-checked local copy with the upstream license. Do not add async/defer/onload/onerror/integrity to these tags if offline use is required.
- Offline modules: inside an inline script type="module", use static imports from https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm, https://cdn.jsdelivr.net/npm/chart.js@4.5.1/+esm, or https://cdn.jsdelivr.net/npm/three@0.182.0/build/three.module.js. Moss installs a local blob import map before page scripts. Do not supply your own import map or use dynamic imports/import attributes when offline operation is required.
- Offline fonts: active style blocks may use the exact URL https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.2.8/files/inter-latin-wght-normal.woff2 or https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.2.8/files/jetbrains-mono-latin-wght-normal.woff2 in url(...). These are Latin variable normal files; keep your font-family/weight/style declarations. Google Fonts CSS, other subsets/styles, unknown versions, unsupported module forms and missing local assets remain explicitly non-offline. Moss never substitutes another version or font family.
- No iframes, no form submission to URLs, no top navigation. localStorage works but is per page and per device; use db for anything that must persist reliably.
- Moss shows the title and an "AI generated" byline above the page. Do not draw your own app chrome or fake Moss UI.

## Declaring capabilities
Pass capabilities to moss_app_publish (they are also written into the page as <script type="application/json" id="moss-app-manifest">). Only declared capabilities are served:
  { "db": {}, "ai": {}, "downloads": {}, "user": {}, "page": {} }
The first use of db or ai asks the viewer once per page; downloads asks on every save. "permissions" is always available.

## moss.use(name)
  const db = await moss.use("db");   // namespace, or null when not available here
Always design for null: render the page without the capability, then light features up. use() never prompts; the first call does. Calls reject with { code, message }; branch on code:
  invalid_argument, not_declared, not_granted, unavailable, resource_exhausted, quota_exceeded, revoked, authentication_required, upstream_error, cancelled.

## db — documents shared by everyone who opens the page
- Paths alternate collection/document: db.collection("tasks"), db.doc("tasks/t1"), db.doc("boards/b1").collection("cards").
- doc.get() → snapshot {exists, id, data(), get(field)}; doc.set(obj) replaces; doc.update(obj) deep-merges and needs the doc to exist; doc.delete().
- collection.add(obj) → ref with a fresh id; collection.doc() mints an id.
- Queries: collection.where(field, op, value).orderBy(field, "asc"|"desc").limit(n).get(). Ops: == != < <= > >= in not-in array-contains (≤10 filters, ≤1000 results, top-level fields).
- Live: const stop = ref.onSnapshot(snap => render(snap), err => showError(err)); query snapshots have docs, size, empty, docChanges(). Subscribe once (on start), never inside render; keep stop().
- doc.acquire({ ttlMs }) → {acquired, expiresAt}: a short cooperative lease for one-at-a-time work.
- Bodies are JSON objects ≤256 KiB, ≤32 levels. A page holds at most 10,000 documents: aggregate streams of small items. quota_exceeded means delete first.
- Writes are last-writer-wins; write on real user actions, not from render or timers.
- Access rules (optional): { "db": { "rules": [ { "path": "", "read": "view", "write": "interact" } ] } }. Levels: view < interact < admin < owner, plus "self" (nobody; for the prefix of a {self} rule). A rule covers its path and below; the deepest rule wins. "P/{self}" is each viewer's own subtree under P. data/users/<viewerId>/ is private to that viewer by default.

## ai — ask a model through the user's Moss account
  const ai = await moss.use("ai");
  const { text } = await ai.ask("Summarize: " + notes, { onText: (delta, full) => show(full), system: "...", maxTokens: 800, tier: "quick"|"default"|"complex", signal });
  const value = await ai.json("Return [{title, minutes}] for: " + input);   // parsed JSON
Each call is memoryless: send the context it needs. It spends the user's credits; call it on user actions, not on load. authentication_required means the viewer is not signed in to Moss.

## downloads — hand the viewer a file
  const dl = await moss.use("downloads");
  const { saved } = await dl.save({ data: csvString | Blob | ArrayBuffer, filename: "report.csv", mimeType: "text/csv" });
Moss shows the file name and size and asks first; saved is false when they cancel.

## user — who is viewing
  const user = await moss.use("user");  await user.me() → {id, name, level, isOwner}; user.can("data.write") → true/false/null; user.canEdit().

## permissions
  const p = await moss.use("permissions");  await p.state() → {db: "granted"|"prompt"|"denied"|"unavailable", ...}; await p.request(["db","ai"]) asks in one dialog; p.manage() opens the page's permissions panel (on a button click only).

## page — the page itself
  const page = await moss.use("page");  await page.metadata() → {id, title, revision, ...}; await page.publish(fullHtml) saves a new version after the viewer confirms.

## Checklist
- One complete <!doctype html> file with <title>, viewport meta, readable empty/loading/error states and both light and dark friendly colors.
- Render first, then await moss.use(); handle null and every rejection code you can hit.
- Keep the db schema small and documented in a comment at the top of the script.
- After publishing, tell the user the page's title and that it is in 资料空间 → 应用页 (link /apps/<id>).
`;
