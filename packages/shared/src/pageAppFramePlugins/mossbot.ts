// FILE: mossbot.ts
// Purpose: Frame half of `mossbot`: summon Moss/Mossbot into meeting or work
// rooms, post structured meeting notes, generate summaries, and ask in context.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const mossbotFramePlugin: PageAppFramePlugin = {
  name: "mossbot",
  frameSource: String.raw`function (bridge) {
  function requireRecord(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw bridge.error("invalid_argument", "options must be an object.");
    }
    return input;
  }
  return {
    listBots: function () {
      return bridge.call("listBots", null);
    },
    joinMeeting: function (options) {
      if (options === undefined || options === null) {
        return bridge.call("joinMeeting", {});
      }
      var opts;
      try { opts = requireRecord(options); }
      catch (err) { return Promise.reject(err); }
      return bridge.call("joinMeeting", opts);
    },
    postNote: function (options) {
      var opts;
      try { opts = requireRecord(options); }
      catch (err) { return Promise.reject(err); }
      if (typeof opts.meetingId !== "string" || !opts.meetingId.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "postNote requires meetingId."));
      }
      if (typeof opts.text !== "string" || !opts.text.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "postNote requires non-empty text."));
      }
      return bridge.call("postNote", opts);
    },
    summarizeMeeting: function (options) {
      var opts;
      if (typeof options === "string") {
        opts = { meetingId: options };
      } else {
        try { opts = requireRecord(options); }
        catch (err) { return Promise.reject(err); }
      }
      if (typeof opts.meetingId !== "string" || !opts.meetingId.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "summarizeMeeting requires meetingId."));
      }
      return bridge.call("summarizeMeeting", opts);
    },
    askInMeeting: function (options) {
      var opts;
      try { opts = requireRecord(options); }
      catch (err) { return Promise.reject(err); }
      if (typeof opts.meetingId !== "string" || !opts.meetingId.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "askInMeeting requires meetingId."));
      }
      if (typeof opts.question !== "string" || !opts.question.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "askInMeeting requires question."));
      }
      return bridge.call("askInMeeting", opts);
    },
  };
}`,
};
