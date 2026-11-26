// FILE: desktop.ts
// Purpose: Frame half of the `desktop` capability (`moss.use("desktop")`):
// window, Menu, app.dock, tray, notification, globalShortcut, screen, install,
// permissions, os, fs, shell, childProcess, and pty. Seamlessly connects to
// `window.mossDesktop` / `window.mossApps` in standalone desktop windows or
// falls back to the shell postMessage bridge in the main window.
// Layer: Shared frame plugin (source runs inside the 应用页)

import type { PageAppFramePlugin } from "../pageAppCapabilityPlugin";

export const desktopFramePlugin: PageAppFramePlugin = {
  name: "desktop",
  frameSource: String.raw`function (bridge) {
  var MENU_MAX_DEPTH = 4;
  var MENU_MAX_ITEMS = 500;
  var NOTIFICATION_MAX_CHARS = 300;
  var NOTIFICATION_MAX_RAW_CHARS = 2000;
  var BACKLOG_LIMIT = 2000;
  var nextId = 1;
  var menuCallbacks = new Map();
  var trayMenuCallbacks = new Map();
  var trayClickHandler = null;
  var shortcutHandlers = new Map();
  var processHandles = new Map();
  var ptyHandles = new Map();
  var eventUnsub = null;

  function genId(prefix) {
    return prefix + "-" + (nextId++) + "-" + Math.random().toString(36).slice(2, 8);
  }
  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }
  function getNative() {
    if (typeof window === "undefined") return null;
    return window.mossDesktop || window.mossApps || null;
  }
  function normalizeNotificationText(raw) {
    var out = "";
    for (var i = 0; i < raw.length; i++) {
      var code = raw.charCodeAt(i);
      out += (code <= 0x1f || code === 0x7f) ? " " : raw.charAt(i);
    }
    return out.replace(/\s+/g, " ").trim();
  }
  function dispatchEvent(ev) {
    if (!ev || typeof ev !== "object") return;
    var ns = ev.namespace;
    var name = ev.event;
    var targetId = ev.targetId;
    var payload = ev.payload;
    if (ns === "menu" && name === "click") {
      var cb = menuCallbacks.get(targetId || (payload && payload.id));
      if (typeof cb === "function") {
        try { cb(payload); } catch (e) { setTimeout(function () { throw e; }); }
      }
      return;
    }
    if (ns === "tray") {
      if ((name === "click" || name === "pressed") && typeof trayClickHandler === "function") {
        try { trayClickHandler(payload); } catch (e) { setTimeout(function () { throw e; }); }
      } else if (name === "menu-click") {
        var tcb = trayMenuCallbacks.get(targetId || (payload && payload.id));
        if (typeof tcb === "function") {
          try { tcb(payload); } catch (e) { setTimeout(function () { throw e; }); }
        }
      }
      return;
    }
    if (ns === "globalShortcut" && (name === "triggered" || name === "pressed")) {
      var acc = targetId || (payload && payload.accelerator);
      var set = shortcutHandlers.get(acc);
      if (set) {
        set.forEach(function (fn) {
          try { fn(acc); } catch (e) { setTimeout(function () { throw e; }); }
        });
      }
      return;
    }
    if (ns === "childProcess") {
      var proc = processHandles.get(targetId);
      if (proc) proc._dispatch(name, payload);
      return;
    }
    if (ns === "pty") {
      var term = ptyHandles.get(targetId);
      if (term) term._dispatch(name, payload);
    }
  }
  function ensureEvents() {
    if (eventUnsub) return;
    var native = getNative();
    if (native && typeof native.subscribe === "function") {
      eventUnsub = native.subscribe(dispatchEvent);
      return;
    }
    if (native && typeof native.onEvent === "function") {
      eventUnsub = native.onEvent(dispatchEvent);
      return;
    }
    eventUnsub = bridge.watch("events", null, dispatchEvent, function () {
      eventUnsub = null;
    });
  }
  function invoke(namespace, method, args) {
    var payload = args === undefined ? null : args;
    var native = getNative();
    if (native && typeof native.invoke === "function") {
      try {
        return Promise.resolve(native.invoke(namespace, method, payload));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (native && isPlainObject(native[namespace]) && typeof native[namespace][method] === "function") {
      try {
        return Promise.resolve(native[namespace][method](payload));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return bridge.call("invoke", { namespace: namespace, method: method, args: payload });
  }
  function bytesToBase64(bytes) {
    var chunkSize = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunkSize) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(parts.join(""));
  }
  function base64ToBytes(str) {
    var bin = atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toBinaryPayload(data) {
    if (typeof data === "string") return { data: data, encoding: "utf8" };
    if (data instanceof ArrayBuffer) return { base64: bytesToBase64(new Uint8Array(data)), encoding: "base64" };
    if (ArrayBuffer.isView(data)) {
      return {
        base64: bytesToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
        encoding: "base64",
      };
    }
    return null;
  }
  function serializeMenu(items, depth, state, cbMap, forbidRole, idPrefix) {
    if (!Array.isArray(items)) {
      throw bridge.error("invalid_argument", "Menu template must be an array.");
    }
    if (depth > MENU_MAX_DEPTH) {
      throw bridge.error("invalid_argument", "Menu nesting depth cannot exceed " + MENU_MAX_DEPTH + ".");
    }
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!isPlainObject(item)) {
        throw bridge.error("invalid_argument", "Each menu item must be an object.");
      }
      state.count += 1;
      if (state.count > MENU_MAX_ITEMS) {
        throw bridge.error("invalid_argument", "Menu total items cannot exceed " + MENU_MAX_ITEMS + ".");
      }
      if (forbidRole && item.role !== undefined) {
        throw bridge.error("invalid_argument", "Application menu items cannot use role.");
      }
      var id = typeof item.id === "string" && item.id ? item.id : genId(idPrefix);
      var entry = { id: id };
      if (typeof item.label === "string") entry.label = item.label;
      if (typeof item.type === "string") entry.type = item.type;
      if (typeof item.checked === "boolean") entry.checked = item.checked;
      if (typeof item.enabled === "boolean") entry.enabled = item.enabled;
      if (typeof item.accelerator === "string") entry.accelerator = item.accelerator;
      if (typeof item.click === "function") cbMap.set(id, item.click);
      if (item.submenu !== undefined) {
        entry.submenu = serializeMenu(item.submenu, depth + 1, state, cbMap, forbidRole, idPrefix);
      }
      out.push(entry);
    }
    return out;
  }
  function makeEmitter() {
    var listeners = new Map();
    var backlog = new Map();
    return {
      on: function (event, fn) {
        if (typeof fn !== "function") throw new TypeError("Listener must be a function.");
        var key = String(event);
        var set = listeners.get(key);
        if (!set) { set = new Set(); listeners.set(key, set); }
        set.add(fn);
        var queued = backlog.get(key);
        if (queued && queued.length > 0) {
          backlog.delete(key);
          for (var i = 0; i < queued.length; i++) {
            try { fn.apply(null, queued[i]); } catch (e) { setTimeout(function () { throw e; }); }
          }
        }
        return function () { set.delete(fn); };
      },
      off: function (event, fn) {
        var set = listeners.get(String(event));
        if (set) set.delete(fn);
      },
      emit: function (event) {
        var key = String(event);
        var args = Array.prototype.slice.call(arguments, 1);
        var set = listeners.get(key);
        if (!set || set.size === 0) {
          var q = backlog.get(key);
          if (!q) { q = []; backlog.set(key, q); }
          if (q.length < BACKLOG_LIMIT) q.push(args);
          return;
        }
        set.forEach(function (fn) {
          try { fn.apply(null, args); } catch (e) { setTimeout(function () { throw e; }); }
        });
      },
    };
  }

  var windowApi = Object.freeze({
    setOptions: function (options) {
      if (!isPlainObject(options)) {
        return Promise.reject(bridge.error("invalid_argument", "window.setOptions() expects an options object."));
      }
      return invoke("window", "setOptions", options);
    },
    getOptions: function () { return invoke("window", "getOptions", null); },
    place: function (options) {
      if (typeof options === "string") {
        return invoke("window", "place", { position: options });
      }
      if (!isPlainObject(options)) {
        return Promise.reject(bridge.error("invalid_argument", "window.place() expects an options object."));
      }
      return invoke("window", "place", options);
    },
    show: function () { return invoke("window", "show", null); },
    hide: function () { return invoke("window", "hide", null); },
    focus: function () { return invoke("window", "focus", null); },
    close: function () { return invoke("window", "close", null); },
    getBounds: function () { return invoke("window", "getBounds", null); },
    setBounds: function (bounds) {
      if (!isPlainObject(bounds)) {
        return Promise.reject(bridge.error("invalid_argument", "window.setBounds() expects a bounds object."));
      }
      return invoke("window", "setBounds", bounds);
    },
    setDraggableRegions: function (regions) {
      if (!Array.isArray(regions)) {
        return Promise.reject(bridge.error("invalid_argument", "window.setDraggableRegions() expects an array."));
      }
      return invoke("window", "setDraggableRegions", { regions: regions });
    },
    setIgnoreMouseEvents: function (ignore, options) {
      return invoke("window", "setIgnoreMouseEvents", {
        ignore: !!ignore,
        forward: !!(isPlainObject(options) && options.forward),
      });
    },
    setVisibleOnAllWorkspaces: function (visible, options) {
      return invoke("window", "setVisibleOnAllWorkspaces", {
        visible: !!visible,
        visibleOnFullScreen: !!(isPlainObject(options) && options.visibleOnFullScreen),
      });
    },
    print: function (options) {
      return invoke("window", "print", isPlainObject(options) ? options : null);
    },
  });

  var menuApi = Object.freeze({
    setApplicationMenu: function (template) {
      if (template === null) {
        menuCallbacks.clear();
        return invoke("Menu", "setApplicationMenu", { template: null });
      }
      var nextCallbacks = new Map();
      var serialized;
      try {
        serialized = serializeMenu(template, 1, { count: 0 }, nextCallbacks, true, "appmenu");
      } catch (e) {
        return Promise.reject(e);
      }
      menuCallbacks.clear();
      nextCallbacks.forEach(function (fn, id) { menuCallbacks.set(id, fn); });
      if (nextCallbacks.size > 0) ensureEvents();
      return invoke("Menu", "setApplicationMenu", { template: serialized });
    },
    popup: function (template, options) {
      var popupCallbacks = new Map();
      var serialized;
      try {
        serialized = serializeMenu(template, 1, { count: 0 }, popupCallbacks, false, "popup");
      } catch (e) {
        return Promise.reject(e);
      }
      var opts = isPlainObject(options) ? options : {};
      var args = { template: serialized };
      if (typeof opts.x === "number") args.x = opts.x;
      if (typeof opts.y === "number") args.y = opts.y;
      return invoke("Menu", "popup", args).then(function (selectedId) {
        if (typeof selectedId === "string" && popupCallbacks.has(selectedId)) {
          try { popupCallbacks.get(selectedId)(); } catch (e) { setTimeout(function () { throw e; }); }
        }
        return selectedId === undefined ? null : selectedId;
      });
    },
  });

  var appApi = Object.freeze({
    dock: Object.freeze({
      setIcon: function (icon) {
        if (typeof icon !== "string" && icon !== null) {
          return Promise.reject(bridge.error("invalid_argument", "app.dock.setIcon() takes a data URL string or null."));
        }
        return invoke("app", "dock.setIcon", { icon: icon });
      },
      setBadge: function (text) {
        return invoke("app", "dock.setBadge", { text: text === undefined || text === null ? "" : String(text) });
      },
      setProgress: function () { return Promise.resolve(false); },
      setMenu: function () { return Promise.resolve(false); },
    }),
  });

  var trayApi = Object.freeze({
    set: function (options) {
      if (!isPlainObject(options)) {
        return Promise.reject(bridge.error("invalid_argument", "tray.set() requires an options object."));
      }
      var hasIcon = typeof options.icon === "string" && options.icon.trim().length > 0;
      var hasTitle = typeof options.title === "string" && options.title.trim().length > 0;
      if (!hasIcon && !hasTitle) {
        return Promise.reject(bridge.error("invalid_argument", "tray.set() requires { icon } or { title }."));
      }
      var nextMenuCallbacks = new Map();
      var args = {};
      if (hasIcon) args.icon = options.icon;
      if (typeof options.iconIsTemplate === "boolean") args.iconIsTemplate = options.iconIsTemplate;
      if (typeof options.title === "string") args.title = options.title;
      if (typeof options.toolTip === "string") args.toolTip = options.toolTip;
      if (options.menu === null) {
        args.menu = null;
      } else if (options.menu !== undefined) {
        try {
          args.menu = serializeMenu(options.menu, 1, { count: 0 }, nextMenuCallbacks, false, "tray");
        } catch (e) {
          return Promise.reject(e);
        }
      }
      args.hasClickHandler = typeof options.click === "function";
      trayClickHandler = typeof options.click === "function" ? options.click : null;
      trayMenuCallbacks.clear();
      nextMenuCallbacks.forEach(function (fn, id) { trayMenuCallbacks.set(id, fn); });
      if (trayClickHandler || trayMenuCallbacks.size > 0) ensureEvents();
      return invoke("tray", "set", args);
    },
    remove: function () {
      trayClickHandler = null;
      trayMenuCallbacks.clear();
      return invoke("tray", "remove", null);
    },
  });

  var notificationApi = Object.freeze({
    show: function (options) {
      if (!isPlainObject(options) || typeof options.body !== "string") {
        return Promise.reject(bridge.error("invalid_argument", "notification.show() requires { body }."));
      }
      if (options.body.length > NOTIFICATION_MAX_RAW_CHARS) {
        return Promise.reject(
          bridge.error("invalid_argument", "notification raw body must be at most " + NOTIFICATION_MAX_RAW_CHARS + " characters."),
        );
      }
      var cleaned = normalizeNotificationText(options.body);
      var codePointCount = Array.from(cleaned).length;
      if (codePointCount < 1 || codePointCount > NOTIFICATION_MAX_CHARS) {
        return Promise.reject(
          bridge.error("invalid_argument", "notification body must be 1-" + NOTIFICATION_MAX_CHARS + " code points."),
        );
      }
      return invoke("notification", "show", { body: cleaned });
    },
  });

  var globalShortcutApi = Object.freeze({
    register: function (accelerator, callback) {
      if (typeof accelerator !== "string" || !accelerator.trim() || typeof callback !== "function") {
        return Promise.reject(bridge.error("invalid_argument", "globalShortcut.register() takes (accelerator, callback)."));
      }
      ensureEvents();
      var key = accelerator.trim();
      return invoke("globalShortcut", "register", { accelerator: key }).then(function (ok) {
        if (ok) {
          var set = shortcutHandlers.get(key);
          if (!set) { set = new Set(); shortcutHandlers.set(key, set); }
          set.add(callback);
        }
        return !!ok;
      });
    },
    unregister: function (accelerator) {
      if (typeof accelerator !== "string" || !accelerator.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "globalShortcut.unregister() takes an accelerator string."));
      }
      var key = accelerator.trim();
      shortcutHandlers.delete(key);
      return invoke("globalShortcut", "unregister", { accelerator: key });
    },
    unregisterAll: function () {
      shortcutHandlers.clear();
      return invoke("globalShortcut", "unregisterAll", null);
    },
    isRegistered: function (accelerator) {
      if (typeof accelerator !== "string" || !accelerator.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "globalShortcut.isRegistered() takes an accelerator string."));
      }
      return invoke("globalShortcut", "isRegistered", { accelerator: accelerator.trim() });
    },
  });

  var screenApi = Object.freeze({
    getPrimaryDisplay: function () { return invoke("screen", "getPrimaryDisplay", null); },
    getAllDisplays: function () { return invoke("screen", "getAllDisplays", null); },
    getDisplayNearestPoint: function (point) {
      if (!isPlainObject(point) || typeof point.x !== "number" || typeof point.y !== "number") {
        return Promise.reject(bridge.error("invalid_argument", "screen.getDisplayNearestPoint() takes { x, y }."));
      }
      return invoke("screen", "getDisplayNearestPoint", { x: point.x, y: point.y });
    },
    getDisplayMatching: function (rect) {
      if (!isPlainObject(rect) || typeof rect.x !== "number" || typeof rect.y !== "number") {
        return Promise.reject(bridge.error("invalid_argument", "screen.getDisplayMatching() takes { x, y, width, height }."));
      }
      return invoke("screen", "getDisplayMatching", rect);
    },
    getCursorScreenPoint: function () { return invoke("screen", "getCursorScreenPoint", null); },
  });

  var installApi = Object.freeze({
    state: function () { return invoke("install", "state", null); },
    isInstalled: function () {
      return invoke("install", "state", null).then(function (res) {
        return !!(res && res.installed);
      });
    },
    request: function () { return invoke("install", "request", null); },
  });

  var permissionsApi = Object.freeze({
    declare: function (manifestJson) {
      return invoke("permissions", "declare", manifestJson === undefined ? null : manifestJson);
    },
    state: function (name) {
      return invoke("permissions", "state", name === undefined ? null : { name: String(name) });
    },
    request: function (names) {
      if (names !== undefined && typeof names !== "string" && !Array.isArray(names)) {
        return Promise.reject(bridge.error("invalid_argument", "permissions.request() takes a name or list of names."));
      }
      var list = names === undefined ? null : (Array.isArray(names) ? names.map(String) : [String(names)]);
      return invoke("permissions", "request", list === null ? null : { names: list });
    },
    manage: function () { return invoke("permissions", "manage", null).then(function () {}); },
  });

  var osApi = Object.freeze({
    platform: function () { return invoke("os", "platform", null); },
    arch: function () { return invoke("os", "arch", null); },
    info: function () { return invoke("os", "info", null); },
  });

  function requirePath(path, method) {
    if (typeof path !== "string" || !path.trim()) {
      throw bridge.error("invalid_argument", method + "() requires a non-empty path.");
    }
    return path;
  }

  var fsApi = Object.freeze({
    readFile: function (path, options) {
      try { requirePath(path, "fs.readFile"); } catch (e) { return Promise.reject(e); }
      var encoding = typeof options === "string"
        ? options
        : (isPlainObject(options) && typeof options.encoding === "string" ? options.encoding : null);
      return invoke("fs", "readFile", { path: path, encoding: encoding }).then(function (res) {
        if (encoding) return res;
        if (res instanceof Uint8Array) return res;
        if (isPlainObject(res) && typeof res.base64 === "string") return base64ToBytes(res.base64);
        if (typeof res === "string") return base64ToBytes(res);
        return res;
      });
    },
    writeFile: function (path, data, options) {
      try { requirePath(path, "fs.writeFile"); } catch (e) { return Promise.reject(e); }
      var body = toBinaryPayload(data);
      if (!body) {
        return Promise.reject(bridge.error("invalid_argument", "fs.writeFile() data must be string or binary."));
      }
      var opts = isPlainObject(options) ? options : (typeof options === "string" ? { encoding: options } : {});
      return invoke("fs", "writeFile", Object.assign({ path: path }, body, opts));
    },
    appendFile: function (path, data, options) {
      try { requirePath(path, "fs.appendFile"); } catch (e) { return Promise.reject(e); }
      var body = toBinaryPayload(data);
      if (!body) {
        return Promise.reject(bridge.error("invalid_argument", "fs.appendFile() data must be string or binary."));
      }
      var opts = isPlainObject(options) ? options : (typeof options === "string" ? { encoding: options } : {});
      return invoke("fs", "appendFile", Object.assign({ path: path }, body, opts));
    },
    readdir: function (path, options) {
      try { requirePath(path, "fs.readdir"); } catch (e) { return Promise.reject(e); }
      return invoke("fs", "readdir", {
        path: path,
        withFileTypes: !!(isPlainObject(options) && options.withFileTypes),
      });
    },
    stat: function (path) {
      try { requirePath(path, "fs.stat"); } catch (e) { return Promise.reject(e); }
      return invoke("fs", "stat", { path: path });
    },
    lstat: function (path) {
      try { requirePath(path, "fs.lstat"); } catch (e) { return Promise.reject(e); }
      return invoke("fs", "lstat", { path: path });
    },
    mkdir: function (path, options) {
      try { requirePath(path, "fs.mkdir"); } catch (e) { return Promise.reject(e); }
      return invoke("fs", "mkdir", {
        path: path,
        recursive: !!(isPlainObject(options) && options.recursive),
      });
    },
    rm: function (path, options) {
      try { requirePath(path, "fs.rm"); } catch (e) { return Promise.reject(e); }
      var opts = isPlainObject(options) ? options : {};
      return invoke("fs", "rm", { path: path, recursive: !!opts.recursive, force: !!opts.force });
    },
    rmdir: function (path, options) {
      try { requirePath(path, "fs.rmdir"); } catch (e) { return Promise.reject(e); }
      return invoke("fs", "rmdir", {
        path: path,
        recursive: !!(isPlainObject(options) && options.recursive),
      });
    },
    unlink: function (path) {
      try { requirePath(path, "fs.unlink"); } catch (e) { return Promise.reject(e); }
      return invoke("fs", "unlink", { path: path });
    },
    rename: function (oldPath, newPath) {
      try {
        requirePath(oldPath, "fs.rename");
        requirePath(newPath, "fs.rename");
      } catch (e) { return Promise.reject(e); }
      return invoke("fs", "rename", { oldPath: oldPath, newPath: newPath });
    },
    copyFile: function (src, dest, mode) {
      try {
        requirePath(src, "fs.copyFile");
        requirePath(dest, "fs.copyFile");
      } catch (e) { return Promise.reject(e); }
      return invoke("fs", "copyFile", { src: src, dest: dest, mode: typeof mode === "number" ? mode : 0 });
    },
    access: function (path, mode) {
      try { requirePath(path, "fs.access"); } catch (e) { return Promise.reject(e); }
      return invoke("fs", "access", { path: path, mode: typeof mode === "number" ? mode : undefined });
    },
    exists: function (path) {
      try { requirePath(path, "fs.exists"); } catch (e) { return Promise.reject(e); }
      return invoke("fs", "exists", { path: path });
    },
    realpath: function (path) {
      try { requirePath(path, "fs.realpath"); } catch (e) { return Promise.reject(e); }
      return invoke("fs", "realpath", { path: path });
    },
  });

  var shellApi = Object.freeze({
    openPath: function (path) {
      try { requirePath(path, "shell.openPath"); } catch (e) { return Promise.reject(e); }
      return invoke("shell", "openPath", { path: path });
    },
    showItemInFolder: function (path) {
      try { requirePath(path, "shell.showItemInFolder"); } catch (e) { return Promise.reject(e); }
      return invoke("shell", "showItemInFolder", { path: path });
    },
    trashItem: function (path) {
      try { requirePath(path, "shell.trashItem"); } catch (e) { return Promise.reject(e); }
      return invoke("shell", "trashItem", { path: path });
    },
    openExternal: function (url) {
      if (typeof url !== "string" || !url.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "shell.openExternal() requires a URL."));
      }
      return invoke("shell", "openExternal", { url: url });
    },
  });

  function sanitizeProcessOptions(options) {
    if (!isPlainObject(options)) return null;
    var out = {};
    if (typeof options.cwd === "string") out.cwd = options.cwd;
    if (typeof options.shell === "boolean") out.shell = options.shell;
    if (typeof options.timeout === "number" && Number.isFinite(options.timeout)) out.timeout = options.timeout;
    if (typeof options.input === "string") out.input = options.input;
    if (isPlainObject(options.env)) {
      var env = {};
      Object.keys(options.env).forEach(function (k) {
        if (typeof options.env[k] === "string") env[k] = options.env[k];
      });
      out.env = env;
    }
    return out;
  }

  var childProcessApi = Object.freeze({
    exec: function (command, options) {
      if (typeof command !== "string" || !command.trim()) {
        return Promise.reject(bridge.error("invalid_argument", "childProcess.exec() requires a command."));
      }
      return invoke("childProcess", "exec", {
        command: command,
        options: sanitizeProcessOptions(options),
      });
    },
    spawn: function (command, argsOrOptions, maybeOptions) {
      if (typeof command !== "string" || !command.trim()) {
        throw bridge.error("invalid_argument", "childProcess.spawn() requires a command.");
      }
      var args = Array.isArray(argsOrOptions) ? argsOrOptions.map(String) : [];
      var options = sanitizeProcessOptions(
        isPlainObject(argsOrOptions) ? argsOrOptions : (isPlainObject(maybeOptions) ? maybeOptions : null),
      );
      ensureEvents();
      var clientId = genId("proc");
      var mainEvents = makeEmitter();
      var stdoutEvents = makeEmitter();
      var stderrEvents = makeEmitter();
      var exitResolve, exitReject;
      var exited = new Promise(function (resolve, reject) { exitResolve = resolve; exitReject = reject; });
      var endStdin = function () {
        return invoke("childProcess", "endStdin", { id: handle.id });
      };
      var handle = {
        id: clientId,
        pid: null,
        stdout: Object.freeze({
          on: function (ev, fn) { return ev === "data" ? stdoutEvents.on("data", fn) : stdoutEvents.on(ev, fn); },
          off: stdoutEvents.off,
        }),
        stderr: Object.freeze({
          on: function (ev, fn) { return ev === "data" ? stderrEvents.on("data", fn) : stderrEvents.on(ev, fn); },
          off: stderrEvents.off,
        }),
        stdin: Object.freeze({
          write: function (data) {
            return invoke("childProcess", "write", { id: handle.id, data: String(data) });
          },
          end: endStdin,
          endStdin: endStdin,
        }),
        on: function (ev, fn) {
          return mainEvents.on(ev === "close" ? "exit" : ev, fn);
        },
        off: function (ev, fn) {
          mainEvents.off(ev === "close" ? "exit" : ev, fn);
        },
        kill: function (signal) {
          return invoke("childProcess", "kill", { id: handle.id, signal: signal ? String(signal) : "SIGTERM" });
        },
        ready: null,
        exited: exited,
        _dispatch: function (evName, payload) {
          if (evName === "stdout") stdoutEvents.emit("data", payload && payload.data !== undefined ? payload.data : payload);
          else if (evName === "stderr") stderrEvents.emit("data", payload && payload.data !== undefined ? payload.data : payload);
          else if (evName === "error") {
            mainEvents.emit("error", payload);
            exitReject(payload);
          } else if (evName === "exit" || evName === "close") {
            var code = payload && payload.code !== undefined ? payload.code : null;
            var signal = payload && payload.signal !== undefined ? payload.signal : null;
            processHandles.delete(clientId);
            if (handle.id !== clientId) processHandles.delete(handle.id);
            mainEvents.emit("exit", code, signal);
            exitResolve({ code: code, signal: signal });
          }
        },
      };
      processHandles.set(clientId, handle);
      handle.ready = invoke("childProcess", "spawn", {
        clientId: clientId,
        command: command,
        args: args,
        options: options,
      }).then(function (info) {
        if (info && typeof info.id === "string" && info.id !== clientId) {
          handle.id = info.id;
          processHandles.set(info.id, handle);
        }
        if (info && typeof info.pid === "number") handle.pid = info.pid;
        return info;
      }, function (err) {
        processHandles.delete(clientId);
        mainEvents.emit("error", err);
        exitReject(err);
        throw err;
      });
      return handle;
    },
  });

  var ptyApi = Object.freeze({
    spawn: function (file, argsOrOptions, maybeOptions) {
      if (typeof file !== "string" || !file.trim()) {
        throw bridge.error("invalid_argument", "pty.spawn() requires a shell/executable.");
      }
      var args = Array.isArray(argsOrOptions) ? argsOrOptions.map(String) : [];
      var rawOpts = isPlainObject(argsOrOptions) ? argsOrOptions : (isPlainObject(maybeOptions) ? maybeOptions : {});
      var options = {};
      if (typeof rawOpts.cols === "number") options.cols = rawOpts.cols;
      if (typeof rawOpts.rows === "number") options.rows = rawOpts.rows;
      if (typeof rawOpts.cwd === "string") options.cwd = rawOpts.cwd;
      if (isPlainObject(rawOpts.env)) {
        var env = {};
        Object.keys(rawOpts.env).forEach(function (k) {
          if (typeof rawOpts.env[k] === "string") env[k] = rawOpts.env[k];
        });
        options.env = env;
      }
      ensureEvents();
      var clientId = genId("pty");
      var emitter = makeEmitter();
      var handle = {
        id: clientId,
        pid: null,
        on: emitter.on,
        off: emitter.off,
        onData: function (fn) {
          var unsub = emitter.on("data", fn);
          return Object.freeze({ dispose: unsub });
        },
        onExit: function (fn) {
          var unsub = emitter.on("exit", fn);
          return Object.freeze({ dispose: unsub });
        },
        onError: function (fn) {
          var unsub = emitter.on("error", fn);
          return Object.freeze({ dispose: unsub });
        },
        write: function (data) {
          return invoke("pty", "write", { id: handle.id, data: String(data) });
        },
        resize: function (cols, rows) {
          return invoke("pty", "resize", { id: handle.id, cols: Number(cols), rows: Number(rows) });
        },
        kill: function (signal) {
          return invoke("pty", "kill", { id: handle.id, signal: signal ? String(signal) : undefined });
        },
        ready: null,
        _dispatch: function (evName, payload) {
          if (evName === "data") {
            emitter.emit("data", payload && payload.data !== undefined ? payload.data : payload);
          } else if (evName === "exit") {
            ptyHandles.delete(clientId);
            if (handle.id !== clientId) ptyHandles.delete(handle.id);
            emitter.emit("exit", payload);
          } else if (evName === "error") {
            emitter.emit("error", payload);
          }
        },
      };
      ptyHandles.set(clientId, handle);
      handle.ready = invoke("pty", "spawn", {
        clientId: clientId,
        file: file,
        args: args,
        options: options,
      }).then(function (info) {
        if (info && typeof info.id === "string" && info.id !== clientId) {
          handle.id = info.id;
          ptyHandles.set(info.id, handle);
        }
        if (info && typeof info.pid === "number") handle.pid = info.pid;
        return info;
      }, function (err) {
        ptyHandles.delete(clientId);
        emitter.emit("error", err);
        throw err;
      });
      return handle;
    },
  });

  return {
    window: windowApi,
    Menu: menuApi,
    app: appApi,
    tray: trayApi,
    notification: notificationApi,
    globalShortcut: globalShortcutApi,
    screen: screenApi,
    install: installApi,
    permissions: permissionsApi,
    os: osApi,
    fs: fsApi,
    shell: shellApi,
    childProcess: childProcessApi,
    pty: ptyApi,
  };
}`,
};
