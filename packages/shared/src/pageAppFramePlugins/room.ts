// FILE: room.ts
// Purpose: Frame half of the `room` capability: join the live room of the
// people who have this page open now, see who is here (with each one's
// presence state), and send events to them. Nothing is stored.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const roomFramePlugin: PageAppFramePlugin = {
  name: "room",
  frameSource: String.raw`function (bridge) {
  var current = null;
  function join(options) {
    if (current) return current;
    var opts = options || {};
    var listeners = { peers: [], message: [], leave: [] };
    var topics = new Map();
    var peers = [];
    var self = null;
    var ready = null;
    var readyResolve, readyReject;
    ready = new Promise(function (resolve, reject) { readyResolve = resolve; readyReject = reject; });
    function emit(kind, value) {
      (listeners[kind] || []).slice().forEach(function (fn) {
        try { fn(value); } catch (e) { setTimeout(function () { throw e; }); }
      });
    }
    var cancel = bridge.watch("join", { state: opts.state === undefined ? null : opts.state }, function (event) {
      if (!event) return;
      if (event.type === "welcome") {
        self = event.peerId;
        peers = event.peers || [];
        readyResolve(handle);
        emit("peers", peers.slice());
      } else if (event.type === "peers") {
        peers = event.peers || [];
        emit("peers", peers.slice());
      } else if (event.type === "event") {
        var message = Object.freeze({ topic: event.topic, data: event.data, from: event.from, at: event.at });
        emit("message", message);
        (topics.get(event.topic) || []).slice().forEach(function (fn) {
          try { fn(message.data, message); } catch (e) { setTimeout(function () { throw e; }); }
        });
      }
    }, function (error) {
      if (current === handle) current = null;
      if (self === null) readyReject(error || bridge.error("unavailable", "Could not join the room."));
      emit("leave", error || null);
    });
    var handle = Object.freeze({
      ready: ready,
      self: function () { return self; },
      peers: function () { return peers.slice(); },
      publish: function (topic, data, options) {
        return ready.then(function () {
          var body = { topic: String(topic), data: data === undefined ? null : data };
          if (options && options.echo === true) body.echo = true;
          return bridge.call("publish", body);
        });
      },
      setPresence: function (state) {
        return ready.then(function () { return bridge.call("presence", { state: state === undefined ? null : state }); });
      },
      on: function (kind, fn) {
        if (!listeners[kind] || typeof fn !== "function") throw new TypeError("on() takes 'peers', 'message' or 'leave' and a function.");
        listeners[kind].push(fn);
        return function () { listeners[kind] = listeners[kind].filter(function (other) { return other !== fn; }); };
      },
      subscribe: function (topic, fn) {
        if (typeof fn !== "function") throw new TypeError("subscribe() needs a function.");
        var key = String(topic);
        var list = topics.get(key) || [];
        list.push(fn);
        topics.set(key, list);
        return function () { topics.set(key, (topics.get(key) || []).filter(function (other) { return other !== fn; })); };
      },
      leave: function () {
        if (current === handle) current = null;
        cancel();
        emit("leave", null);
      },
    });
    current = handle;
    return handle;
  }
  return {
    join: join,
    peers: function () { return bridge.call("peers", null).then(function (result) { return result.peers; }); },
  };
}`,
};
