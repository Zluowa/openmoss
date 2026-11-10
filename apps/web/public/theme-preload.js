// Restore the small first-paint surface before fonts, CSS and React load.
// The complete theme store takes ownership once the application mounts.
(() => {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem("moss:theme") || "null");
  } catch {
    stored = null;
  }
  const mode = typeof stored === "string" ? stored : stored?.mode;
  const dark =
    mode === "dark" || (mode !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  const variant = dark ? "dark" : "light";
  const surface =
    stored?.chromeThemes?.[variant]?.surface ?? stored?.packs?.[variant]?.theme?.surface;
  const safeSurface =
    typeof surface === "string" && /^#[0-9a-f]{6}$/i.test(surface)
      ? surface
      : dark
        ? "#181818"
        : "#ffffff";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.setProperty("--moss-boot-background", safeSurface);
})();
