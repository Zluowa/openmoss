// FILE: assets.ts
// Purpose: Frame half of the `assets` capability: the page's own files.
// `url()` gives an address for <img>, <video>, fonts and CSS: on the page's
// own origin it is served directly; on the opaque fallback it is a blob: URL
// made from the bytes.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const assetsFramePlugin: PageAppFramePlugin = {
  name: "assets",
  frameSource: String.raw`function (bridge) {
  var token = null;
  try { token = new URLSearchParams(location.search).get("t"); } catch (e) { token = null; }
  var ownOrigin = location.origin && location.origin !== "null" && !!token;
  var blobUrls = new Map();
  function withUrl(asset) {
    if (!asset || typeof asset.path !== "string") return asset;
    var copy = Object.assign({}, asset);
    copy.url = ownOrigin ? location.origin + asset.path + "?t=" + encodeURIComponent(token) : null;
    return Object.freeze(copy);
  }
  function toUpload(input, options) {
    var opts = options || {};
    if (typeof Blob !== "undefined" && input instanceof Blob) {
      return input.arrayBuffer().then(function (buffer) {
        return { bytes: new Uint8Array(buffer), mimeType: opts.mimeType || input.type || "", name: opts.name || input.name || "asset" };
      });
    }
    if (input instanceof ArrayBuffer) return Promise.resolve({ bytes: new Uint8Array(input), mimeType: opts.mimeType || "", name: opts.name || "asset" });
    if (ArrayBuffer.isView(input)) {
      return Promise.resolve({ bytes: new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)), mimeType: opts.mimeType || "", name: opts.name || "asset" });
    }
    if (typeof input === "string") return Promise.resolve({ bytes: new TextEncoder().encode(input), mimeType: opts.mimeType || "text/plain", name: opts.name || "asset.txt" });
    return Promise.reject(bridge.error("invalid_argument", "upload() takes a File, Blob, ArrayBuffer, typed array or string."));
  }
  function read(id) {
    return bridge.call("read", { id: String(id) }).then(function (result) {
      return { asset: withUrl(result.asset), bytes: result.bytes };
    });
  }
  return {
    list: function () {
      return bridge.call("list", null).then(function (result) {
        return { assets: (result.assets || []).map(withUrl), canUpload: !!result.canUpload };
      });
    },
    upload: function (input, options) {
      return toUpload(input, options).then(function (body) {
        if (!body.mimeType) throw bridge.error("invalid_argument", "Say the file's type with { mimeType }.");
        return bridge.call("upload", body);
      }).then(withUrl);
    },
    read: read,
    url: function (assetOrId) {
      var id = typeof assetOrId === "string" ? assetOrId : assetOrId && assetOrId.id;
      if (typeof id !== "string") return Promise.reject(bridge.error("invalid_argument", "url() takes an asset or its id."));
      if (ownOrigin) return Promise.resolve(location.origin + "/__moss_app/asset/" + id + "?t=" + encodeURIComponent(token));
      if (blobUrls.has(id)) return Promise.resolve(blobUrls.get(id));
      return read(id).then(function (result) {
        var url = URL.createObjectURL(new Blob([result.bytes], { type: result.asset.mimeType }));
        blobUrls.set(id, url);
        return url;
      });
    },
    delete: function (id) {
      var key = String(id);
      if (blobUrls.has(key)) { URL.revokeObjectURL(blobUrls.get(key)); blobUrls.delete(key); }
      return bridge.call("delete", { id: key });
    },
  };
}`,
};
