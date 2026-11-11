// FILE: fixtures.ts
// Purpose: Synthetic loopback web tasks for measuring Moss's browser_* tools.
// Every answer is random per run and only readable from the page, so a model
// cannot pass from memory, and the page records what it received so checks
// grade the effect, not the reply's wording.
// Layer: Desktop browser task eval (development tool, not shipped)
// Exports: TASKS, startFixtureSite, FixtureTask, FixtureRun, FixtureSite
//
// The scenario mix follows the public multi-step browser eval in
// makecindy/cindy (scripts/eval-browser-tasks.mjs, Apache-2.0) so results can
// be compared with theirs; pages and checks are written for Moss.

import { randomBytes, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { WebSocketServer } from "ws";

export type TaskFocus = "sequence" | "shadow" | "control";

export interface FixtureTask {
  readonly id: string;
  readonly focus: TaskFocus;
  readonly prompt: (run: FixtureRun, base: string) => string;
  /** Grade the page-recorded effect plus the final reply. */
  readonly check: (run: FixtureRun, reply: string) => boolean;
}

const PRODUCTS = [
  "Alpha Lamp",
  "Birch Stool",
  "Cobalt Desk",
  "Dune Rug",
  "Echo Chair",
  "Fern Planter",
  "Garnet Shelf",
  "Harbor Clock",
] as const;
const PEOPLE = [
  "Abara",
  "Bianchi",
  "Castillo",
  "Dvorak",
  "Eriksen",
  "Fontaine",
  "Gupta",
  "Haddad",
  "Ivanov",
  "Jensen",
  "Kowalski",
  "Lindqvist",
  "Moreau",
  "Nakamura",
  "Okafor",
  "Petrov",
  "Quintero",
  "Rossi",
  "Sato",
  "Tanaka",
] as const;

const token = (prefix: string) => `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;

export interface FixtureRun {
  readonly id: string;
  readonly form: { note: string; code: string; submitted: Record<string, string> | null };
  readonly skus: Record<string, string>;
  readonly orders: ReadonlyArray<{ id: string; amount: string; status: string }>;
  readonly vault: string;
  readonly badge: {
    employee: string;
    pin: string;
    code: string;
    submitted: Record<string, string> | null;
  };
  readonly report: string;
  readonly settings: { receipt: string; saved: Record<string, unknown> | null };
  readonly support: string;
  readonly extensions: Record<string, string>;
  /** A background tab's long-lived traffic, for connection-isolation checks. */
  readonly live: {
    socketsOpened: number;
    socketsClosed: number;
    slowServed: number;
    lateStarted: number;
    lateServed: number;
  };
}

function newRunState(): FixtureRun {
  const refundedIndex = 18 + randomInt(6); // Always on page 4 of 5.
  return {
    id: randomBytes(6).toString("hex"),
    form: { note: token("NOTE"), code: token("CONF"), submitted: null },
    skus: Object.fromEntries(PRODUCTS.map((name) => [name, token("SKU")])),
    orders: Array.from({ length: 30 }, (_, index) => ({
      id: token("ORD"),
      amount: `${randomInt(20, 900)}.${String(randomInt(100)).padStart(2, "0")}`,
      status:
        index === refundedIndex ? "REFUNDED" : (["PAID", "SHIPPED", "PENDING"][index % 3] ?? ""),
    })),
    vault: token("VAULT"),
    badge: {
      employee: `E-${randomInt(10000, 99999)}`,
      pin: String(randomInt(1000, 9999)),
      code: token("BADGE"),
      submitted: null,
    },
    report: `${randomInt(10, 99)},${String(randomInt(1000)).padStart(3, "0")}`,
    settings: { receipt: token("RCPT"), saved: null },
    support: token("SUP"),
    extensions: Object.fromEntries(PEOPLE.map((name) => [name, String(randomInt(2000, 9999))])),
    live: { socketsOpened: 0, socketsClosed: 0, slowServed: 0, lateStarted: 0, lateServed: 0 },
  };
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui;margin:32px;max-width:760px}label{display:block;margin:10px 0}input,select,textarea,button{font:inherit;padding:6px}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 10px}[hidden]{display:none}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;

const has = (reply: string, value: string) => reply.includes(value);

export const TASKS: readonly FixtureTask[] = [
  {
    id: "form",
    focus: "sequence",
    prompt: (run, base) =>
      `打开 ${base}/form?run=${run.id} ，用下面的信息填表并提交：姓名 Ada Lovelace，邮箱 ada@example.test，套餐 Team，席位 7，地区 APAC，勾选订阅产品更新，备注填 ${run.form.note}。然后告诉我提交后页面显示的确认码。`,
    check: (run, reply) => {
      const s = run.form.submitted;
      return (
        s !== null &&
        s.name === "Ada Lovelace" &&
        s.email === "ada@example.test" &&
        s.plan === "Team" &&
        s.seats === "7" &&
        s.region === "APAC" &&
        s.newsletter === "yes" &&
        s.notes === run.form.note &&
        has(reply, run.form.code)
      );
    },
  },
  {
    id: "catalog",
    focus: "sequence",
    prompt: (run, base) =>
      `打开 ${base}/catalog?run=${run.id} ，查出 Alpha Lamp、Cobalt Desk、Echo Chair、Garnet Shelf 这四件商品各自的 SKU（SKU 只在商品详情页上），列给我。`,
    check: (run, reply) =>
      ["Alpha Lamp", "Cobalt Desk", "Echo Chair", "Garnet Shelf"].every((name) =>
        has(reply, run.skus[name] ?? "\u0000"),
      ),
  },
  {
    id: "orders",
    focus: "sequence",
    prompt: (run, base) =>
      `打开 ${base}/orders?run=${run.id} ，订单表分 5 页。找出状态是 REFUNDED 的那一单，告诉我订单号和金额。`,
    check: (run, reply) => {
      const order = run.orders.find((entry) => entry.status === "REFUNDED");
      return order !== undefined && has(reply, order.id) && has(reply, order.amount);
    },
  },
  {
    id: "report",
    focus: "sequence",
    prompt: (run, base) =>
      `打开 ${base}/report?run=${run.id} ，生成报告，告诉我报告里的 Total 是多少。`,
    check: (run, reply) => has(reply, run.report),
  },
  {
    id: "settings",
    focus: "sequence",
    prompt: (run, base) =>
      `打开 ${base}/settings?run=${run.id} ，从 More 菜单进入通知设置：关掉 Email notifications，打开 Weekly digest，Frequency 改成 Monthly，保存。告诉我保存后显示的回执号。`,
    check: (run, reply) => {
      const s = run.settings.saved;
      return (
        s !== null &&
        s.email === false &&
        s.digest === true &&
        s.sms === false &&
        s.frequency === "Monthly" &&
        has(reply, run.settings.receipt)
      );
    },
  },
  {
    id: "vault",
    focus: "shadow",
    prompt: (run, base) =>
      `打开 ${base}/vault?run=${run.id} ，按页面上的按钮显示访问码，告诉我访问码是多少。`,
    check: (run, reply) => has(reply, run.vault),
  },
  {
    id: "badge",
    focus: "shadow",
    prompt: (run, base) =>
      `打开 ${base}/badge?run=${run.id} ，在页面的面板里把 Employee ID 填成 ${run.badge.employee}、Door PIN 填成 ${run.badge.pin}，点 Issue badge，告诉我页面显示的 badge 编号。`,
    check: (run, reply) =>
      run.badge.submitted?.employee === run.badge.employee &&
      run.badge.submitted?.pin === run.badge.pin &&
      has(reply, run.badge.code),
  },
  {
    id: "iframe",
    focus: "control",
    prompt: (run, base) =>
      `打开 ${base}/embed?run=${run.id} ，页面里嵌入的支持面板显示的支持码是多少？`,
    check: (run, reply) => has(reply, run.support),
  },
  {
    id: "directory",
    focus: "control",
    prompt: (run, base) =>
      `打开 ${base}/directory?run=${run.id} ，在通讯录里搜索 Okafor，告诉我这个人的分机号。`,
    check: (run, reply) => has(reply, run.extensions.Okafor ?? "\u0000"),
  },
];

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
    });
    request.on("end", () => resolve(data));
  });
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface FixtureSite {
  readonly base: string;
  newRun(): FixtureRun;
  getRun(id: string): FixtureRun | undefined;
  dropRun(id: string): void;
  close(): Promise<void>;
}

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    }),
  );

/** Starts the main site plus a second origin for the cross-origin iframe task. */
export async function startFixtureSite(): Promise<FixtureSite> {
  const runs = new Map<string, FixtureRun>();
  let framePort = 0;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fixture");
    const run = runs.get(url.searchParams.get("run") ?? "");
    const send = (body: string, type = "text/html; charset=utf-8", status = 200) => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      response.end(body);
    };
    if (!run) return send("unknown run", "text/plain", 404);
    const q = `run=${run.id}`;
    switch (url.pathname) {
      case "/form":
        return send(
          page(
            "Create account",
            `<form method="post" action="/form/submit?${q}">
<label>Full name <input name="name" required></label>
<label>Email <input name="email" type="email" required></label>
<label>Plan <select name="plan"><option value="">Choose…</option><option>Basic</option><option>Pro</option><option>Team</option></select></label>
<label>Seats <input name="seats" type="number" min="1" value="1"></label>
<fieldset><legend>Region</legend>${["EU", "US", "APAC"].map((region) => `<label><input type="radio" name="region" value="${region}"> ${region}</label>`).join("")}</fieldset>
<label><input type="checkbox" name="newsletter" value="yes"> Subscribe to product updates</label>
<label>Notes <textarea name="notes" rows="2"></textarea></label>
<button type="submit">Create account</button></form>`,
          ),
        );
      case "/form/submit": {
        run.form.submitted = Object.fromEntries(new URLSearchParams(await readBody(request)));
        return send(
          page(
            "Account created",
            `<p>Thanks, ${run.form.submitted.name ?? ""}. Your confirmation code is <strong>${run.form.code}</strong>.</p>`,
          ),
        );
      }
      case "/catalog":
        return send(
          page(
            "Catalog",
            `<ul>${PRODUCTS.map((name, index) => `<li><a href="/product?${q}&p=${index}">${name}</a></li>`).join("")}</ul>`,
          ),
        );
      case "/product": {
        const name = PRODUCTS[Number(url.searchParams.get("p"))];
        if (!name) return send("no such product", "text/plain", 404);
        return send(
          page(
            name,
            `<dl><dt>SKU</dt><dd id="sku">${run.skus[name]}</dd><dt>Stock</dt><dd>${randomInt(1, 60)} units</dd></dl><p><a href="/catalog?${q}">Back to catalog</a></p>`,
          ),
        );
      }
      case "/orders":
        return send(
          page(
            "Orders",
            `<table><thead><tr><th>Order</th><th>Amount</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table>
<p><button id="prev">Previous</button> <span id="where" role="status"></span> <button id="next">Next</button></p>
<script>let n=1;async function load(){const r=await fetch('/orders/data?${q}&page='+n);const rows=await r.json();
document.getElementById('rows').innerHTML=rows.map(o=>'<tr><td>'+o.id+'</td><td>'+o.amount+'</td><td>'+o.status+'</td></tr>').join('');
document.getElementById('where').textContent='Page '+n+' of 5';}
document.getElementById('next').onclick=()=>{if(n<5){n++;load();}};document.getElementById('prev').onclick=()=>{if(n>1){n--;load();}};load();</script>`,
          ),
        );
      case "/orders/data": {
        const pageNo = Math.max(1, Math.min(5, Number(url.searchParams.get("page")) || 1));
        return send(
          JSON.stringify(run.orders.slice((pageNo - 1) * 6, pageNo * 6)),
          "application/json",
        );
      }
      case "/vault":
        return send(
          page(
            "Vault",
            `<p>The access code is shown after pressing the button in the panel below.</p><vault-box></vault-box><script src="/vault.js?${q}"></script>`,
          ),
        );
      case "/vault.js":
        return send(
          `customElements.define('vault-box', class extends HTMLElement { connectedCallback() {
  const root = this.attachShadow({ mode: 'closed' });
  root.innerHTML = '<div style="border:1px solid #999;padding:16px"><button type="button">Reveal access code</button><p role="status"></p></div>';
  root.querySelector('button').addEventListener('click', async (event) => {
    if (!event.isTrusted) return;
    const reply = await fetch('/vault/code?${q}', { method: 'POST' });
    root.querySelector('p').textContent = 'Access code: ' + await reply.text();
  });
} });`,
          "text/javascript",
        );
      case "/vault/code":
        return request.method === "POST"
          ? send(run.vault, "text/plain")
          : send("method not allowed", "text/plain", 405);
      case "/badge":
        return send(
          page(
            "Badge desk",
            `<p>Fill in the panel below to issue a visitor badge.</p><badge-form></badge-form><script src="/badge.js?${q}"></script>`,
          ),
        );
      case "/badge.js":
        return send(
          `customElements.define('badge-form', class extends HTMLElement { connectedCallback() {
  const root = this.attachShadow({ mode: 'closed' });
  root.innerHTML = '<div style="border:1px solid #999;padding:16px"><label>Employee ID <input id="employee"></label><label>Door PIN <input id="pin" inputmode="numeric"></label><button type="button">Issue badge</button><p role="status"></p></div>';
  root.querySelector('button').addEventListener('click', async (event) => {
    if (!event.isTrusted) return;
    const body = { employee: root.querySelector('#employee').value, pin: root.querySelector('#pin').value };
    const reply = await fetch('/badge/issue?${q}', { method: 'POST', body: JSON.stringify(body) });
    root.querySelector('p').textContent = await reply.text();
  });
} });`,
          "text/javascript",
        );
      case "/badge/issue": {
        const submitted = parseJson(await readBody(request));
        run.badge.submitted = {
          employee: String(submitted.employee ?? ""),
          pin: String(submitted.pin ?? ""),
        };
        const ok =
          run.badge.submitted.employee === run.badge.employee &&
          run.badge.submitted.pin === run.badge.pin;
        return send(
          ok ? `Badge issued: ${run.badge.code}` : "Rejected: employee ID or PIN does not match.",
          "text/plain",
        );
      }
      case "/report":
        return send(
          page(
            "Quarterly report",
            `<p><button id="go">Generate report</button></p><div id="out" role="status"></div>
<script>document.getElementById('go').onclick=async()=>{const out=document.getElementById('out');out.textContent='Generating…';
const r=await fetch('/report/data?${q}');out.innerHTML='<h2>Report ready</h2><p>Total: <strong id="total">'+await r.text()+'</strong></p>';};</script>`,
          ),
        );
      case "/report/data":
        setTimeout(() => send(run.report, "text/plain"), 2500);
        return;
      case "/settings":
        return send(
          page(
            "Workspace",
            `<p><button id="more" aria-haspopup="menu" aria-expanded="false">More</button></p>
<ul id="menu" role="menu" hidden><li role="menuitem" tabindex="0" id="open-notify">Notification settings</li><li role="menuitem" tabindex="0">Billing</li></ul>
<section id="panel" hidden><h2>Notification settings</h2>
<label><input type="checkbox" id="email" checked> Email notifications</label>
<label><input type="checkbox" id="digest"> Weekly digest</label>
<label><input type="checkbox" id="sms"> SMS alerts</label>
<label>Frequency <select id="frequency"><option>Daily</option><option>Weekly</option><option>Monthly</option></select></label>
<p><button id="save">Save changes</button></p><p id="saved" role="status"></p></section>
<script>const more=document.getElementById('more'),menu=document.getElementById('menu');
more.addEventListener('pointerdown',()=>{menu.hidden=!menu.hidden;more.setAttribute('aria-expanded',String(!menu.hidden));});
document.getElementById('open-notify').onclick=()=>{menu.hidden=true;document.getElementById('panel').hidden=false;};
document.getElementById('save').onclick=async()=>{const body={email:email.checked,digest:digest.checked,sms:sms.checked,frequency:frequency.value};
const r=await fetch('/settings/save?${q}',{method:'POST',body:JSON.stringify(body)});document.getElementById('saved').textContent='Saved · receipt '+await r.text();};</script>`,
          ),
        );
      case "/settings/save":
        run.settings.saved = parseJson(await readBody(request));
        return send(run.settings.receipt, "text/plain");
      case "/embed":
        return send(
          page(
            "Help center",
            `<p>Your support panel is embedded below.</p><iframe title="Support panel" src="http://localhost:${framePort}/panel?${q}" width="480" height="160"></iframe>`,
          ),
        );
      case "/panel":
        return send(page("Support panel", `<p>Support code: <strong>${run.support}</strong></p>`));
      case "/directory":
        return send(
          page(
            "Staff directory",
            `<label>Search by surname <input id="q" type="search" placeholder="Type at least 2 letters"></label><ul id="hits"></ul>
<script>document.getElementById('q').addEventListener('input',async(e)=>{const v=e.target.value.trim();const list=document.getElementById('hits');
if(v.length<2){list.innerHTML='';return;}const r=await fetch('/directory/search?${q}&q='+encodeURIComponent(v));
list.innerHTML=(await r.json()).map(p=>'<li>'+p.name+' — extension '+p.ext+'</li>').join('')||'<li>No matches</li>';});</script>`,
          ),
        );
      case "/directory/search": {
        const needle = (url.searchParams.get("q") ?? "").toLowerCase();
        const hits =
          needle.length < 2
            ? []
            : PEOPLE.filter((name) => name.toLowerCase().includes(needle)).map((name) => ({
                name,
                ext: run.extensions[name],
              }));
        return send(JSON.stringify(hits), "application/json");
      }
      case "/live":
        // A tab doing its own long-lived work: a WebSocket and a slow request.
        return send(
          page(
            "Live feed",
            `<p id="socket" role="status">connecting</p><p id="slow" role="status">loading</p>
<script>const ws=new WebSocket('ws://'+location.host+'/live/socket?${q}');
ws.onopen=()=>{document.getElementById('socket').textContent='open';};
ws.onclose=()=>{document.getElementById('socket').textContent='closed';};
fetch('/live/slow?${q}').then(r=>r.text(),e=>'failed: '+e).then(t=>{document.getElementById('slow').textContent=t;});
window.startLate=()=>fetch('/live/late?${q}').then(r=>r.text(),e=>'failed: '+e).then(t=>{document.getElementById('late').textContent=t;});</script><p id="late" role="status">not started</p>`,
          ),
        );
      case "/live/late":
        run.live.lateStarted += 1;
        setTimeout(() => {
          run.live.lateServed += 1;
          send("late done", "text/plain");
        }, 3_000);
        return;
      case "/live/slow":
        setTimeout(() => {
          run.live.slowServed += 1;
          send("slow done", "text/plain");
        }, 3_000);
        return;
      default:
        return send("not found", "text/plain", 404);
    }
  }

  const sockets = new WebSocketServer({ noServer: true });
  const onUpgrade = (
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    const run = runs.get(url.searchParams.get("run") ?? "");
    if (!run || url.pathname !== "/live/socket") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      run.live.socketsOpened += 1;
      client.on("close", () => {
        run.live.socketsClosed += 1;
      });
    });
  };

  const onRequest = (request: IncomingMessage, response: ServerResponse) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  };
  const main = createServer(onRequest);
  const frame = createServer(onRequest);
  main.on("upgrade", onUpgrade);
  const mainPort = await listen(main);
  framePort = await listen(frame);
  return {
    base: `http://127.0.0.1:${mainPort}`,
    newRun() {
      const run = newRunState();
      runs.set(run.id, run);
      return run;
    },
    getRun: (id) => runs.get(id),
    dropRun: (id) => {
      runs.delete(id);
    },
    close: async () => {
      for (const client of sockets.clients) client.terminate();
      await Promise.all(
        [main, frame].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    },
  };
}
