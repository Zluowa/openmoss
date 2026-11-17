// Simulates a WebMCP browser (like ChatGPT site tools, or Moss's built-in browser shim)
// so we can see exactly what a host receives from registerTools.
const registered = []
// ?raf=timer: stand in for animation frames, which a hidden/background page never gets.
if (new URLSearchParams(location.search).get("raf") === "timer") {
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16)
  window.cancelAnimationFrame = (id) => clearTimeout(id)
}
if (!document.modelContext) {
  document.modelContext = {
    registerTool(tool, options) {
      registered.push(tool)
      return Promise.resolve()
    },
  }
}

import "@ui-sdk/web/field"
import "@ui-sdk/web/input"
import "@ui-sdk/web/select"
import "@ui-sdk/web/switch"
import "@ui-sdk/web/button"
import { createAgent, registerTools, agentTools } from "@ui-sdk/web/agent"

const log = []
const agent = createAgent()
const unregister = registerTools(agent, {
  allow: (step) => {
    log.push({ asked: step })
    return !step.confirm
  },
})

document.querySelector("#save").addEventListener("click", () => {
  document.querySelector("#status").textContent = "已保存 " + new Date().toLocaleTimeString()
})

Object.assign(window, { agent, registered, agentTools, allowLog: log, unregister })
