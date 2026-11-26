// FILE: voice.ts
// Purpose: Frame half of `voice`: speech-to-text transcription, microphone
// listening, speech synthesis/playback, and Moss Realtime Voice sessions.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const voiceFramePlugin: PageAppFramePlugin = {
  name: "voice",
  frameSource: String.raw`function (bridge) {
  var listeners = [];
  var stopStream = null;
  function emit(raw) {
    var copy = listeners.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i](raw); } catch (e) { setTimeout(function () { throw e; }); }
    }
  }
  function ensureStream() {
    if (stopStream || listeners.length === 0) return;
    stopStream = bridge.watch("events", {}, function (event) {
      emit(event);
    }, function () {
      stopStream = null;
    });
  }
  function subscribe(fn) {
    if (typeof fn !== "function") {
      throw bridge.error("invalid_argument", "listener must be a function.");
    }
    listeners.push(fn);
    ensureStream();
    return function () {
      var idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
      if (listeners.length === 0 && stopStream) {
        var stop = stopStream;
        stopStream = null;
        stop();
      }
    };
  }
  function normalizeObject(input, fieldName) {
    if (input === undefined || input === null) return {};
    if (typeof input === "string") {
      var obj = {};
      obj[fieldName] = input;
      return obj;
    }
    if (typeof input !== "object" || Array.isArray(input)) {
      throw bridge.error("invalid_argument", "options must be a string or an object.");
    }
    return input;
  }
  return {
    listVoices: function () {
      return bridge.call("listVoices", null);
    },
    transcribe: function (input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return Promise.reject(bridge.error("invalid_argument", "transcribe requires an audio payload object."));
      }
      if (typeof input.audioBase64 !== "string" || !input.audioBase64.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "audioBase64 must be a non-empty string."));
      }
      return bridge.call("transcribe", input);
    },
    startListening: function (options) {
      if (options !== undefined && options !== null && (typeof options !== "object" || Array.isArray(options))) {
        return Promise.reject(bridge.error("invalid_argument", "startListening options must be an object."));
      }
      return bridge.call("startListening", options || {});
    },
    stopListening: function (options) {
      var body;
      try { body = normalizeObject(options, "listeningId"); }
      catch (err) { return Promise.reject(err); }
      return bridge.call("stopListening", body);
    },
    speak: function (input) {
      var body;
      try { body = normalizeObject(input, "text"); }
      catch (err) { return Promise.reject(err); }
      if (typeof body.text !== "string" || !body.text.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "speak requires non-empty text."));
      }
      return bridge.call("speak", body);
    },
    stopSpeaking: function () {
      return bridge.call("stopSpeaking", null);
    },
    startRealtimeSession: function (options) {
      if (options !== undefined && options !== null && (typeof options !== "object" || Array.isArray(options))) {
        return Promise.reject(bridge.error("invalid_argument", "startRealtimeSession options must be an object."));
      }
      return bridge.call("startRealtimeSession", options || {});
    },
    stopRealtimeSession: function (options) {
      var body;
      try { body = normalizeObject(options, "sessionId"); }
      catch (err) { return Promise.reject(err); }
      return bridge.call("stopRealtimeSession", body);
    },
    onEvent: function (listener) {
      return subscribe(listener);
    },
    onTranscript: function (listener) {
      if (typeof listener !== "function") {
        throw bridge.error("invalid_argument", "listener must be a function.");
      }
      return subscribe(function (event) {
        if (event && event.type === "transcript") listener(event);
      });
    },
    onState: function (listener) {
      if (typeof listener !== "function") {
        throw bridge.error("invalid_argument", "listener must be a function.");
      }
      return subscribe(function (event) {
        if (event && event.type === "state") listener(event);
      });
    },
  };
}`,
};
