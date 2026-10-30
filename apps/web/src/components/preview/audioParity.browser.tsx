import "../../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { LocalMediaPreview } from "../LocalMediaPreview";

const fixture = vi.hoisted(() => ({ source: "" }));
vi.mock("~/lib/localImageUrls", () => ({ buildLocalImageUrl: () => fixture.source }));

function wavFixture(): Blob {
  const samples = 16000;
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  return new Blob([bytes], { type: "audio/wav" });
}

afterEach(() => {
  if (fixture.source.startsWith("blob:")) URL.revokeObjectURL(fixture.source);
});

it("loads real WAV metadata and controls native playback and seeking from the audio card", async () => {
  fixture.source = URL.createObjectURL(wavFixture());
  const ready = vi.fn();
  const error = vi.fn();
  const screen = await render(
    <LocalMediaPreview
      filePath="sample.wav"
      cwd="/workspace"
      kind="audio"
      onPreviewReady={ready}
      onPreviewError={error}
    />,
  );
  await expect.poll(() => ready.mock.calls.length).toBe(1);
  await expect.element(page.getByText("WAV audio")).toBeVisible();
  await expect.element(page.getByText("0:00 / 0:02")).toBeVisible();
  const audio = document.querySelector("audio")!;
  expect(audio.controls).toBe(true);
  expect(getComputedStyle(audio).display).toBe("none");
  await page.getByRole("button", { name: "Play sample.wav" }).click();
  await expect.poll(() => audio.paused).toBe(false);
  await page.getByRole("button", { name: "Pause sample.wav" }).click();
  await expect.poll(() => audio.paused).toBe(true);
  const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(slider, "1.2");
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.poll(() => audio.currentTime).toBeCloseTo(1.2, 1);
  await expect
    .element(page.getByRole("link", { name: "Download sample.wav" }))
    .toHaveAttribute("download", "sample.wav");
  expect(error).not.toHaveBeenCalled();
  await screen.unmount();
});

it("keeps the download action when decoding fails and resets after a source change", async () => {
  fixture.source = URL.createObjectURL(new Blob(["not media"], { type: "audio/wav" }));
  const error = vi.fn();
  const ready = vi.fn();
  const screen = await render(
    <LocalMediaPreview
      filePath="broken.wav"
      cwd="/workspace"
      kind="audio"
      onPreviewReady={ready}
      onPreviewError={error}
    />,
  );
  await expect.poll(() => error.mock.calls.length).toBe(1);
  await expect.element(page.getByText("Audio unavailable")).toBeVisible();
  await expect.element(page.getByRole("link", { name: "Download broken.wav" })).toBeVisible();
  URL.revokeObjectURL(fixture.source);
  fixture.source = URL.createObjectURL(wavFixture());
  await screen.rerender(
    <LocalMediaPreview
      filePath="sample.wav"
      cwd="/workspace"
      kind="audio"
      onPreviewReady={ready}
      onPreviewError={error}
    />,
  );
  await expect.poll(() => ready.mock.calls.length).toBe(1);
  expect(error).toHaveBeenCalledTimes(1);
  await screen.unmount();
});
