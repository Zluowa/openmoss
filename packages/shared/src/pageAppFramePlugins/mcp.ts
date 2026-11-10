// FILE: mcp.ts
// Purpose: Frame half of the `mcp` capability: call the viewer's connected
// tools from a page. `watchTool` is for data the page shows (cached first,
// kept fresh); `callTool` is for doing something once. Consent, destructive
// confirms, caching and limits all happen in Moss; nothing here is trusted.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const mcpFramePlugin: PageAppFramePlugin = {
  name: "mcp",
  frameSource: String.raw`function (bridge) {
  function plainArgs(args) {
    if (args === undefined || args === null) return {};
    if (typeof args !== "object" || Array.isArray(args)) throw bridge.error("invalid_argument", "Tool arguments must be an object.");
    try { return JSON.parse(JSON.stringify(args)); }
    catch (e) { throw bridge.error("invalid_argument", "Tool arguments must be JSON."); }
  }
  function firstText(result) {
    var items = result && result.content || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].type === "text" && typeof items[i].text === "string") return items[i].text.slice(0, 500);
    }
    return "The tool reported an error.";
  }
  function toolError(result) {
    return Object.freeze({ code: "tool_error", message: firstText(result), result: result });
  }
  function withSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(bridge.error("cancelled", "The call was cancelled."));
    return new Promise(function (resolve, reject) {
      function onAbort() { reject(bridge.error("cancelled", "The call was cancelled.")); }
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(function (value) { signal.removeEventListener("abort", onAbort); resolve(value); },
        function (error) { signal.removeEventListener("abort", onAbort); reject(error); });
    });
  }
  function callTool(server, tool, args, options) {
    var opts = options || {};
    var request;
    try { request = { server: String(server), tool: String(tool), args: plainArgs(args) }; }
    catch (e) { return Promise.reject(e); }
    if (opts.cache === false) request.cache = false;
    else if (opts.cache && typeof opts.cache === "object") {
      request.cache = {};
      if (typeof opts.cache.staleTime === "number") request.cache.staleTime = opts.cache.staleTime;
      if (opts.cache.refresh === true) request.cache.refresh = true;
    }
    return withSignal(bridge.call("call", request), opts.signal).then(function (result) {
      if (result && result.isError) throw toolError(result);
      return result;
    });
  }
  function watchTool(server, tool, args, listener, options) {
    if (typeof listener !== "function") throw new TypeError("watchTool needs a listener function.");
    var opts = options || {};
    var request = { server: String(server), tool: String(tool), args: plainArgs(args) };
    if (typeof opts.staleTime === "number") request.staleTime = opts.staleTime;
    if (typeof opts.intervalMs === "number") request.intervalMs = opts.intervalMs;
    return bridge.watch("watch", request, function (update) {
      if (!update) return;
      if (update.error) listener({ result: null, error: Object.freeze(update.error) });
      else if (update.result && update.result.isError) listener({ result: update.result, error: toolError(update.result) });
      else listener({ result: update.result, error: null });
    }, function (error) {
      if (error) listener({ result: null, error: error, ended: true });
    });
  }
  return {
    listTools: function () { return bridge.call("list", null); },
    request: function (server) { return bridge.call("request", { server: String(server) }); },
    callTool: callTool,
    watchTool: watchTool,
    invalidate: function (server, tool, args) {
      var body = {};
      if (server !== undefined) body.server = String(server);
      if (tool !== undefined) body.tool = String(tool);
      if (args !== undefined) body.args = args;
      return bridge.call("invalidate", body);
    },
    server: function (name) {
      var server = String(name);
      return Object.freeze({
        name: server,
        request: function () { return bridge.call("request", { server: server }); },
        callTool: function (tool, args, options) { return callTool(server, tool, args, options); },
        watchTool: function (tool, args, listener, options) { return watchTool(server, tool, args, listener, options); },
      });
    },
  };
}`,
};
