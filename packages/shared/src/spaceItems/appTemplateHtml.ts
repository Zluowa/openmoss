// FILE: appTemplateHtml.ts
// Purpose: HTML bodies of the built-in 仪表盘 templates (KPI dashboard, tracker, poll/sign-up).
// Layer: Shared model (template data; apps-runtime serves the page in its isolated frame)
// Why: Each template is a self-contained 应用页 that declares the capabilities it uses. The
//      `mossStore` adapter is the one place that talks to the runtime's `db` capability, and it
//      keeps the page usable (in-page memory) when the capability is missing or was declined.

const BASE_STYLE = `
:root{color-scheme:light dark;--bg:#fbfbfa;--panel:#ffffff;--ink:#1f1f1e;--muted:#6b6a66;--line:#e6e4df;--accent:#2f6f5e;--soft:#eef4f1;--warn:#a1572b}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1b;--panel:#242423;--ink:#ecebe8;--muted:#a3a19b;--line:#3a3936;--accent:#7cc0a8;--soft:#263330;--warn:#e0a27a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.5 Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
main{max-width:1080px;margin:0 auto;padding:20px 16px 32px}h1{font-size:18px;font-weight:600;margin:0}
.sub{color:var(--muted);margin:2px 0 16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
button,input,select{font:inherit;color:inherit}button{border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:4px 10px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}input,select{border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:4px 8px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.notice{color:var(--muted);font-size:12px;margin-top:12px}
`;

/**
 * Thin adapter over the runtime's `db` capability (`await moss.use("db")`, Firestore-like
 * collection/doc refs with onSnapshot) with an in-page fallback when it is missing or declined.
 */
const STORE_SCRIPT = `
const mossStore = (() => {
  const memory = new Map();
  const listeners = new Map();
  const list = (name) => [...(memory.get(name) || new Map()).values()];
  const emit = (name) => (listeners.get(name) || []).forEach((cb) => cb(list(name)));
  const fallback = {
    shared: false,
    subscribe(name, cb) {
      listeners.set(name, [...(listeners.get(name) || []), cb]); cb(list(name));
      return () => listeners.set(name, (listeners.get(name) || []).filter((x) => x !== cb));
    },
    put(name, id, doc) {
      const items = memory.get(name) || new Map();
      items.set(id, { id, ...doc }); memory.set(name, items); emit(name); return Promise.resolve();
    },
    remove(name, id) { (memory.get(name) || new Map()).delete(id); emit(name); return Promise.resolve(); },
  };
  const runtime = typeof window.moss === "object" && window.moss && typeof window.moss.use === "function"
    ? Promise.resolve(window.moss.use("db")).catch(() => null) : Promise.resolve(null);
  const store = {
    shared: false,
    ready: runtime.then((db) => { store.shared = !!db; return db; }),
    subscribe(name, cb) {
      let cancel = () => {};
      store.ready.then((db) => {
        if (!db) { cancel = fallback.subscribe(name, cb); return; }
        cancel = db.collection(name).onSnapshot(
          (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))),
          () => { cancel = fallback.subscribe(name, cb); },
        );
      });
      return () => cancel();
    },
    put(name, id, doc) { return store.ready.then((db) => db ? db.collection(name).doc(id).set(doc) : fallback.put(name, id, doc)); },
    remove(name, id) { return store.ready.then((db) => db ? db.collection(name).doc(id).delete() : fallback.remove(name, id)); },
  };
  return store;
})();
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const storeNotice = () => mossStore.shared ? "" : "<p class=\\"notice\\">数据只保存在本次打开的页面里。允许“数据”能力后会自动保存并与协作者共享。</p>";
`;

/** The manifest block apps-runtime reads (`moss-app-manifest`) travels inside the HTML. */
const page = (
  title: string,
  style: string,
  body: string,
  script: string,
  capabilities: readonly string[],
) =>
  `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script type="application/json" id="moss-app-manifest">${JSON.stringify({
    title,
    capabilities: Object.fromEntries(capabilities.map((name) => [name, {}])),
  })}</script>
<style>${BASE_STYLE}${style}</style>
</head>
<body>
${body}
<script>
${STORE_SCRIPT}
${script}
</script>
</body>
</html>
`;

export const KPI_DASHBOARD_HTML = page(
  "KPI 仪表盘",
  `.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:12px}
.tile .label{color:var(--muted);font-size:12px}.tile .value{font-size:24px;font-weight:600;margin-top:4px}
.delta{font-size:12px;margin-top:2px}.up{color:var(--accent)}.down{color:var(--warn)}
.chart svg{width:100%;height:220px;display:block}.chart text{fill:var(--muted);font-size:11px}
table{width:100%;border-collapse:collapse;margin-top:8px}td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left}td input{width:100%}`,
  `<main>
  <div class="row" style="justify-content:space-between"><div><h1>KPI 仪表盘</h1><p class="sub">本月关键指标与 6 个月趋势</p></div>
  <button id="edit">编辑数据</button></div>
  <section class="tiles" id="tiles"></section>
  <section class="panel chart"><div class="label" style="color:var(--muted)">月度收入（万元）</div><div id="chart"></div></section>
  <section class="panel" id="editor" hidden style="margin-top:12px"></section>
  <div id="notice"></div>
</main>`,
  `const SEED = [
  { id: "revenue", label: "收入（万元）", value: 128, previous: 112, order: 1 },
  { id: "users", label: "活跃用户", value: 8420, previous: 7900, order: 2 },
  { id: "conversion", label: "转化率 %", value: 3.6, previous: 3.9, order: 3 },
  { id: "nps", label: "NPS", value: 46, previous: 41, order: 4 },
];
const TREND = [86, 94, 101, 108, 112, 128];
let metrics = [];
let editing = false;
function render() {
  const items = (metrics.length ? metrics : SEED).slice().sort((a, b) => a.order - b.order);
  document.getElementById("tiles").innerHTML = items.map((m) => {
    const delta = m.previous ? ((m.value - m.previous) / m.previous) * 100 : 0;
    return '<div class="panel tile"><div class="label">' + escapeHtml(m.label) + '</div><div class="value">' +
      Number(m.value).toLocaleString("zh-CN") + '</div><div class="delta ' + (delta >= 0 ? "up" : "down") + '">' +
      (delta >= 0 ? "▲ " : "▼ ") + Math.abs(delta).toFixed(1) + "% 较上月</div></div>";
  }).join("");
  const max = Math.max(...TREND) * 1.15, w = 600, h = 220, bw = w / TREND.length;
  const months = ["5月", "6月", "7月", "8月", "9月", "10月"];
  document.getElementById("chart").innerHTML = '<svg viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="月度收入">' +
    TREND.map((v, i) => { const bh = (v / max) * (h - 30); return '<rect x="' + (i * bw + bw * 0.2) + '" y="' + (h - 20 - bh) +
      '" width="' + bw * 0.6 + '" height="' + bh + '" rx="3" fill="var(--accent)" opacity="' + (i === TREND.length - 1 ? 1 : 0.55) +
      '"/><text x="' + (i * bw + bw / 2) + '" y="' + (h - 4) + '" text-anchor="middle">' + months[i] + "</text>"; }).join("") + "</svg>";
  const editor = document.getElementById("editor");
  editor.hidden = !editing;
  if (editing) editor.innerHTML = "<table><tr><th>指标</th><th>本月</th><th>上月</th></tr>" + items.map((m) =>
    '<tr><td><input data-id="' + m.id + '" data-field="label" value="' + escapeHtml(m.label) + '"></td><td><input type="number" data-id="' + m.id +
    '" data-field="value" value="' + m.value + '"></td><td><input type="number" data-id="' + m.id + '" data-field="previous" value="' + m.previous + '"></td></tr>').join("") + "</table>";
  document.getElementById("notice").innerHTML = storeNotice();
}
document.getElementById("edit").onclick = () => { editing = !editing; document.getElementById("edit").textContent = editing ? "完成" : "编辑数据"; render(); };
document.getElementById("editor").addEventListener("change", (event) => {
  const input = event.target; const id = input.dataset.id; if (!id) return;
  const base = (metrics.length ? metrics : SEED).find((m) => m.id === id);
  const field = input.dataset.field;
  const next = { ...base, [field]: field === "label" ? input.value : Number(input.value) };
  delete next.id;
  if (!metrics.length) SEED.filter((m) => m.id !== id).forEach((m) => { const { id: key, ...doc } = m; mossStore.put("metrics", key, doc); });
  mossStore.put("metrics", id, next);
});
mossStore.subscribe("metrics", (docs) => { metrics = docs; render(); });
render();`,
  ["db"],
);

export const TRACKER_HTML = page(
  "任务跟踪表",
  `table{width:100%;border-collapse:collapse}th{color:var(--muted);font-weight:500;font-size:12px;text-align:left}
td,th{border-bottom:1px solid var(--line);padding:6px 8px}tr:hover td{background:var(--soft)}
.pill{display:inline-block;border-radius:999px;padding:0 8px;font-size:12px;border:1px solid var(--line)}
.pill.done{background:var(--soft);color:var(--accent);border-color:transparent}.count{color:var(--muted);margin-left:auto}
form.row{margin-bottom:12px}form input[name=title]{flex:1;min-width:180px}`,
  `<main>
  <h1>任务跟踪表</h1><p class="sub">记录事项、负责人、状态和截止日期</p>
  <form class="row" id="add"><input name="title" placeholder="新事项" required maxlength="200"><input name="owner" placeholder="负责人" maxlength="40">
  <input name="due" type="date"><button class="primary" type="submit">添加</button></form>
  <div class="row" style="margin-bottom:8px"><label>状态 <select id="filter"><option value="">全部</option><option>未开始</option><option>进行中</option><option>已完成</option></select></label><span class="count" id="count"></span></div>
  <div class="panel" style="padding:0"><table><thead><tr><th>事项</th><th>负责人</th><th>状态</th><th>截止</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
  <div id="notice"></div>
</main>`,
  `const STATUSES = ["未开始", "进行中", "已完成"];
let items = [];
function render() {
  const filter = document.getElementById("filter").value;
  const shown = items.filter((i) => !filter || i.status === filter).sort((a, b) => String(a.due || "9").localeCompare(String(b.due || "9")));
  document.getElementById("rows").innerHTML = shown.length ? shown.map((i) => "<tr><td>" + escapeHtml(i.title) + "</td><td>" + escapeHtml(i.owner || "—") +
    '</td><td><select data-id="' + i.id + '">' + STATUSES.map((s) => "<option" + (s === i.status ? " selected" : "") + ">" + s + "</option>").join("") +
    "</select></td><td>" + escapeHtml(i.due || "—") + '</td><td><button data-remove="' + i.id + '" aria-label="删除">×</button></td></tr>').join("")
    : '<tr><td colspan="5" style="color:var(--muted)">还没有事项</td></tr>';
  const done = items.filter((i) => i.status === "已完成").length;
  document.getElementById("count").textContent = "共 " + items.length + " 项 · 已完成 " + done;
  document.getElementById("notice").innerHTML = storeNotice();
}
document.getElementById("add").onsubmit = (event) => {
  event.preventDefault(); const form = new FormData(event.target);
  mossStore.put("items", newId(), { title: String(form.get("title")).trim(), owner: String(form.get("owner") || "").trim(), due: String(form.get("due") || ""), status: "未开始", createdAt: new Date().toISOString() });
  event.target.reset();
};
document.getElementById("rows").addEventListener("change", (event) => {
  const id = event.target.dataset.id; const item = items.find((i) => i.id === id); if (!item) return;
  const { id: key, ...doc } = item; mossStore.put("items", key, { ...doc, status: event.target.value });
});
document.getElementById("rows").addEventListener("click", (event) => { const id = event.target.dataset.remove; if (id) mossStore.remove("items", id); });
document.getElementById("filter").onchange = render;
mossStore.subscribe("items", (docs) => { items = docs; render(); });`,
  ["db"],
);

export const POLL_SIGNUP_HTML = page(
  "投票与报名",
  `.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}h2{font-size:14px;margin:0 0 8px}
.option{display:flex;align-items:center;gap:8px;margin:6px 0}.bar{flex:1;height:8px;border-radius:4px;background:var(--soft);overflow:hidden}
.bar span{display:block;height:100%;background:var(--accent)}.option button{min-width:72px}.votes{color:var(--muted);width:48px;text-align:right}
ul{list-style:none;padding:0;margin:8px 0 0}li{border-bottom:1px solid var(--line);padding:4px 0;display:flex;justify-content:space-between}li span{color:var(--muted)}`,
  `<main>
  <h1>团队活动：投票与报名</h1><p class="sub">选出活动时间，并登记参加人数</p>
  <div class="grid">
    <section class="panel"><h2>哪天最合适？</h2><div id="options"></div></section>
    <section class="panel"><h2>报名参加</h2>
      <form class="row" id="signup"><input name="name" placeholder="你的名字" required maxlength="40"><input name="guests" type="number" min="0" max="5" value="0" style="width:64px" aria-label="同行人数"><button class="primary">报名</button></form>
      <ul id="list"></ul></section>
  </div>
  <div id="notice"></div>
</main>`,
  `const OPTIONS = ["周五晚上", "周六下午", "周日上午"];
let voterId = localVoter();
function localVoter() { try { let v = localStorage.getItem("moss-poll-voter"); if (!v) { v = newId(); localStorage.setItem("moss-poll-voter", v); } return v; } catch { return newId(); } }
// With the 用户 capability each signed-in viewer votes once under their own id.
if (window.moss && typeof window.moss.use === "function") {
  Promise.resolve(window.moss.use("user")).then((user) => user ? user.id() : null).then((id) => { if (id) { voterId = String(id); render(); } }).catch(() => {});
}
let votes = [], signups = [];
function render() {
  const total = votes.length || 1;
  const mine = votes.find((v) => v.id === voterId);
  document.getElementById("options").innerHTML = OPTIONS.map((o) => { const n = votes.filter((v) => v.choice === o).length;
    return '<div class="option"><button data-choice="' + escapeHtml(o) + '"' + (mine && mine.choice === o ? ' class="primary"' : "") + ">" + escapeHtml(o) +
      '</button><div class="bar"><span style="width:' + (n / total) * 100 + '%"></span></div><span class="votes">' + n + " 票</span></div>"; }).join("");
  const people = signups.reduce((sum, s) => sum + 1 + Number(s.guests || 0), 0);
  document.getElementById("list").innerHTML = signups.map((s) => "<li>" + escapeHtml(s.name) + "<span>" + (Number(s.guests) ? "+" + Number(s.guests) : "") + "</span></li>").join("") +
    '<li style="border:0"><strong>合计</strong><span>' + people + " 人</span></li>";
  document.getElementById("notice").innerHTML = storeNotice();
}
document.getElementById("options").addEventListener("click", (event) => { const choice = event.target.dataset.choice; if (choice) mossStore.put("votes", voterId, { choice, at: new Date().toISOString() }); });
document.getElementById("signup").onsubmit = (event) => { event.preventDefault(); const form = new FormData(event.target);
  mossStore.put("signups", newId(), { name: String(form.get("name")).trim(), guests: Number(form.get("guests") || 0), at: new Date().toISOString() }); event.target.reset(); };
mossStore.subscribe("votes", (docs) => { votes = docs; render(); });
mossStore.subscribe("signups", (docs) => { signups = docs; render(); });`,
  ["db", "user"],
);
