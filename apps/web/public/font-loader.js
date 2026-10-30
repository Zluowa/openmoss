(() => {
  const link = document.getElementById("moss-web-fonts");
  if (!(link instanceof HTMLLinkElement)) return;
  const promote = () => {
    link.onload = null;
    link.rel = "stylesheet";
  };
  link.addEventListener("load", promote, { once: true });
  // A failed optional font request must never affect application startup.
  link.addEventListener("error", () => link.remove(), { once: true });
})();
