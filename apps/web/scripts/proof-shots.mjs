// FILE: proof-shots.mjs
// Purpose: Proof screenshots without a desktop window. Starts the real Moss server with the built
//          web client (signed out, fresh home), opens a fixed list of screens in Chromium at the
//          desktop size, light and dark, and saves one picture per screen and theme. `compare`
//          then says which screens changed against another set (main's) and by how much.
// Layer: CI tooling (the Proof Screenshots workflow; runs locally the same way)
//
//   node apps/web/scripts/proof-shots.mjs shoot --out <dir> [--static-dir apps/web/dist] [--port 3790]
//   node apps/web/scripts/proof-shots.mjs compare --base <dir> --head <dir> --out <dir>
//
// `shoot` exits non-zero only when the app cannot be shown at all (server not ready, a screen
// that throws on navigation). Changed screens are a report, not a failure: a visual change is
// what a pull request is for; the reviewer reads the pictures.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium } from "playwright";

import {
  CHANNEL_TOLERANCE,
  classify,
  diffPixels,
  screenProblem,
  summarize,
} from "./proof-shots-diff.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

/** The desktop size the walk used. */
const VIEWPORT = { width: 1440, height: 900 };
const THEMES = ["light", "dark"];

const SETTINGS_SECTIONS = [
  "general",
  "account",
  "appearance",
  "notifications",
  "behavior",
  "appsnap",
  "history",
  "voice",
  "shortcuts",
  "worktrees",
  "archived",
  "models",
  "providers",
  "plugins",
  "usage",
  "connections",
  "computer-use",
  "import",
];

/**
 * The fixed list, from the screens of the 2026-11-24 owner walk that an address reaches. Each says
 * what proves it was reached: the address it must end on, or a visible marker. Add screens here;
 * a name is the file name, so never rename one (it would lose its comparison once). Left out
 * because the address redirects in the web client: /signup (to /login), /plugins (to /skills),
 * /studio, /groups and /hubs (to a new chat).
 */
const DRAFT_CHAT = /^\/[0-9a-f-]{36}$/;
export const SCREENS = [
  { name: "home", path: "/", expect: { path: DRAFT_CHAT } },
  { name: "login", path: "/login", expect: { path: "/login" } },
  ...["apps", "automations", "tasks", "inbox", "mossbot", "skills", "kanban", "pull-requests"].map(
    (name) => ({ name, path: `/${name}`, expect: { path: `/${name}` } }),
  ),
  { name: "membership", path: "/membership", expect: { path: "/membership" } },
  ...SETTINGS_SECTIONS.map((section) => ({
    name: `settings-${section}`,
    path: `/settings?section=${section}`,
    expect: { marker: `[data-settings-section="${section}"]`, dialog: true },
  })),
];

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

async function startServer(port, staticDir, logPath) {
  const home = mkdtempSync(join(tmpdir(), "moss-proof-home-"));
  const log = [];
  const child = spawn("bun", [join(repoRoot, "apps", "server", "src", "index.ts")], {
    cwd: home,
    env: {
      ...process.env,
      MOSS_HOME: home,
      MOSS_PORT: String(port),
      MOSS_HOST: "127.0.0.1",
      MOSS_MODE: "web",
      MOSS_NO_BROWSER: "1",
      MOSS_STATIC_DIR: staticDir,
      MOSS_DISABLE_PROVIDER_UPDATES: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => log.push(chunk));
  child.stderr.on("data", (chunk) => log.push(chunk));
  const flush = () => writeFileSync(logPath, Buffer.concat(log));
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (child.exitCode !== null) {
      flush();
      throw new Error(`Moss server exited (${child.exitCode}); see ${logPath}`);
    }
    const ok = await new Promise((done) => {
      const request = http.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
        response.resume();
        done(response.statusCode === 200);
      });
      request.on("error", () => done(false));
    });
    if (ok) return { child, flush, startedMs: Date.now() - started };
    await sleep(250);
  }
  child.kill();
  flush();
  throw new Error(`Moss server did not answer on port ${port} within 120 s; see ${logPath}`);
}

const DIALOG = '[role="dialog"], [role="alertdialog"]';

/**
 * A first visit shows welcome dialogs (tour, beta note, onboarding). Close each the way a person
 * would, by its close button or Escape; the browser profile keeps that, so every screen after it
 * is what a returning user sees.
 */
async function closeFirstRunDialogs(context, port) {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  let quiet = 0;
  for (let round = 0; round < 12 && quiet < 3; round++) {
    await sleep(1000);
    const dialog = page.locator(DIALOG).first();
    if (!(await dialog.isVisible())) {
      quiet++;
      continue;
    }
    quiet = 0;
    const close = dialog.getByRole("button", { name: /^(关闭|Close|跳过|Skip|以后再说|Not now)/ });
    if (await close.first().isVisible()) await close.first().click();
    else await page.keyboard.press("Escape");
  }
  await page.close();
}

/** Stills the page so two runs of the same code give the same pixels. */
const STILL_CSS = `*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important;
  transition: none !important; caret-color: transparent !important;
}`;

async function shoot() {
  const out = resolve(argument("out", "proof-shots"));
  const staticDir = resolve(argument("static-dir", join(repoRoot, "apps", "web", "dist")));
  const port = Number(argument("port", "3790"));
  if (!existsSync(join(staticDir, "index.html"))) {
    throw new Error(`${staticDir} has no index.html: run \`vite build\` in apps/web first`);
  }
  mkdirSync(out, { recursive: true });
  const server = await startServer(port, staticDir, join(out, "server.log"));
  const browser = await chromium.launch();
  const report = { serverReadyMs: server.startedMs, screens: [] };
  try {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        colorScheme: theme,
        reducedMotion: "reduce",
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
      });
      await closeFirstRunDialogs(context, port);
      for (const screen of SCREENS) {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error.message).slice(0, 200)));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text().slice(0, 200));
        });
        const started = Date.now();
        await page.goto(`http://127.0.0.1:${port}${screen.path}`, { waitUntil: "load" });
        await page.addStyleTag({ content: STILL_CSS });
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        if (screen.expect.marker) {
          await page
            .locator(screen.expect.marker)
            .first()
            .waitFor({ timeout: 10_000 })
            .catch(() => {});
        }
        // Fonts, lazy panels and the first data from the server.
        await page.evaluate(() => document.fonts.ready);
        await sleep(1200);
        const problem = screenProblem(screen.expect, {
          pathname: new URL(page.url()).pathname,
          markerVisible: screen.expect.marker
            ? await page.locator(screen.expect.marker).first().isVisible()
            : false,
          dialogVisible: await page.locator(DIALOG).first().isVisible(),
        });
        const file = `${screen.name}.${theme}.png`;
        await page.screenshot({ path: join(out, file) });
        report.screens.push({
          name: screen.name,
          theme,
          file,
          url: new URL(page.url()).pathname + new URL(page.url()).search,
          ms: Date.now() - started,
          problem,
          errors: [...new Set(errors)].slice(0, 5),
        });
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.child.kill();
    server.flush();
  }
  writeFileSync(join(out, "shots.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`proof-shots: ${report.screens.length} pictures in ${out}`);
  const unfit = report.screens.filter((screen) => screen.problem);
  for (const screen of unfit) console.error(`not proof: ${screen.file}: ${screen.problem}`);
  if (unfit.length > 0) process.exit(1);
}

/** Decodes both PNGs inside Chromium (no image library in the workspace) and diffs them there. */
async function compare() {
  const base = resolve(argument("base", ""));
  const head = resolve(argument("head", ""));
  const out = resolve(argument("out", "proof-diff"));
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const rows = [];
  const pictures = (dir) => readdirSync(dir).filter((file) => file.endsWith(".png"));
  try {
    const names = [...new Set([...pictures(base), ...pictures(head)])].sort();
    for (const file of names) {
      const inBase = existsSync(join(base, file));
      const inHead = existsSync(join(head, file));
      if (!inBase || !inHead) {
        rows.push({ file, ...classify({ inBase, inHead, share: null }) });
        continue;
      }
      const result = await page.evaluate(
        async ({ a, b, tolerance, diffSource }) => {
          const diffPixels = new Function(`return (${diffSource})`)();
          const load = (src) =>
            new Promise((done, fail) => {
              const image = new Image();
              image.onload = () => done(image);
              image.onerror = fail;
              image.src = src;
            });
          const [left, right] = await Promise.all([load(a), load(b)]);
          if (left.width !== right.width || left.height !== right.height) {
            return { share: null, diff: null };
          }
          const canvas = document.createElement("canvas");
          canvas.width = left.width;
          canvas.height = left.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          context.drawImage(left, 0, 0);
          const before = context.getImageData(0, 0, left.width, left.height).data;
          context.clearRect(0, 0, left.width, left.height);
          context.drawImage(right, 0, 0);
          const after = context.getImageData(0, 0, left.width, left.height).data;
          const { changed, share, diff } = diffPixels(
            before,
            after,
            left.width,
            left.height,
            tolerance,
          );
          if (changed === 0) return { share, diff: null };
          context.putImageData(new ImageData(diff, left.width, left.height), 0, 0);
          return { share, diff: canvas.toDataURL("image/png") };
        },
        {
          a: `data:image/png;base64,${readFileSync(join(base, file)).toString("base64")}`,
          b: `data:image/png;base64,${readFileSync(join(head, file)).toString("base64")}`,
          tolerance: CHANNEL_TOLERANCE,
          diffSource: diffPixels.toString(),
        },
      );
      const row = { file, ...classify({ inBase, inHead, share: result.share }) };
      if (row.status === "changed" && result.diff) {
        writeFileSync(
          join(out, file.replace(/\.png$/, ".diff.png")),
          Buffer.from(result.diff.split(",")[1], "base64"),
        );
      }
      rows.push(row);
    }
  } finally {
    await browser.close();
  }
  const lines = summarize(rows);
  writeFileSync(join(out, "changes.json"), `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(join(out, "summary.md"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

const command = process.argv[2];
if (command === "shoot") await shoot();
else if (command === "compare") await compare();
else {
  console.error(
    "usage: proof-shots.mjs shoot --out <dir> | compare --base <dir> --head <dir> --out <dir>",
  );
  process.exit(2);
}
