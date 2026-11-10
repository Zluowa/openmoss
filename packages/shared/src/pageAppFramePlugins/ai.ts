// FILE: ai.ts
// Purpose: Frame half of the `ai` capability: one memoryless question to a
// model through Moss's own model gateway, optionally streamed, optionally JSON.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const aiFramePlugin: PageAppFramePlugin = {
  name: "ai",
  frameSource: String.raw`function (bridge) {
  function request(input, options, json) {
    var opts = options || {};
    if (typeof input !== "string" && !Array.isArray(input)) {
      return Promise.reject(bridge.error("invalid_argument", "input must be a string or a message list."));
    }
    if (opts.onText !== undefined && typeof opts.onText !== "function") {
      return Promise.reject(bridge.error("invalid_argument", "onText must be a function."));
    }
    var args = { input: input, json: !!json };
    if (typeof opts.system === "string") args.system = opts.system;
    if (typeof opts.maxTokens === "number") args.maxTokens = opts.maxTokens;
    if (opts.tier === "quick" || opts.tier === "complex" || opts.tier === "default") args.tier = opts.tier;
    return new Promise(function (resolve, reject) {
      var text = "";
      var finished = false;
      var cancel = bridge.watch("ask", args, function (event) {
        if (!event || finished) return;
        if (event.type === "text") {
          text += event.delta;
          if (opts.onText) { try { opts.onText(event.delta, text); } catch (e) { setTimeout(function () { throw e; }); } }
        } else if (event.type === "done") {
          finished = true;
          resolve({ text: event.text, model: event.model });
        }
      }, function (error) {
        if (finished) return;
        finished = true;
        if (error) reject(error);
        else reject(bridge.error("upstream_error", "The model ended without an answer."));
      });
      var signal = opts.signal;
      if (signal && typeof signal.addEventListener === "function") {
        if (signal.aborted) { cancel(); finished = true; reject(bridge.error("cancelled", "Aborted.")); return; }
        signal.addEventListener("abort", function () {
          if (finished) return;
          finished = true;
          cancel();
          reject(bridge.error("cancelled", "Aborted."));
        });
      }
    });
  }
  function parseJson(text) {
    var trimmed = String(text).trim();
    var fenced = /^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i.exec(trimmed);
    if (fenced) trimmed = fenced[1];
    return JSON.parse(trimmed);
  }
  return {
    ask: function (input, options) { return request(input, options, false); },
    json: function (input, options) {
      return request(input, options, true).then(function (result) {
        try { return parseJson(result.text); }
        catch (e) { throw bridge.error("upstream_error", "The model did not return valid JSON."); }
      });
    },
  };
}`,
};
