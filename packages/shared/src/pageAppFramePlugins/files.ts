// FILE: files.ts
// Purpose: Frame half of the `files` capability: read one Moss project's
// files as the viewer (list, stat, read, readText) and offer one for saving
// (`download`, confirmed by the viewer every time). There are no writes.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const filesFramePlugin: PageAppFramePlugin = {
  name: "files",
  frameSource: String.raw`function (bridge) {
  function pathOf(path) {
    if (path === undefined || path === null) return "";
    if (typeof path !== "string") throw bridge.error("invalid_argument", "A path must be a string.");
    return path;
  }
  return {
    list: function (options) {
      var opts = options || {};
      var body = { path: pathOf(opts.path) };
      if (opts.recursive === true) body.recursive = true;
      if (typeof opts.cursor === "string") body.cursor = opts.cursor;
      return bridge.call("list", body);
    },
    stat: function (path) { return bridge.call("stat", { path: pathOf(path) }); },
    read: function (path, options) {
      var opts = options || {};
      var body = { path: pathOf(path) };
      if (typeof opts.offset === "number") body.offset = opts.offset;
      if (typeof opts.length === "number") body.length = opts.length;
      return bridge.call("read", body);
    },
    readText: function (path) {
      return bridge.call("read", { path: pathOf(path) }).then(function (result) {
        return new TextDecoder().decode(result.bytes);
      });
    },
    download: function (path) { return bridge.call("download", { path: pathOf(path) }); },
  };
}`,
};
