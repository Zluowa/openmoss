// FILE: user.ts
// Purpose: Frame half of the `user` capability: who is viewing and what they
// may change.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const userFramePlugin: PageAppFramePlugin = {
  name: "user",
  frameSource: String.raw`function (bridge) {
  var me = null;
  function viewer() {
    if (!me) me = bridge.call("me", null);
    return me;
  }
  return {
    me: function () { return viewer().then(function (v) { return Object.freeze(Object.assign({}, v)); }); },
    id: function () { return viewer().then(function (v) { return v.id; }); },
    name: function () { return viewer().then(function (v) { return v.name; }); },
    isOwner: function () { return viewer().then(function (v) { return !!v.isOwner; }); },
    canEdit: function () { return viewer().then(function (v) { return v.level === "admin" || v.level === "owner"; }); },
    can: function (what) { return bridge.call("can", { what: String(what) }); },
  };
}`,
};
