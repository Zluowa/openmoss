// FILE: proxyScripts.ts
// Purpose: Plain-JS sources inlined into the Moss proxy page: the streamed
// tool-input healer, the wheel coalescer, and the print receiver and wheel
// relay appended to every widget document.
// Layer: Electron main-process support. Kept as source strings so that the
// unit tests evaluate exactly the text the proxy page ships.

import {
  MCP_APP_SANDBOX_PRINT_THEME_TYPE,
  MCP_APP_SANDBOX_WHEEL_MAX_DELTA,
  MCP_APP_SANDBOX_WHEEL_TYPE,
} from "@moss/contracts";

/**
 * `createMossJsonHealer()` returns `{write(text), healed(), reset(), complete()}`.
 *
 * It consumes JSON text incrementally (each character is read once) and can at
 * any point produce the longest parseable "healed" prefix: an open string is
 * closed, a half-written key (or a key without its value yet) is dropped, a
 * partial number is cut back to its last valid digit, a partial literal is
 * completed, a trailing comma is dropped and every open container is closed.
 * Once the top-level value is complete, further text is ignored until reset().
 */
export const MCP_APP_JSON_HEALER_SOURCE = String.raw`function createMossJsonHealer() {
  // Container phases. Object: 0 expecting key or "}", 1 expecting ":", 2 expecting value,
  // 3 after value, 4 expecting key after ",". Array: 10 expecting value or "]",
  // 11 after value, 12 expecting value after ",".
  var raw = "";
  var stack = [];
  var token = 0; // 0 none, 1 string, 2 string escape, 3 unicode escape, 4 number, 5 literal
  var stringIsKey = false;
  var escapeStart = -1;
  var unicodeLeft = 0;
  var numberStart = -1;
  var numberPhase = 0; // 0 sign, 1 zero, 2 int, 3 dot, 4 frac, 5 exp, 6 exp sign, 7 exp digit
  var literal = "";
  var literalIndex = 0;
  var commaAt = -1;
  var started = false;
  var done = false;
  var top = function () { return stack.length > 0 ? stack[stack.length - 1] : null; };
  var expectsValue = function () {
    var frame = top();
    if (!frame) return !started;
    return frame.phase === 2 || frame.phase === 10 || frame.phase === 12;
  };
  var expectsKey = function () {
    var frame = top();
    return !!frame && (frame.phase === 0 || frame.phase === 4);
  };
  var valueEnded = function (end) {
    var frame = top();
    if (!frame) { done = true; return; }
    if (frame.phase === 2) { frame.phase = 3; frame.cut = end; }
    else if (frame.phase === 10 || frame.phase === 12) { frame.phase = 11; frame.cut = end; }
  };
  var numberIsWhole = function () {
    return numberPhase === 1 || numberPhase === 2 || numberPhase === 4 || numberPhase === 7;
  };
  var numberAccepts = function (ch) {
    var digit = ch >= "0" && ch <= "9";
    switch (numberPhase) {
      case 0: if (ch === "0") { numberPhase = 1; return true; } if (digit) { numberPhase = 2; return true; } return false;
      case 1: if (ch === ".") { numberPhase = 3; return true; } if (ch === "e" || ch === "E") { numberPhase = 5; return true; } return false;
      case 2: if (digit) return true; if (ch === ".") { numberPhase = 3; return true; } if (ch === "e" || ch === "E") { numberPhase = 5; return true; } return false;
      case 3: if (digit) { numberPhase = 4; return true; } return false;
      case 4: if (digit) return true; if (ch === "e" || ch === "E") { numberPhase = 5; return true; } return false;
      case 5: if (ch === "+" || ch === "-") { numberPhase = 6; return true; } if (digit) { numberPhase = 7; return true; } return false;
      case 6: if (digit) { numberPhase = 7; return true; } return false;
      default: return digit;
    }
  };
  // Length of the number text that is itself a valid number.
  var numberValidLength = function () {
    var length = raw.length - numberStart;
    if (numberPhase === 0) return 0;
    if (numberPhase === 3 || numberPhase === 5) return length - 1;
    if (numberPhase === 6) return length - 2;
    return length;
  };
  var structural = function (ch, at) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return;
    var frame = top();
    if (ch === "{" || ch === "[") {
      if (!expectsValue()) return;
      started = true;
      commaAt = -1;
      stack.push({ object: ch === "{", phase: ch === "{" ? 0 : 10, cut: at + 1 });
      return;
    }
    if (ch === "}") {
      if (frame && frame.object && (frame.phase === 0 || frame.phase === 3)) { stack.pop(); commaAt = -1; valueEnded(at + 1); }
      return;
    }
    if (ch === "]") {
      if (frame && !frame.object && (frame.phase === 10 || frame.phase === 11)) { stack.pop(); commaAt = -1; valueEnded(at + 1); }
      return;
    }
    if (ch === ":") {
      if (frame && frame.object && frame.phase === 1) frame.phase = 2;
      return;
    }
    if (ch === ",") {
      if (frame && frame.phase === 3) { frame.phase = 4; commaAt = at; }
      else if (frame && frame.phase === 11) { frame.phase = 12; commaAt = at; }
      return;
    }
    if (ch === '"') {
      if (expectsKey()) { stringIsKey = true; }
      else if (expectsValue()) { stringIsKey = false; }
      else return;
      started = true;
      commaAt = -1;
      token = 1;
      return;
    }
    if (!expectsValue()) return;
    started = true;
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      commaAt = -1;
      token = 4;
      numberStart = at;
      numberPhase = ch === "-" ? 0 : ch === "0" ? 1 : 2;
      return;
    }
    var word = ch === "t" ? "true" : ch === "f" ? "false" : ch === "n" ? "null" : "";
    if (word) {
      commaAt = -1;
      token = 5;
      literal = word;
      literalIndex = 1;
    }
  };
  var consume = function (ch, at) {
    if (token === 1) {
      if (ch === '"') {
        token = 0;
        if (stringIsKey) { top().phase = 1; } else { valueEnded(at + 1); }
      } else if (ch === "\\") {
        token = 2;
        escapeStart = at;
      }
      return true;
    }
    if (token === 2) { if (ch === "u") { token = 3; unicodeLeft = 4; } else { token = 1; } return true; }
    if (token === 3) { unicodeLeft -= 1; if (unicodeLeft === 0) token = 1; return true; }
    if (token === 4) {
      if (numberAccepts(ch)) return true;
      token = 0;
      if (numberIsWhole()) valueEnded(at);
      return false; // re-read ch as structure
    }
    if (token === 5) {
      if (ch === literal.charAt(literalIndex)) {
        literalIndex += 1;
        if (literalIndex === literal.length) { token = 0; valueEnded(at + 1); }
        return true;
      }
      token = 0;
      return false;
    }
    structural(ch, at);
    return true;
  };
  var write = function (text) {
    if (done || typeof text !== "string") return;
    for (var i = 0; i < text.length; i += 1) {
      if (done) { text = text.slice(0, i); break; }
      var at = raw.length + i;
      var ch = text.charAt(i);
      // A completed number or literal hands its terminating character back.
      if (!consume(ch, at)) consume(ch, at);
    }
    raw += text;
  };
  var healed = function () {
    if (done) return raw;
    if (raw.length === 0) return "";
    var frame = top();
    var pendingKey = !!frame && frame.object &&
      ((token !== 0 && (frame.phase === 0 || frame.phase === 4)) ||
       (token === 0 && (frame.phase === 1 || frame.phase === 2)));
    var body;
    var tail = "";
    if (pendingKey) {
      body = raw.slice(0, frame.cut);
    } else if (token === 4 && !numberIsWhole()) {
      var valid = numberValidLength();
      body = valid > 0 ? raw.slice(0, numberStart + valid) : frame ? raw.slice(0, frame.cut) : "";
    } else if (token === 2 || token === 3) {
      body = raw.slice(0, escapeStart);
      tail = '"';
    } else if (token === 0 && commaAt >= 0) {
      body = raw.slice(0, commaAt);
    } else {
      body = raw;
      if (token === 1) tail = '"';
      else if (token === 5) tail = literal.slice(literalIndex);
    }
    for (var depth = stack.length - 1; depth >= 0; depth -= 1) tail += stack[depth].object ? "}" : "]";
    return body + tail;
  };
  var reset = function () {
    raw = ""; stack = []; token = 0; stringIsKey = false; escapeStart = -1; unicodeLeft = 0;
    numberStart = -1; numberPhase = 0; literal = ""; literalIndex = 0; commaAt = -1; started = false; done = false;
  };
  return { write: write, healed: healed, reset: reset, complete: function () { return done; } };
}`;

/** Id of the style element the receiver adds while printing. */
export const MCP_APP_PRINT_FORCE_LIGHT_ID = "moss-print-force-light";

/**
 * Appended to every widget document. On the proxy's `moss:print-theme` message
 * it flips the widget to light for printing and restores it afterwards; a
 * widget whose `data-mode` was a theme follows the latest host theme on
 * restore. The widget never flips on its own.
 */
export const MCP_APP_PRINT_RECEIVER_SOURCE = String.raw`(function () {
  var TYPE = "${MCP_APP_SANDBOX_PRINT_THEME_TYPE}";
  var FORCE_ID = "${MCP_APP_PRINT_FORCE_LIGHT_ID}";
  var before = null;
  var isTheme = function (value) { return value === "light" || value === "dark"; };
  var flip = function () {
    if (before) return;
    var root = document.documentElement;
    before = { scheme: root.style.colorScheme, mode: root.getAttribute("data-mode") };
    root.style.colorScheme = "light";
    var force = document.createElement("style");
    force.id = FORCE_ID;
    force.textContent = ":root, * { color-scheme: light !important; }";
    (document.head || root).appendChild(force);
    if (before.mode === null || isTheme(before.mode)) root.setAttribute("data-mode", "light");
  };
  var restore = function (theme) {
    if (!before) return;
    var saved = before;
    before = null;
    var root = document.documentElement;
    var force = document.getElementById(FORCE_ID);
    if (force) force.remove();
    if (isTheme(saved.mode)) {
      if (isTheme(theme)) {
        root.style.colorScheme = theme;
        root.setAttribute("data-mode", theme);
      } else {
        root.style.colorScheme = "";
        root.removeAttribute("data-mode");
      }
    } else {
      root.style.colorScheme = saved.scheme;
      if (saved.mode === null) root.removeAttribute("data-mode");
    }
  };
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.type !== TYPE) return;
    if (data.phase === "before") flip();
    else if (data.phase === "after") restore(isTheme(data.theme) ? data.theme : "");
  });
})();`;

/**
 * Appended to every widget document. A widget is its own page in Moss, so wheel it does not
 * use would stop at its edge; in Claude the frame sits in the page and the scroll carries on.
 * This reports that leftover wheel to the proxy as `moss:wheel`: per axis, only when nothing
 * between the target and the page could scroll that way, and only if the widget did not
 * cancel the event. Pinch-zoom (ctrl+wheel) is left alone. Lines and pages become pixels.
 * The report goes out in the next task (a MessageChannel message), not the next animation
 * frame: a covered or background widget runs no frames, and its wheel must not wait for one.
 */
export const MCP_APP_WHEEL_RELAY_SOURCE = String.raw`(function () {
  var TYPE = "${MCP_APP_SANDBOX_WHEEL_TYPE}";
  var scrollable = function (value) { return value === "auto" || value === "scroll" || value === "overlay"; };
  var rootOf = function () { return document.scrollingElement || document.documentElement; };
  var canScroll = function (element, axis, delta) {
    var style;
    try { style = window.getComputedStyle(element); } catch (error) { return false; }
    var overflow = axis === "y" ? style.overflowY : style.overflowX;
    var isRoot = element === rootOf();
    if (isRoot ? overflow === "hidden" : !scrollable(overflow)) return false;
    var position = axis === "y" ? element.scrollTop : element.scrollLeft;
    var size = axis === "y" ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth;
    if (!(size > 1)) return false;
    return delta < 0 ? position > 0 : position < size - 1;
  };
  var used = function (target, axis, delta) {
    if (delta === 0) return true;
    var root = rootOf();
    for (var element = target; element && element.nodeType === 1; element = element.parentElement) {
      if (canScroll(element, axis, delta)) return true;
      if (element === root) return false;
    }
    return root ? canScroll(root, axis, delta) : false;
  };
  var pending = [];
  var nextTask = null;
  try {
    var channel = new MessageChannel();
    nextTask = function () { channel.port2.postMessage(0); };
    channel.port1.onmessage = function () { flush(); };
  } catch (error) {
    nextTask = function () { setTimeout(flush, 0); };
  }
  var flush = function () {
    var deltaX = 0;
    var deltaY = 0;
    for (var index = 0; index < pending.length; index += 1) {
      if (pending[index].event.defaultPrevented) continue;
      deltaX += pending[index].x;
      deltaY += pending[index].y;
    }
    pending = [];
    if (deltaX === 0 && deltaY === 0) return;
    try { window.parent.postMessage({ type: TYPE, deltaX: deltaX, deltaY: deltaY }, "*"); } catch (error) {}
  };
  window.addEventListener("wheel", function (event) {
    if (event.ctrlKey || window.parent === window) return;
    var x = event.deltaX;
    var y = event.deltaY;
    if (event.deltaMode === 1) { x *= 16; y *= 16; }
    if (event.deltaMode === 2) { x *= window.innerWidth; y *= window.innerHeight; }
    if (!isFinite(x) || !isFinite(y)) return;
    var target = event.target && event.target.nodeType === 1 ? event.target : rootOf();
    if (used(target, "x", x)) x = 0;
    if (used(target, "y", y)) y = 0;
    if (x === 0 && y === 0) return;
    // defaultPrevented is read in the next task, once every listener has run.
    if (pending.length === 0) nextTask();
    pending.push({ event: event, x: x, y: y });
  }, { passive: true });
})();`;

/**
 * The proxy's side: `createMossWheelCoalescer(post, schedule)` returns `push(data)`. For a
 * widget's `moss:wheel` message it keeps finite numbers only and adds them up; `schedule`
 * (the next task) sends the sum once with `post(deltaX, deltaY)`. Nothing is lost: a sum over
 * the per-message limit goes out in limit-sized pieces. It returns true for wheel messages
 * (malformed ones are dropped) and false for anything else.
 */
export const MCP_APP_WHEEL_COALESCER_SOURCE = String.raw`function createMossWheelCoalescer(post, schedule) {
  var TYPE = "${MCP_APP_SANDBOX_WHEEL_TYPE}";
  var MAX = ${MCP_APP_SANDBOX_WHEEL_MAX_DELTA};
  var deltaX = 0;
  var deltaY = 0;
  var scheduled = false;
  var clamp = function (value) { return Math.max(-MAX, Math.min(MAX, value)); };
  var flush = function () {
    scheduled = false;
    var x = clamp(deltaX);
    var y = clamp(deltaY);
    deltaX -= x;
    deltaY -= y;
    if (x !== 0 || y !== 0) post(x, y);
    if (deltaX !== 0 || deltaY !== 0) {
      scheduled = true;
      schedule(flush);
    }
  };
  return function push(data) {
    if (!data || typeof data !== "object" || data.type !== TYPE) return false;
    if (Object.keys(data).length !== 3 || typeof data.deltaX !== "number" || typeof data.deltaY !== "number" ||
        !isFinite(data.deltaX) || !isFinite(data.deltaY)) return true;
    // One message is clamped on its own; it carries at most a few wheel ticks.
    deltaX += clamp(data.deltaX);
    deltaY += clamp(data.deltaY);
    if (!scheduled) {
      scheduled = true;
      schedule(flush);
    }
    return true;
  };
}`;

/** The print receiver and the wheel relay, as markup appended after the widget HTML. */
export const MCP_APP_PRINT_RECEIVER_HTML = `\n<script>${MCP_APP_PRINT_RECEIVER_SOURCE}</script>\n<script>${MCP_APP_WHEEL_RELAY_SOURCE}</script>`;
