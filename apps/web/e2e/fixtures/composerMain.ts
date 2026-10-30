import { app, BrowserWindow } from "electron";

app.setPath("userData", process.env.MOSS_E2E_COMPOSER_PROFILE!);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await window.loadFile(process.env.MOSS_E2E_COMPOSER_HTML!);
});
app.on("window-all-closed", () => app.quit());
