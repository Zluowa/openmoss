// A real Node subprocess gives each probe its own default locale.
import { pathToFileURL } from "node:url";
import path from "node:path";

const [action, repository, source, target] = process.argv.slice(2);
const pin = {
  repository: "Zluowa/open-hoola-canvas",
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  lockfileSha256: "c".repeat(64),
};
const locale = new Intl.Collator().resolvedOptions().locale;
try {
  const bundle = await import(
    pathToFileURL(path.join(repository, "scripts/lib/bundled-moss-canvas.ts"))
  );
  const pins = await import(
    pathToFileURL(path.join(repository, "scripts/lib/moss-canvas-source-pin.ts"))
  );
  const result =
    action === "prepare"
      ? bundle.prepareMossCanvasBundle({ sourceDir: source, targetDir: target, sourcePin: pin })
      : pins.validatePinnedMossCanvasBundle(target, pin);
  console.log(JSON.stringify({ locale, ok: true, result }));
} catch (error) {
  console.log(JSON.stringify({ locale, ok: false, error: error.message }));
  process.exitCode = 1;
}
