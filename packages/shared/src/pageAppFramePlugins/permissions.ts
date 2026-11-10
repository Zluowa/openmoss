// FILE: permissions.ts
// Purpose: Frame half of the built-in `permissions` capability: read, ask for
// and manage this page's capability grants.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const permissionsFramePlugin: PageAppFramePlugin = {
  name: "permissions",
  frameSource: String.raw`function (bridge) {
  return {
    state: function (name) {
      return bridge.call("state", name === undefined ? null : { name: String(name) });
    },
    request: function (names) {
      if (names !== undefined && !Array.isArray(names)) {
        return Promise.reject(bridge.error("invalid_argument", "request() takes a list of names."));
      }
      return bridge.call("request", names === undefined ? null : { names: names.map(String) });
    },
    manage: function () { return bridge.call("manage", null).then(function () {}); },
  };
}`,
};
