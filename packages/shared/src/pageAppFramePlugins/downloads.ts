// FILE: downloads.ts
// Purpose: Frame half of the `downloads` capability: hand the viewer a file
// to save. The shell confirms every save in its own dialog.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const downloadsFramePlugin: PageAppFramePlugin = {
  name: "downloads",
  frameSource: String.raw`function (bridge) {
  function toBytes(data) {
    if (typeof data === "string") return Promise.resolve({ text: data });
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return data.arrayBuffer().then(function (buffer) { return { bytes: new Uint8Array(buffer), type: data.type || "" }; });
    }
    if (data instanceof ArrayBuffer) return Promise.resolve({ bytes: new Uint8Array(data) });
    if (ArrayBuffer.isView(data)) return Promise.resolve({ bytes: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) });
    return Promise.reject(bridge.error("invalid_argument", "data must be a string, Blob, ArrayBuffer or typed array."));
  }
  return {
    save: function (request) {
      if (!request || typeof request !== "object") {
        return Promise.reject(bridge.error("invalid_argument", "save() takes { data, filename, mimeType }."));
      }
      if (typeof request.filename !== "string" || !request.filename.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "filename is required."));
      }
      return toBytes(request.data).then(function (body) {
        return bridge.call("save", {
          filename: request.filename,
          mimeType: typeof request.mimeType === "string" ? request.mimeType : (body.type || ""),
          text: body.text === undefined ? null : body.text,
          bytes: body.bytes === undefined ? null : body.bytes,
        });
      });
    },
  };
}`,
};
