// FILE: media.ts
// Purpose: Frame half of `media`: generate images/videos and query jobs through
// the viewer's Moss account without exposing API keys to the page.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const mediaFramePlugin: PageAppFramePlugin = {
  name: "media",
  frameSource: String.raw`function (bridge) {
  var token = null;
  try { token = new URLSearchParams(location.search).get("t"); } catch (e) { token = null; }
  var ownOrigin = location.origin && location.origin !== "null" && !!token;
  function enrich(job) {
    if (!job || typeof job !== "object") return job;
    var assetPaths = Array.isArray(job.assetPaths) ? job.assetPaths : [];
    var dataUrls = Array.isArray(job.dataUrls) ? job.dataUrls : [];
    var rawUrls = Array.isArray(job.urls) ? job.urls : [];
    var resolved = [];
    if (ownOrigin && assetPaths.length > 0) {
      for (var i = 0; i < assetPaths.length; i++) {
        resolved.push(location.origin + assetPaths[i] + "?t=" + encodeURIComponent(token));
      }
    } else if (dataUrls.length > 0) {
      resolved = dataUrls.slice();
    } else {
      resolved = rawUrls.slice();
    }
    return Object.freeze(Object.assign({}, job, {
      urls: Object.freeze(resolved),
      url: resolved.length > 0 ? resolved[0] : (typeof job.url === "string" ? job.url : null),
    }));
  }
  function normalizeInput(input) {
    if (typeof input === "string") return { prompt: input };
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw bridge.error("invalid_argument", "options must be a prompt string or an object.");
    }
    return input;
  }
  return {
    generateImage: function (options) {
      var body;
      try { body = normalizeInput(options); }
      catch (err) { return Promise.reject(err); }
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "prompt must be a non-empty string."));
      }
      return bridge.call("generateImage", body).then(enrich);
    },
    generateVideo: function (options) {
      var body;
      try { body = normalizeInput(options); }
      catch (err) { return Promise.reject(err); }
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "prompt must be a non-empty string."));
      }
      return bridge.call("generateVideo", body).then(enrich);
    },
    getJob: function (jobId) {
      var id = typeof jobId === "string" ? jobId : jobId && typeof jobId.jobId === "string" ? jobId.jobId : "";
      if (!id.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "getJob(id) requires a jobId string."));
      }
      return bridge.call("getJob", { jobId: id.trim() }).then(enrich);
    },
    listModels: function () {
      return bridge.call("listModels", null);
    },
  };
}`,
};
