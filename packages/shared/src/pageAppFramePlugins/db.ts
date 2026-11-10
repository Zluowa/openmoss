// FILE: db.ts
// Purpose: Frame half of the `db` capability: path-holding refs, query
// builders and snapshot listeners on top of the bridge. The store, rules and
// caps live on the server; nothing here is trusted.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const dbFramePlugin: PageAppFramePlugin = {
  name: "db",
  frameSource: String.raw`function (bridge) {
  var SEGMENT = /^[A-Za-z0-9_.~-]{1,128}$/;
  var OPS = ["==", "!=", "<", "<=", ">", ">=", "in", "not-in", "array-contains"];
  function split(path) {
    if (typeof path !== "string") throw new TypeError("Path must be a string.");
    var parts = path.split("/").filter(function (p) { return p.length > 0; });
    if (parts.length === 0 || parts.length > 64) throw new TypeError("Invalid path: " + path);
    parts.forEach(function (p) {
      if (!SEGMENT.test(p) || p === "." || p === "..") throw new TypeError("Invalid path segment: " + p);
    });
    return parts;
  }
  function newId() {
    var bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function plainObject(value, what) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return Promise.reject(bridge.error("invalid_argument", what + " must be a plain object."));
    }
    try { return Promise.resolve(JSON.parse(JSON.stringify(value))); }
    catch (e) { return Promise.reject(bridge.error("invalid_argument", what + " is not JSON.")); }
  }
  function docSnapshot(raw) {
    var data = raw && raw.data ? raw.data : null;
    return Object.freeze({
      id: raw.id,
      path: raw.path,
      exists: !!raw.exists,
      updatedAt: raw.updatedAt || null,
      fromCache: false,
      hasPendingWrites: false,
      data: function () { return data === null ? undefined : JSON.parse(JSON.stringify(data)); },
      get: function (field) { return data === null ? undefined : data[field]; },
    });
  }
  function querySnapshot(raw, previous) {
    var docs = (raw.docs || []).map(docSnapshot);
    var prior = previous || [];
    var priorById = new Map(prior.map(function (d, i) { return [d.id, { doc: d, index: i }]; }));
    var changes = [];
    docs.forEach(function (d, i) {
      var before = priorById.get(d.id);
      if (!before) changes.push({ type: "added", doc: d, oldIndex: -1, newIndex: i });
      else {
        if (before.doc.updatedAt !== d.updatedAt || before.index !== i) {
          changes.push({ type: "modified", doc: d, oldIndex: before.index, newIndex: i });
        }
        priorById.delete(d.id);
      }
    });
    priorById.forEach(function (before) {
      changes.push({ type: "removed", doc: before.doc, oldIndex: before.index, newIndex: -1 });
    });
    return {
      docs: docs,
      snapshot: Object.freeze({
        docs: Object.freeze(docs),
        size: docs.length,
        empty: docs.length === 0,
        fromCache: false,
        hasPendingWrites: false,
        forEach: function (fn) { docs.forEach(fn); },
        docChanges: function () { return changes.slice(); },
      }),
    };
  }
  function listen(method, args, onNext, onError, wrap) {
    var cancel = bridge.watch(method, args, function (value) { onNext(wrap(value)); }, function (error) {
      if (!error) return;
      if (typeof onError === "function") onError(error);
      else if (typeof reportError === "function") reportError(error);
    });
    return cancel;
  }
  function makeQuery(collectionPath, where, orderBy, limit) {
    var spec = { collection: collectionPath };
    if (where.length) spec.where = where.slice();
    if (orderBy) spec.orderBy = orderBy;
    if (limit) spec.limit = limit;
    var q = {
      where: function (field, op, value) {
        if (OPS.indexOf(op) < 0) throw new TypeError("Unsupported operator: " + op);
        if (where.length >= 10) throw new TypeError("At most 10 filters.");
        return makeQuery(collectionPath, where.concat([{ field: String(field), op: op, value: value }]), orderBy, limit);
      },
      orderBy: function (field, dir) {
        if (orderBy) throw new TypeError("At most one orderBy.");
        return makeQuery(collectionPath, where, { field: String(field), dir: dir === "desc" ? "desc" : "asc" }, limit);
      },
      limit: function (n) {
        if (!(n >= 1 && n <= 1000 && Math.floor(n) === n)) throw new TypeError("limit must be 1-1000.");
        return makeQuery(collectionPath, where, orderBy, n);
      },
      get: function () {
        return bridge.call("query", spec).then(function (raw) { return querySnapshot(raw, null).snapshot; });
      },
      onSnapshot: function (next, error) {
        var previous = null;
        return listen("watchQuery", spec, next, error, function (raw) {
          var built = querySnapshot(raw, previous);
          previous = built.docs;
          return built.snapshot;
        });
      },
    };
    return q;
  }
  function collectionRef(parts) {
    if (parts.length % 2 !== 1) throw new TypeError("A collection path has an odd number of segments.");
    var path = parts.join("/");
    var base = makeQuery(path, [], null, 0);
    return Object.freeze(Object.assign({}, base, {
      path: path,
      id: parts[parts.length - 1],
      doc: function (id) { return docRef(parts.concat(split(id === undefined ? newId() : String(id)))); },
      add: function (data) {
        var ref = docRef(parts.concat([newId()]));
        return ref.set(data).then(function () { return ref; });
      },
    }));
  }
  function docRef(parts) {
    if (parts.length % 2 !== 0) throw new TypeError("A document path has an even number of segments.");
    var path = parts.join("/");
    return Object.freeze({
      path: path,
      id: parts[parts.length - 1],
      get: function () { return bridge.call("get", { path: path }).then(docSnapshot); },
      set: function (data) {
        return plainObject(data, "Document body").then(function (body) {
          return bridge.call("set", { path: path, data: body });
        }).then(function () {});
      },
      update: function (data) {
        return plainObject(data, "Update").then(function (body) {
          return bridge.call("update", { path: path, data: body });
        }).then(function () {});
      },
      delete: function () { return bridge.call("delete", { path: path }).then(function () {}); },
      acquire: function (options) {
        var ttl = options && options.ttlMs;
        return bridge.call("acquire", { path: path, ttlMs: typeof ttl === "number" ? ttl : 10000, data: options && options.data || null });
      },
      onSnapshot: function (next, error) { return listen("watchDoc", { path: path }, next, error, docSnapshot); },
      collection: function (sub) { return collectionRef(parts.concat(split(sub))); },
    });
  }
  return {
    doc: function (path) { return docRef(split(path)); },
    collection: function (path) { return collectionRef(split(path)); },
  };
}`,
};
