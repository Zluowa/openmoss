// FILE: chat.ts
// Purpose: Frame half of `chat`: contextual Q&A (`ask`), summoning Moss (`summon`),
// and opening Moss's native sidechat in context (`openSidechat`).
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const chatFramePlugin: PageAppFramePlugin = {
  name: "chat",
  frameSource: String.raw`function (bridge) {
  function normalizeOptions(input, extra) {
    if (typeof input === "string") {
      return Object.assign({}, extra || {}, { prompt: input });
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw bridge.error("invalid_argument", "options must be a prompt string or an object.");
    }
    return Object.assign({}, input, extra || {});
  }
  function ask(input, extra) {
    var opts;
    try { opts = normalizeOptions(input, extra); }
    catch (err) { return Promise.reject(err); }
    if (typeof opts.prompt !== "string" || !opts.prompt.trim()) {
      return Promise.reject(bridge.error("invalid_argument", "prompt must be a non-empty string."));
    }
    if (opts.onText !== undefined && typeof opts.onText !== "function") {
      return Promise.reject(bridge.error("invalid_argument", "onText must be a function."));
    }
    var payload = { prompt: opts.prompt };
    if (typeof opts.selectionText === "string") payload.selectionText = opts.selectionText;
    if (typeof opts.context === "string") payload.context = opts.context;
    if (typeof opts.appTitle === "string") payload.appTitle = opts.appTitle;
    if (typeof opts.system === "string") payload.system = opts.system;
    if (typeof opts.maxTokens === "number") payload.maxTokens = opts.maxTokens;
    if (opts.tier === "quick" || opts.tier === "complex" || opts.tier === "default") payload.tier = opts.tier;
    return new Promise(function (resolve, reject) {
      var text = "";
      var finished = false;
      var cancel = bridge.watch("ask", payload, function (event) {
        if (!event || finished) return;
        if (event.type === "text") {
          text += event.delta;
          if (opts.onText) { try { opts.onText(event.delta, text); } catch (e) { setTimeout(function () { throw e; }); } }
        } else if (event.type === "done") {
          finished = true;
          resolve(Object.freeze({
            text: event.text,
            model: event.model,
            selectionText: typeof opts.selectionText === "string" ? opts.selectionText : null,
          }));
        }
      }, function (error) {
        if (finished) return;
        finished = true;
        if (error) reject(error);
        else reject(bridge.error("upstream_error", "Moss did not finish answering."));
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
  function sanitizeSidechatPayload(input) {
    if (input === undefined || input === null) return {};
    if (typeof input === "string") return { prompt: input };
    if (typeof input !== "object" || Array.isArray(input)) {
      throw bridge.error("invalid_argument", "options must be an object or string.");
    }
    var out = {};
    if (typeof input.prompt === "string") out.prompt = input.prompt;
    if (typeof input.selectionText === "string") out.selectionText = input.selectionText;
    if (typeof input.context === "string") out.context = input.context;
    if (typeof input.appTitle === "string") out.appTitle = input.appTitle;
    if (input.action === "ask" || input.action === "sidechat") out.action = input.action;
    return out;
  }
  return {
    ask: ask,
    summon: function (options) {
      var body;
      try { body = sanitizeSidechatPayload(options); }
      catch (err) { return Promise.reject(err); }
      return bridge.call("summon", body);
    },
    openSidechat: function (options) {
      var body;
      try { body = sanitizeSidechatPayload(options); }
      catch (err) { return Promise.reject(err); }
      return bridge.call("openSidechat", body);
    },
  };
}`,
};
