(()=>{var{defineProperty:z,getOwnPropertyNames:Tt,getOwnPropertyDescriptor:St}=Object,At=Object.prototype.hasOwnProperty;function Bt(t){return this[t]}var Lt=(t)=>{var e=(dt??=new WeakMap).get(t),s;if(e)return e;if(e=z({},"__esModule",{value:!0}),t&&typeof t==="object"||typeof t==="function"){for(var i of Tt(t))if(!At.call(e,i))z(e,i,{get:Bt.bind(t,i),enumerable:!(s=St(t,i))||s.enumerable})}return dt.set(t,e),e},dt;var It=(t)=>t;function Ot(t,e){this[t]=It.bind(null,e)}var Ht=(t,e)=>{for(var s in e)z(t,s,{get:e[s],enumerable:!0,configurable:!0,set:Ot.bind(e,s)})};var Xt={};Ht(Xt,{MOSS_UI_KIT_CATALOG:()=>P,MOSS_UI_KIT_CLASSIC_URLS:()=>_,MOSS_UI_KIT_MODULE_URLS:()=>y,MOSS_UI_KIT_RECIPES:()=>U,MOSS_UI_KIT_TOKENS_CSS:()=>D,MOSS_UI_KIT_VERSION:()=>x,MossBadge:()=>I,MossButton:()=>T,MossCard:()=>S,MossCompanionDrawer:()=>w,MossDialog:()=>L,MossDrawer:()=>B,MossMarkdown:()=>O,MossMediaTrigger:()=>M,MossRealtimeVoiceBar:()=>N,MossSelectionAsk:()=>k,MossTabs:()=>A,MossToast:()=>f,MossVoiceButton:()=>H,MossbotMeetingBar:()=>C,default:()=>Yt,mountBadge:()=>it,mountButton:()=>Y,mountCard:()=>Z,mountCompanionDrawer:()=>J,mountDialog:()=>st,mountDrawer:()=>et,mountMarkdown:()=>nt,mountMediaTrigger:()=>X,mountMossbotMeetingBar:()=>Q,mountRealtimeVoiceBar:()=>at,mountSelectionAsk:()=>q,mountTabs:()=>tt,mountVoiceButton:()=>ot,registerMossPrimitives:()=>g,registerMossUIKit:()=>rt,registerMossVoiceComponents:()=>R});var x="1.0.0",_=["https://cdn.jsdelivr.net/npm/@moss/ui-kit@1.0.0/dist/moss-ui-kit.umd.js","https://cdn.jsdelivr.net/npm/@moss/ui-kit@1.0.0/dist/moss-ui-kit.min.js","https://unpkg.com/@moss/ui-kit@1.0.0/dist/moss-ui-kit.umd.js","https://unpkg.com/@moss/ui-kit@1.0.0/dist/moss-ui-kit.min.js"],y=["moss-ui-kit","https://cdn.jsdelivr.net/npm/@moss/ui-kit@1.0.0/+esm","https://unpkg.com/@moss/ui-kit@1.0.0/+esm"],D=`
:host {
  color-scheme: light dark;
  --moss-paper: #fcfcfb;
  --moss-surface: #f4f3ef;
  --moss-card: #fdfdfc;
  --moss-popover: rgba(253, 253, 252, 0.94);
  --moss-ink: #141413;
  --moss-ink-2: rgba(20, 20, 19, 0.62);
  --moss-ink-3: rgba(20, 20, 19, 0.42);
  --moss-border: rgba(20, 20, 19, 0.08);
  --moss-border-strong: rgba(20, 20, 19, 0.14);
  --moss-hover: rgba(20, 20, 19, 0.04);
  --moss-active: rgba(20, 20, 19, 0.08);
  --moss-accent: #2a78d6;
  --moss-accent-soft: rgba(42, 120, 214, 0.12);
  --moss-coral: #d97757;
  --moss-coral-soft: rgba(217, 119, 87, 0.14);
  --moss-success: #00a240;
  --moss-success-soft: rgba(0, 162, 64, 0.10);
  --moss-warn: #d97706;
  --moss-warn-soft: rgba(217, 119, 6, 0.12);
  --moss-danger: #e02e2a;
  --moss-danger-soft: rgba(224, 46, 42, 0.10);
  --moss-shadow-popover: 0 8px 24px rgba(20, 20, 19, 0.08), 0 1px 2px rgba(20, 20, 19, 0.04);
  --moss-radius-control: 8px;
  --moss-radius-card: 12px;
  --moss-radius-popover: 12px;
  --moss-radius-pill: 999px;
  --moss-font: "Inter Variable", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif;
  --moss-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"])) {
    --moss-paper: #1c1c1b;
    --moss-surface: #1a1a19;
    --moss-card: #1e1e1d;
    --moss-popover: rgba(33, 33, 32, 0.94);
    --moss-ink: #f0efec;
    --moss-ink-2: rgba(240, 239, 236, 0.60);
    --moss-ink-3: rgba(240, 239, 236, 0.38);
    --moss-border: rgba(240, 239, 236, 0.09);
    --moss-border-strong: rgba(240, 239, 236, 0.16);
    --moss-hover: rgba(240, 239, 236, 0.05);
    --moss-active: rgba(240, 239, 236, 0.10);
    --moss-accent: #3987e5;
    --moss-accent-soft: rgba(57, 135, 229, 0.18);
    --moss-coral: #d97757;
    --moss-coral-soft: rgba(217, 119, 87, 0.20);
    --moss-success: #00a240;
    --moss-success-soft: rgba(0, 162, 64, 0.18);
    --moss-warn: #f5b44a;
    --moss-warn-soft: rgba(245, 180, 74, 0.16);
    --moss-danger: #e02e2a;
    --moss-danger-soft: rgba(224, 46, 42, 0.18);
    --moss-shadow-popover: 0 10px 28px rgba(0, 0, 0, 0.36), 0 1px 2px rgba(0, 0, 0, 0.24);
  }
}

:host([theme="dark"]),
:host-context([data-theme="dark"]),
:host-context(.dark) {
  --moss-paper: #1c1c1b;
  --moss-surface: #1a1a19;
  --moss-card: #1e1e1d;
  --moss-popover: rgba(33, 33, 32, 0.94);
  --moss-ink: #f0efec;
  --moss-ink-2: rgba(240, 239, 236, 0.60);
  --moss-ink-3: rgba(240, 239, 236, 0.38);
  --moss-border: rgba(240, 239, 236, 0.09);
  --moss-border-strong: rgba(240, 239, 236, 0.16);
  --moss-hover: rgba(240, 239, 236, 0.05);
  --moss-active: rgba(240, 239, 236, 0.10);
  --moss-accent: #3987e5;
  --moss-accent-soft: rgba(57, 135, 229, 0.18);
  --moss-coral: #d97757;
  --moss-coral-soft: rgba(217, 119, 87, 0.20);
  --moss-success: #00a240;
  --moss-success-soft: rgba(0, 162, 64, 0.18);
  --moss-warn: #f5b44a;
  --moss-warn-soft: rgba(245, 180, 74, 0.16);
  --moss-danger: #e02e2a;
  --moss-danger-soft: rgba(224, 46, 42, 0.18);
  --moss-shadow-popover: 0 10px 28px rgba(0, 0, 0, 0.36), 0 1px 2px rgba(0, 0, 0, 0.24);
}
`.trim(),ct=`
${D}

:host {
  all: initial;
  display: block;
  font-family: var(--moss-font);
  font-size: 14px;
  line-height: 20px;
  font-weight: 400;
  color: var(--moss-ink);
  -webkit-font-smoothing: antialiased;
}

*, *::before, *::after {
  box-sizing: border-box;
}

button, input, textarea {
  font: inherit;
  color: inherit;
}

button {
  cursor: pointer;
  border: 0;
  background: transparent;
  padding: 0;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.moss-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--moss-radius-control);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
  font-size: 13px;
  line-height: 17px;
  font-weight: 500;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.moss-btn:hover:not(:disabled) {
  background: var(--moss-hover);
}

.moss-btn:active:not(:disabled) {
  background: var(--moss-active);
}

.moss-btn-primary {
  background: var(--moss-ink);
  color: var(--moss-paper);
  border-color: transparent;
}

.moss-btn-primary:hover:not(:disabled) {
  background: var(--moss-ink);
  color: var(--moss-paper);
  opacity: 0.88;
}

.moss-btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--moss-ink-2);
}

.moss-btn-ghost:hover:not(:disabled) {
  background: var(--moss-hover);
  color: var(--moss-ink);
}

.moss-input {
  height: 28px;
  min-width: 0;
  padding: 0 10px;
  border-radius: var(--moss-radius-control);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-paper);
  color: var(--moss-ink);
  font-size: 13px;
  line-height: 17px;
  outline: none;
}

.moss-input::placeholder {
  color: var(--moss-ink-3);
}

.moss-input:focus {
  border-color: var(--moss-accent);
}
`.trim();var P=[{name:"MossButton",tag:"moss-button",mountHelper:"mountButton",category:"primitive",capability:"none",description:"标准高度与语义变体按钮（primary/secondary/ghost/destructive）",snippet:'<moss-button variant="primary" label="保存设置"></moss-button>'},{name:"MossCard",tag:"moss-card",mountHelper:"mountCard",category:"primitive",capability:"none",description:"暖白/暖黑 12px 圆角与 1px 细线卡片容器",snippet:'<moss-card title="项目概览" subtitle="最近更新"></moss-card>'},{name:"MossTabs",tag:"moss-tabs",mountHelper:"mountTabs",category:"primitive",capability:"none",description:"克制切换栏与面板容器（监听 moss-tab-change）",snippet:`<moss-tabs tabs='[{"id":"notes","label":"笔记"},{"id":"ai","label":"伴读"}]'></moss-tabs>`},{name:"MossDrawer",tag:"moss-drawer",mountHelper:"mountDrawer",category:"primitive",capability:"none",description:"可折叠侧边抽屉面板",snippet:'<moss-drawer title="详情侧栏">内容区</moss-drawer>'},{name:"MossDialog",tag:"moss-dialog",mountHelper:"mountDialog",category:"primitive",capability:"none",description:"带 Esc 与遮罩关闭的无障碍弹窗",snippet:'<moss-dialog title="确认操作" description="操作后可随时在权限里更改"></moss-dialog>'},{name:"MossBadge",tag:"moss-badge",mountHelper:"mountBadge",category:"primitive",capability:"none",description:"8% 浅底同色语义徽标（neutral/accent/success/warn/danger）",snippet:'<moss-badge variant="success" label="已同步"></moss-badge>'},{name:"MossToast",tag:"moss-toast",mountHelper:"MossToast.show",category:"primitive",capability:"none",description:"右下角克制轻提示条（支持 MossToast.show）",snippet:'MossToast.show("已保存批注", { variant: "success" });'},{name:"MossMarkdown",tag:"moss-markdown",mountHelper:"mountMarkdown",category:"primitive",capability:"none",description:"纯 DOM 安全的 Markdown 正文与代码块渲染器",snippet:'<moss-markdown content="## 本章小结\\n- 重点结论"></moss-markdown>'},{name:"MossVoiceButton",tag:"moss-voice-button",mountHelper:"mountVoiceButton",category:"voice",capability:"voice",description:"对齐聊天麦克风与朗读按钮的语音转文字 / TTS 控件",snippet:'<moss-voice-button mode="dictate"></moss-voice-button>'},{name:"MossRealtimeVoiceBar",tag:"moss-realtime-voice-bar",mountHelper:"mountRealtimeVoiceBar",category:"voice",capability:"voice",description:"带实时声波条与计时的 Moss 实时语音控制条",snippet:'<moss-realtime-voice-bar topic="产品评审"></moss-realtime-voice-bar>'},{name:"MossSelectionAsk",tag:"moss-selection-ask",mountHelper:"mountSelectionAsk",category:"feature",capability:"chat",description:"划词三色高亮与「划线提问 / 问 Moss」悬浮操作条",snippet:'<moss-selection-ask target="#article" drawer="#reader-drawer"></moss-selection-ask>'},{name:"MossCompanionDrawer",tag:"moss-companion-drawer",mountHelper:"mountCompanionDrawer",category:"feature",capability:"chat",description:"流式伴读与上下文追问侧栏抽屉",snippet:'<moss-companion-drawer id="reader-drawer" title="Moss 伴读"></moss-companion-drawer>'},{name:"MossbotMeetingBar",tag:"moss-bot-meeting-bar",mountHelper:"mountMossbotMeetingBar",category:"feature",capability:"mossbot",description:"一键拉 Moss 加入会议、会中提问与生成结构化纪要",snippet:'<moss-bot-meeting-bar meeting-title="周会同步"></moss-bot-meeting-bar>'},{name:"MossMediaTrigger",tag:"moss-media-trigger",mountHelper:"mountMediaTrigger",category:"feature",capability:"media",description:"内联配图与短视频生成触发及预览器",snippet:'<moss-media-trigger kind="image" prompt="极简架构示意图"></moss-media-trigger>'}],U={version:x,esmImport:`import { registerMossUIKit, MossToast } from "${y[0]}";
registerMossUIKit();`,esmCdnImport:`import { registerMossUIKit } from "${y[1]}";
registerMossUIKit();`,classicScript:`<script src="${_[0]}"></script>`,wechatReadCombo:`<moss-companion-drawer id="drawer" title="Moss 伴读"></moss-companion-drawer>
<moss-selection-ask target="#book-body" drawer="#drawer"></moss-selection-ask>`,meetingRoomCombo:`<moss-realtime-voice-bar topic="产品规划会"></moss-realtime-voice-bar>
<moss-bot-meeting-bar meeting-title="产品规划会"></moss-bot-meeting-bar>
<moss-media-trigger kind="image" prompt="会议重点架构图"></moss-media-trigger>`};var c=typeof HTMLElement==="function"?HTMLElement:class{},h="http://www.w3.org/2000/svg";function V(t=14){let e=document.createElementNS(h,"svg");e.setAttribute("width",String(t)),e.setAttribute("height",String(t)),e.setAttribute("viewBox","0 0 16 16"),e.setAttribute("fill","none"),e.setAttribute("aria-hidden","true");let s=document.createElementNS(h,"path");return s.setAttribute("d","M8 1.5c1.1 0 2 .9 2 2v2.4l1.7-1.7a2 2 0 1 1 2.8 2.8L12.8 8.7H15a2 2 0 1 1 0 4h-2.4l1.7 1.7a2 2 0 1 1-2.8 2.8L9.8 15.5c-.6.3-1.2.5-1.8.5s-1.2-.2-1.8-.5l-1.7 1.7a2 2 0 1 1-2.8-2.8L3.4 12.7H1a2 2 0 1 1 0-4h2.2L1.5 7a2 2 0 1 1 2.8-2.8L6 5.9V3.5c0-1.1.9-2 2-2Z"),s.setAttribute("fill","var(--moss-coral)"),e.appendChild(s),e}function mt(t=15){let e=document.createElementNS(h,"svg");e.setAttribute("width",String(t)),e.setAttribute("height",String(t)),e.setAttribute("viewBox","0 0 24 24"),e.setAttribute("fill","none"),e.setAttribute("stroke","currentColor"),e.setAttribute("stroke-width","1.9"),e.setAttribute("stroke-linecap","round"),e.setAttribute("stroke-linejoin","round"),e.setAttribute("aria-hidden","true");let s=document.createElementNS(h,"rect");s.setAttribute("x","9"),s.setAttribute("y","2"),s.setAttribute("width","6"),s.setAttribute("height","12"),s.setAttribute("rx","3");let i=document.createElementNS(h,"path");i.setAttribute("d","M5 10v2a7 7 0 0 0 14 0v-2");let n=document.createElementNS(h,"path");return n.setAttribute("d","M12 19v3"),e.appendChild(s),e.appendChild(i),e.appendChild(n),e}function W(t=15){let e=document.createElementNS(h,"svg");e.setAttribute("width",String(t)),e.setAttribute("height",String(t)),e.setAttribute("viewBox","0 0 24 24"),e.setAttribute("fill","none"),e.setAttribute("stroke","currentColor"),e.setAttribute("stroke-width","1.9"),e.setAttribute("stroke-linecap","round"),e.setAttribute("stroke-linejoin","round"),e.setAttribute("aria-hidden","true");let s=document.createElementNS(h,"polygon");s.setAttribute("points","11 5 6 9 2 9 2 15 6 15 11 19 11 5");let i=document.createElementNS(h,"path");i.setAttribute("d","M15.54 8.46a5 5 0 0 1 0 7.07");let n=document.createElementNS(h,"path");return n.setAttribute("d","M19.07 4.93a10 10 0 0 1 0 14.14"),e.appendChild(s),e.appendChild(i),e.appendChild(n),e}function pt(t=!1){let e=document.createElement("span");if(e.setAttribute("aria-hidden","true"),e.setAttribute("data-moss-realtime-voice-bars-icon","true"),e.style.display="inline-flex",e.style.width="16px",e.style.height="16px",e.style.alignItems="center",e.style.justifyContent="center",e.style.gap="1.2px",t)e.style.opacity="0.75";for(let s of[4.15,12.17,6.83,9.5,4.15]){let i=document.createElement("span");i.style.display="block",i.style.width="1.5px",i.style.height=`${s}px`,i.style.borderRadius="999px",i.style.backgroundColor="currentColor",e.appendChild(i)}return e}function m(t,e){let s=t.shadowRoot??t.attachShadow({mode:"open"});s.textContent="";let i=document.createElement("style");return i.textContent=`${ct}
${e}`,s.appendChild(i),s}function Nt(){if(typeof globalThis>"u")return null;let t=globalThis.moss;return t&&typeof t.use==="function"?t:null}async function u(t){let e=Nt();if(!e?.use)return null;try{let s=await e.use(t);return s&&typeof s==="object"?s:null}catch{return null}}function p(t){if(typeof t==="string")return t;if(t&&typeof t==="object"){let e=t;if(typeof e.text==="string")return e.text;if(typeof e.summary==="string")return e.summary;if(typeof e.answer==="string")return e.answer;if(typeof e.content==="string")return e.content;if(typeof e.message==="string")return e.message}return""}function ut(t){if(typeof t!=="string"||!t)return!1;if(t.startsWith("data:")||t.startsWith("blob:")||t.startsWith("/"))return!0;let e=typeof location<"u"?location.origin:"";return Boolean(e&&e!=="null"&&t.startsWith(`${e}/`))}function ht(t){if(!t||typeof t!=="object")return;let e=t;for(let s of["url","src","dataUrl","imageUrl","videoUrl","thumbnailUrl"]){let i=e[s];if(ut(i))return i}for(let s of["urls","dataUrls","assetPaths"]){let i=e[s];if(Array.isArray(i)){for(let n of i)if(ut(n))return n}}return}async function v(t){let e=t.prompt.trim()||"请解读这段内容",s=await u("chat");if(s){if(t.preferSidechat&&typeof s.openSidechat==="function")try{let n=await s.openSidechat({prompt:e,...t.selectionText?{selectionText:t.selectionText}:{},...t.context?{context:t.context}:{},...t.appTitle?{appTitle:t.appTitle}:{}});return{via:"chat",text:p(n)||"已在 Moss 侧边栏打开上下文对话。",openedSidechat:!0}}catch{}if(typeof s.ask==="function"){let n="";try{let o=await s.ask({prompt:e,...t.selectionText?{selectionText:t.selectionText}:{},...t.context?{context:t.context}:{},...t.appTitle?{appTitle:t.appTitle}:{}},{onText:(r)=>{n+=r,t.onText?.(r,n)}}),a=n||p(o);if(a)return{via:"chat",text:a}}catch{}}if(typeof s.summon==="function")try{let n=await s.summon({prompt:e,...t.selectionText?{selectionText:t.selectionText}:{},...t.context?{context:t.context}:{}});return{via:"chat",text:p(n)||"已唤醒 Moss 伴读对话。",openedSidechat:!0}}catch{}}let i=await u("ai");if(i&&typeof i.ask==="function"){let n="",o=["你是 Moss 原生伴读与助手组件，请用简洁平实的简体中文作答。",t.appTitle?`当前应用：${t.appTitle}`:"",t.selectionText?`用户划选片段：
${t.selectionText}`:"",t.context?`上下文：
${t.context}`:""].filter(Boolean).join(`

`),a=await i.ask(e,{system:o,maxTokens:800,onText:(l)=>{n+=l,t.onText?.(l,n)}});return{via:"ai",text:n||p(a)||"未收到回答，请重试。"}}return{via:"fallback",text:"当前环境未开启对话或 AI 能力，请在 Moss 权限中允许访问后重试。"}}var Rt="moss-default-meeting";function K(t){let e=t?.trim();return e&&e.length>0?e:Rt}async function gt(t){let e=K(t.meetingId),s=await u("mossbot");if(s&&typeof s.joinMeeting==="function")try{let i=await s.joinMeeting({meetingId:e,title:t.title,...t.topic?{topic:t.topic}:{}});return{via:"mossbot",joined:!0,statusText:p(i)||"Mossbot 已加入会议"}}catch{}return{via:"fallback",joined:!0,statusText:"Moss 已进入本地伴会模式"}}async function bt(t){let e=K(t.meetingId),s=await u("mossbot");if(s&&typeof s.summarizeMeeting==="function")try{let o=await s.summarizeMeeting({meetingId:e,title:t.title,transcript:t.transcript}),a=p(o);if(a)return{via:"mossbot",summary:a}}catch{}let i=`请为会议《${t.title}》生成结构化简体中文纪要（含关键结论与行动项）：

${t.transcript}`,n=await v({prompt:i,context:t.transcript,appTitle:t.title});if(n.via==="chat"||n.via==="ai")return{via:n.via,summary:n.text};return{via:"fallback",summary:`《${t.title}》会议纪要占位：
当前环境未开启 Mossbot 或 AI 能力，已整理会议记录共 ${t.transcript.length} 字。`}}async function vt(t){let e=K(t.meetingId),s=await u("mossbot");if(s&&typeof s.askInMeeting==="function")try{let n=await s.askInMeeting({meetingId:e,title:t.title,question:t.prompt,transcript:t.transcript}),o=p(n);if(o)return{via:"mossbot",summary:o}}catch{}let i=await v({prompt:t.prompt,context:t.transcript,appTitle:t.title});return{via:i.via,summary:i.text}}async function Et(t){let e=await u("media");if(e)try{let n=t.kind==="video"&&typeof e.generateVideo==="function"?await e.generateVideo({prompt:t.prompt}):typeof e.generateImage==="function"?await e.generateImage({prompt:t.prompt}):null;if(n){let o=ht(n);if(o)return{via:"media",kind:t.kind,url:o,status:"ready",text:p(n)||"已生成媒体资源"};let a=n,r=typeof a.jobId==="string"?a.jobId:typeof a.id==="string"?a.id:void 0;if(r&&typeof e.getJob==="function"){for(let l=0;l<6;l+=1){let d=await e.getJob(r),b=ht(d);if(b)return{via:"media",kind:t.kind,jobId:r,url:b,status:"ready",text:p(d)||"已生成媒体资源"};let lt=d?.status;if(lt==="failed"||lt==="error")break;await new Promise((Mt)=>setTimeout(Mt,150))}return{via:"media",kind:t.kind,jobId:r,status:"pending",text:"已提交媒体生成任务，请稍候查看。"}}}}catch{}let s=t.kind==="video"?`请基于以下需求给出可直接使用的短视频分镜与提示词方案：${t.prompt}`:`请基于以下需求给出简洁的画面构图与生图提示词方案：${t.prompt}`,i=await v({prompt:s});return{via:i.via==="fallback"?"fallback":i.via,kind:t.kind,status:"fallback",text:i.via==="fallback"?"当前环境未开启媒体生成能力，可在权限中启用后直接出图。":i.text}}async function ft(t){let e=await u("voice");if(e&&typeof e.startListening==="function")try{let s=await e.startListening(t??{language:"zh-CN"});return{via:"voice",text:p(s),status:"listening"}}catch{}return{via:"fallback",text:"",status:"fallback"}}async function xt(t){let e=await u("voice");if(e)try{if(typeof e.stopListening==="function"){let s=await e.stopListening(),i=p(s);if(i)return{via:"voice",text:i,status:"recorded"}}if(typeof e.transcribe==="function"){let s=await e.transcribe(t??{language:"zh-CN"});return{via:"voice",text:p(s)||"已完成语音识别。",status:"recorded"}}}catch{}return{via:"fallback",text:"当前环境未开启语音转文字能力，请在 Moss 权限中开启后重试。",status:"fallback"}}async function F(t){let e=await u("voice");if(e&&typeof e.speak==="function")try{return await e.speak({text:t.text,...t.voice?{voice:t.voice}:{}}),{via:"voice",speaking:!0,statusText:"正在朗读内容"}}catch{}return{via:"fallback",speaking:!1,statusText:"当前环境未开启语音合成能力。"}}async function yt(){let t=await u("voice");if(t&&typeof t.stopSpeaking==="function")await t.stopSpeaking().catch(()=>{return})}async function kt(t){let e=await u("voice");if(e&&typeof e.startRealtimeSession==="function")try{let s=await e.startRealtimeSession(t??{}),i=s&&typeof s==="object"?s:{},n=typeof i.sessionId==="string"?i.sessionId:typeof i.id==="string"?i.id:void 0;return{via:"voice",active:!0,...n?{sessionId:n}:{},...p(s)?{transcript:p(s)}:{},statusText:"Moss 实时语音已连线"}}catch{}return{via:"fallback",active:!1,statusText:"当前环境未开启实时语音能力，请先授权语音访问。"}}async function wt(t){let e=await u("voice");if(e&&typeof e.stopRealtimeSession==="function")try{let s=await e.stopRealtimeSession(t??{});return{via:"voice",active:!1,...p(s)?{transcript:p(s)}:{},statusText:"实时语音已结束"}}catch{}return{via:"fallback",active:!1,statusText:"实时语音已结束"}}var G=[{id:"amber",label:"琥珀黄",dot:"#f59e0b",bg:"rgba(245, 158, 11, 0.24)"},{id:"blue",label:"晴空蓝",dot:"#38bdf8",bg:"rgba(56, 189, 248, 0.22)"},{id:"rose",label:"浅绯粉",dot:"#f43f5e",bg:"rgba(244, 63, 94, 0.20)"}];function _t(t,e,s){let i=G.find((n)=>n.id===e)??G[0];try{let n=document.createTreeWalker(t.commonAncestorContainer.nodeType===Node.ELEMENT_NODE?t.commonAncestorContainer:t.commonAncestorContainer.parentElement??s,NodeFilter.SHOW_TEXT),o=[],a=n.nextNode();while(a){let r=a;if(r.nodeValue&&r.nodeValue.trim().length>0&&s.contains(r)&&t.intersectsNode(r)){let l=r===t.startContainer?t.startOffset:0,d=r===t.endContainer?t.endOffset:r.nodeValue.length;if(d>l)o.push({node:r,start:l,end:d})}a=n.nextNode()}if(o.length===0)return!1;for(let r of o){let l=r.node;if(r.end<l.length)l.splitText(r.end);if(r.start>0)l=l.splitText(r.start);let d=document.createElement("mark");d.setAttribute("data-moss-ui-highlight",e),d.style.backgroundColor=i.bg,d.style.color="inherit",d.style.borderRadius="3px",d.style.padding="0 1px",l.parentNode?.insertBefore(d,l),d.appendChild(l)}return!0}catch{return!1}}var Dt=`
:host {
  position: fixed;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  z-index: 2147483000;
  pointer-events: none;
}

.popover {
  position: fixed;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 268px;
  max-width: min(380px, calc(100vw - 16px));
  padding: 6px 8px;
  border-radius: var(--moss-radius-popover);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-popover);
  backdrop-filter: blur(12px);
  box-shadow: var(--moss-shadow-popover);
}

.popover.hidden {
  display: none;
}

.row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.swatch-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--moss-radius-control);
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  color: var(--moss-ink);
  transition: background-color 120ms ease;
}

.swatch-btn:hover {
  background: var(--moss-hover);
}

.swatch-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--moss-radius-pill);
  flex-shrink: 0;
}

.divider {
  width: 1px;
  height: 16px;
  background: var(--moss-border-strong);
  margin: 0 2px;
}

.ask-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid var(--moss-border);
}

.ask-row.hidden {
  display: none;
}

.ask-row .moss-input {
  flex: 1;
}

.inline-answer {
  font-size: 13px;
  line-height: 19px;
  color: var(--moss-ink);
  background: var(--moss-surface);
  border: 1px solid var(--moss-border);
  border-radius: var(--moss-radius-control);
  padding: 8px 10px;
  max-height: 180px;
  overflow-y: auto;
  white-space: pre-wrap;
}

.inline-answer.hidden {
  display: none;
}
`;class k extends c{static get observedAttributes(){return["target","drawer","app-title","theme","auto-highlight","prefer-sidechat"]}targetEl=null;drawerEl=null;autoHighlight=!0;preferSidechat=!1;onHighlightCb=null;onAskCb=null;popoverEl;askRowEl;askInputEl;answerEl;savedRange=null;savedText="";listenersBound=!1;onSelectionTrigger=()=>{this.syncFromWindowSelection()};onDocMouseDown=(t)=>{let e=typeof t.composedPath==="function"?t.composedPath():[];if(e.includes(this)||e.includes(this.popoverEl))return;let s=window.getSelection();if(!s||s.isCollapsed)this.hide()};constructor(){super();let t=m(this,Dt);this.popoverEl=document.createElement("div"),this.popoverEl.className="popover hidden",this.popoverEl.setAttribute("role","dialog"),this.popoverEl.setAttribute("aria-label","Moss 划线操作条");let e=document.createElement("div");e.className="row";for(let a of G){let r=document.createElement("button");r.type="button",r.className="swatch-btn",r.setAttribute("data-moss-highlight-btn",a.id);let l=document.createElement("span");l.className="swatch-dot",l.style.background=a.dot,r.appendChild(l),r.appendChild(document.createTextNode(a.label)),r.addEventListener("mousedown",(d)=>d.preventDefault()),r.addEventListener("click",()=>this.applyHighlight(a.id)),e.appendChild(r)}let s=document.createElement("span");s.className="divider",e.appendChild(s);let i=document.createElement("button");i.type="button",i.className="moss-btn moss-btn-primary",i.setAttribute("data-moss-action","open-ask"),i.appendChild(V(13)),i.appendChild(document.createTextNode("划线提问")),i.addEventListener("mousedown",(a)=>a.preventDefault()),i.addEventListener("click",()=>{if(this.askRowEl.classList.contains("hidden"))this.askRowEl.classList.remove("hidden"),this.askInputEl.focus();else this.submitAsk()}),e.appendChild(i);let n=document.createElement("button");n.type="button",n.className="moss-btn moss-btn-ghost",n.setAttribute("aria-label","关闭"),n.textContent="×",n.addEventListener("mousedown",(a)=>a.preventDefault()),n.addEventListener("click",()=>this.hide()),e.appendChild(n),this.popoverEl.appendChild(e),this.askRowEl=document.createElement("div"),this.askRowEl.className="ask-row hidden",this.askInputEl=document.createElement("input"),this.askInputEl.type="text",this.askInputEl.className="moss-input",this.askInputEl.placeholder="对选中内容向 Moss 提问…",this.askInputEl.addEventListener("keydown",(a)=>{if(a.key==="Enter")a.preventDefault(),this.submitAsk();else if(a.key==="Escape")this.hide()});let o=document.createElement("button");o.type="button",o.className="moss-btn moss-btn-primary",o.setAttribute("data-moss-action","submit-ask"),o.textContent="问 Moss",o.addEventListener("mousedown",(a)=>a.preventDefault()),o.addEventListener("click",()=>void this.submitAsk()),this.askRowEl.appendChild(this.askInputEl),this.askRowEl.appendChild(o),this.popoverEl.appendChild(this.askRowEl),this.answerEl=document.createElement("div"),this.answerEl.className="inline-answer hidden",this.popoverEl.appendChild(this.answerEl),t.appendChild(this.popoverEl)}connectedCallback(){if(this.syncAttributes(),!this.listenersBound)this.listenersBound=!0,document.addEventListener("mouseup",this.onSelectionTrigger),document.addEventListener("keyup",this.onSelectionTrigger),document.addEventListener("selectionchange",this.onSelectionTrigger),document.addEventListener("mousedown",this.onDocMouseDown)}disconnectedCallback(){if(this.listenersBound)this.listenersBound=!1,document.removeEventListener("mouseup",this.onSelectionTrigger),document.removeEventListener("keyup",this.onSelectionTrigger),document.removeEventListener("selectionchange",this.onSelectionTrigger),document.removeEventListener("mousedown",this.onDocMouseDown)}attributeChangedCallback(){this.syncAttributes()}configure(t){if(t.target!==void 0)this.targetEl=typeof t.target==="string"?document.querySelector(t.target):t.target;if(t.drawer!==void 0)this.drawerEl=typeof t.drawer==="string"?document.querySelector(t.drawer):t.drawer;if(t.appTitle!==void 0)this.setAttribute("app-title",t.appTitle);if(t.theme&&t.theme!=="auto")this.setAttribute("theme",t.theme);if(t.autoHighlight!==void 0)this.autoHighlight=t.autoHighlight;if(t.preferSidechat!==void 0)this.preferSidechat=t.preferSidechat;if(t.onHighlight)this.onHighlightCb=t.onHighlight;if(t.onAsk)this.onAskCb=t.onAsk}showForRange(t){let e=t.toString().trim();if(!e)return;this.savedRange=t.cloneRange(),this.savedText=e;let s=t.getBoundingClientRect();this.positionNearRect(s)}hide(){this.popoverEl.classList.add("hidden"),this.askRowEl.classList.add("hidden"),this.answerEl.classList.add("hidden"),this.answerEl.textContent="",this.askInputEl.value="",this.savedRange=null,this.savedText=""}syncAttributes(){let t=this.getAttribute("target");if(t)this.targetEl=document.querySelector(t);let e=this.getAttribute("drawer");if(e)this.drawerEl=document.querySelector(e);let s=this.getAttribute("auto-highlight");if(s!==null)this.autoHighlight=s!=="false";let i=this.getAttribute("prefer-sidechat");if(i!==null)this.preferSidechat=i==="true"||i===""}resolveTarget(){if(this.targetEl)return this.targetEl;let t=this.getAttribute("target");if(t){if(this.targetEl=document.querySelector(t),this.targetEl)return this.targetEl}return document.body}resolveDrawer(){if(this.drawerEl)return this.drawerEl;let t=this.getAttribute("drawer");if(t)this.drawerEl=document.querySelector(t);return this.drawerEl}syncFromWindowSelection(){let t=window.getSelection();if(!t||t.rangeCount===0||t.isCollapsed)return;let e=t.getRangeAt(0);if(!e.toString().trim())return;let i=this.resolveTarget();if(!i.contains(e.startContainer)||!i.contains(e.endContainer))return;this.showForRange(e)}positionNearRect(t){this.popoverEl.classList.remove("hidden");let e=this.popoverEl.getBoundingClientRect(),s=e.width||300,i=e.height||44,n=t.left+t.width/2-s/2,o=Math.max(8,Math.min(window.innerWidth-s-8,n)),a=t.top-i-8,r=a>=8?a:Math.min(window.innerHeight-i-8,t.bottom+8);this.popoverEl.style.left=`${Math.round(o)}px`,this.popoverEl.style.top=`${Math.round(Math.max(8,r))}px`}applyHighlight(t){if(!this.savedText)return;if(this.autoHighlight&&this.savedRange)_t(this.savedRange,t,this.resolveTarget());let e={text:this.savedText,color:t};this.onHighlightCb?.(e),this.dispatchEvent(new CustomEvent("moss-highlight",{detail:e,bubbles:!0,composed:!0})),window.getSelection()?.removeAllRanges(),this.hide()}async submitAsk(){let t=this.savedText;if(!t)return;let s=this.askInputEl.value.trim()||"请结合上下文解读这段内容。",i=this.getAttribute("app-title")??document.title,n=this.resolveTarget().textContent?.slice(0,1200)??"",o=this.resolveDrawer();if(o&&typeof o.ask==="function"){o.open(),this.hide();let r=await o.ask({prompt:s,selectionText:t,context:n,appTitle:i});this.onAskCb?.({prompt:s,selectionText:t,outcome:r});return}this.answerEl.classList.remove("hidden"),this.answerEl.textContent="Moss 思考中…",this.dispatchEvent(new CustomEvent("moss-ask-start",{detail:{prompt:s,selectionText:t},bubbles:!0,composed:!0}));let a=await v({prompt:s,selectionText:t,context:n,appTitle:i,preferSidechat:this.preferSidechat,onText:(r,l)=>{this.answerEl.textContent=l,this.dispatchEvent(new CustomEvent("moss-ask-delta",{detail:{text:l},bubbles:!0,composed:!0}))}});this.answerEl.textContent=a.text,this.onAskCb?.({prompt:s,selectionText:t,outcome:a}),this.dispatchEvent(new CustomEvent("moss-ask-done",{detail:{prompt:s,selectionText:t,outcome:a},bubbles:!0,composed:!0}))}}var Vt=`
:host {
  display: block;
  height: 100%;
}

.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 340px;
  max-width: 100%;
  background: var(--moss-surface);
  border-left: 1px solid var(--moss-border);
  color: var(--moss-ink);
}

.shell.collapsed {
  width: auto;
  background: transparent;
  border-left: 0;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 42px;
  padding: 0 12px;
  border-bottom: 1px solid var(--moss-border);
  background: var(--moss-paper);
  flex-shrink: 0;
}

.shell.collapsed .header {
  border-bottom: 0;
  background: transparent;
  padding: 6px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
}

.brand-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.shell.collapsed .body,
.shell.collapsed .footer {
  display: none;
}

.empty {
  padding: 14px 12px;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border);
  background: var(--moss-card);
  color: var(--moss-ink-2);
  font-size: 13px;
  line-height: 19px;
}

.msg {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border);
  background: var(--moss-card);
}

.msg.user {
  background: var(--moss-paper);
}

.msg-role {
  font-size: 12px;
  font-weight: 500;
  color: var(--moss-ink-2);
}

.msg-quote {
  padding: 6px 8px;
  border-left: 2px solid var(--moss-accent);
  background: var(--moss-hover);
  border-radius: 4px;
  font-size: 12px;
  line-height: 17px;
  color: var(--moss-ink-2);
}

.msg-text {
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
  word-break: break-word;
}

.footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid var(--moss-border);
  background: var(--moss-paper);
  flex-shrink: 0;
}

.footer .moss-input {
  flex: 1;
}
`;class w extends c{static get observedAttributes(){return["title","placeholder","app-title","theme","open"]}shellEl;titleEl;toggleBtnEl;clearBtnEl;bodyEl;inputEl;sendBtnEl;isOpen=!0;busy=!1;contextGetter=null;messages=[];constructor(){super();let t=m(this,Vt);this.shellEl=document.createElement("div"),this.shellEl.className="shell";let e=document.createElement("div");e.className="header";let s=document.createElement("div");s.className="brand",s.appendChild(V(14)),this.titleEl=document.createElement("span"),this.titleEl.className="brand-title",this.titleEl.textContent="Moss 伴读",s.appendChild(this.titleEl);let i=document.createElement("div");i.className="header-actions",this.clearBtnEl=document.createElement("button"),this.clearBtnEl.type="button",this.clearBtnEl.className="moss-btn moss-btn-ghost",this.clearBtnEl.textContent="清空",this.clearBtnEl.addEventListener("click",()=>this.clear()),this.toggleBtnEl=document.createElement("button"),this.toggleBtnEl.type="button",this.toggleBtnEl.className="moss-btn",this.toggleBtnEl.setAttribute("data-moss-role","toggle"),this.toggleBtnEl.textContent="收起",this.toggleBtnEl.addEventListener("click",()=>this.toggle()),i.appendChild(this.clearBtnEl),i.appendChild(this.toggleBtnEl),e.appendChild(s),e.appendChild(i),this.bodyEl=document.createElement("div"),this.bodyEl.className="body",this.bodyEl.setAttribute("data-moss-role","messages");let n=document.createElement("div");n.className="footer",this.inputEl=document.createElement("input"),this.inputEl.type="text",this.inputEl.className="moss-input",this.inputEl.placeholder="向 Moss 提问…",this.inputEl.addEventListener("keydown",(o)=>{if(o.key==="Enter")o.preventDefault(),this.handleSubmitInput()}),this.sendBtnEl=document.createElement("button"),this.sendBtnEl.type="button",this.sendBtnEl.className="moss-btn moss-btn-primary",this.sendBtnEl.setAttribute("data-moss-role","send"),this.sendBtnEl.textContent="发送",this.sendBtnEl.addEventListener("click",()=>void this.handleSubmitInput()),n.appendChild(this.inputEl),n.appendChild(this.sendBtnEl),this.shellEl.appendChild(e),this.shellEl.appendChild(this.bodyEl),this.shellEl.appendChild(n),t.appendChild(this.shellEl),this.renderMessages()}connectedCallback(){this.syncAttributes()}attributeChangedCallback(){this.syncAttributes()}configure(t){if(t.title)this.setAttribute("title",t.title);if(t.placeholder)this.setAttribute("placeholder",t.placeholder);if(t.appTitle)this.setAttribute("app-title",t.appTitle);if(t.theme&&t.theme!=="auto")this.setAttribute("theme",t.theme);if(t.open!==void 0)if(t.open)this.open();else this.close();if(t.getContext)this.contextGetter=t.getContext}open(){this.isOpen=!0,this.syncOpenUi()}close(){this.isOpen=!1,this.syncOpenUi()}toggle(){this.isOpen=!this.isOpen,this.syncOpenUi()}clear(){this.messages=[],this.renderMessages()}appendMessage(t){this.messages.push({...t}),this.renderMessages()}async ask(t){if(this.busy)return{via:"fallback",text:"上一条提问还在处理中。"};this.open();let e=t.prompt.trim()||"请解读这段内容";this.messages.push({role:"user",text:e,...t.selectionText?{quote:t.selectionText}:{}});let s={role:"assistant",text:"正在思考…"};this.messages.push(s),this.busy=!0,this.sendBtnEl.disabled=!0,this.renderMessages();try{let i=await v({prompt:e,...t.selectionText!==void 0?{selectionText:t.selectionText}:{},context:t.context??this.contextGetter?.()??"",appTitle:t.appTitle??this.getAttribute("app-title")??document.title,onText:(n,o)=>{s.text=o,this.renderMessages()}});return s.text=i.text,this.renderMessages(),this.dispatchEvent(new CustomEvent("moss-drawer-reply",{detail:{prompt:e,outcome:i},bubbles:!0,composed:!0})),i}finally{this.busy=!1,this.sendBtnEl.disabled=!1}}async handleSubmitInput(){let t=this.inputEl.value.trim();if(!t||this.busy)return;this.inputEl.value="",await this.ask({prompt:t})}syncAttributes(){let t=this.getAttribute("title");if(t)this.titleEl.textContent=t;let e=this.getAttribute("placeholder");if(e)this.inputEl.placeholder=e;let s=this.getAttribute("open");if(s!==null)this.isOpen=s!=="false";this.syncOpenUi()}syncOpenUi(){this.shellEl.classList.toggle("collapsed",!this.isOpen),this.toggleBtnEl.textContent=this.isOpen?"收起":"打开伴读",this.clearBtnEl.style.display=this.isOpen?"":"none"}renderMessages(){if(this.bodyEl.textContent="",this.messages.length===0){let t=document.createElement("div");t.className="empty",t.textContent="划选正文后点击「划线提问」，或直接在下方输入问题。",this.bodyEl.appendChild(t);return}for(let t of this.messages){let e=document.createElement("div");e.className=`msg ${t.role}`;let s=document.createElement("div");if(s.className="msg-role",s.textContent=t.role==="user"?"我":"Moss",e.appendChild(s),t.quote){let n=document.createElement("div");n.className="msg-quote",n.textContent=t.quote.slice(0,120),e.appendChild(n)}let i=document.createElement("div");i.className="msg-text",i.textContent=t.text,e.appendChild(i),this.bodyEl.appendChild(e)}this.bodyEl.scrollTop=this.bodyEl.scrollHeight}}var jt=`
.bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--moss-radius-pill);
  background: var(--moss-hover);
  color: var(--moss-ink-2);
  font-size: 12px;
  line-height: 16px;
}

.status-pill.joined {
  background: var(--moss-success-soft);
  color: var(--moss-success);
}

.actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.ask-line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ask-line .moss-input {
  flex: 1;
}

.sheet {
  padding: 10px 12px;
  border-radius: var(--moss-radius-control);
  border: 1px solid var(--moss-border);
  background: var(--moss-surface);
  font-size: 13px;
  line-height: 20px;
  white-space: pre-wrap;
}

.sheet.hidden {
  display: none;
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--moss-ink-2);
}
`;class C extends c{static get observedAttributes(){return["meeting-id","meeting-title","theme"]}titleEl;statusEl;joinBtnEl;summaryBtnEl;askInputEl;askBtnEl;sheetEl;sheetTitleEl;sheetBodyEl;joined=!1;busy=!1;getTranscriptFn=null;onJoinedCb=null;onSummaryCb=null;constructor(){super();let t=m(this,jt),e=document.createElement("div");e.className="bar";let s=document.createElement("div");s.className="top";let i=document.createElement("div");i.className="meta",i.appendChild(V(15)),this.titleEl=document.createElement("span"),this.titleEl.style.fontWeight="500",this.titleEl.textContent="Moss 会议助手",i.appendChild(this.titleEl),this.statusEl=document.createElement("span"),this.statusEl.className="status-pill",this.statusEl.setAttribute("data-moss-role","status"),this.statusEl.textContent="未入场",i.appendChild(this.statusEl);let n=document.createElement("div");n.className="actions",this.joinBtnEl=document.createElement("button"),this.joinBtnEl.type="button",this.joinBtnEl.className="moss-btn moss-btn-primary",this.joinBtnEl.setAttribute("data-moss-role","join"),this.joinBtnEl.textContent="拉 Moss 加入会议",this.joinBtnEl.addEventListener("click",()=>void this.join()),this.summaryBtnEl=document.createElement("button"),this.summaryBtnEl.type="button",this.summaryBtnEl.className="moss-btn",this.summaryBtnEl.setAttribute("data-moss-role","summarize"),this.summaryBtnEl.textContent="生成会议纪要",this.summaryBtnEl.addEventListener("click",()=>void this.summarize()),n.appendChild(this.joinBtnEl),n.appendChild(this.summaryBtnEl),s.appendChild(i),s.appendChild(n);let o=document.createElement("div");o.className="ask-line",this.askInputEl=document.createElement("input"),this.askInputEl.type="text",this.askInputEl.className="moss-input",this.askInputEl.placeholder="向 Mossbot 提问当前会议进展或行动项…",this.askInputEl.addEventListener("keydown",(l)=>{if(l.key==="Enter")l.preventDefault(),this.askQuestion()}),this.askBtnEl=document.createElement("button"),this.askBtnEl.type="button",this.askBtnEl.className="moss-btn",this.askBtnEl.setAttribute("data-moss-role","ask"),this.askBtnEl.textContent="问 Mossbot",this.askBtnEl.addEventListener("click",()=>void this.askQuestion()),o.appendChild(this.askInputEl),o.appendChild(this.askBtnEl),this.sheetEl=document.createElement("div"),this.sheetEl.className="sheet hidden",this.sheetEl.setAttribute("data-moss-role","sheet");let a=document.createElement("div");a.className="sheet-head",this.sheetTitleEl=document.createElement("span"),this.sheetTitleEl.textContent="会议纪要";let r=document.createElement("button");r.type="button",r.className="moss-btn moss-btn-ghost",r.textContent="收起",r.addEventListener("click",()=>this.sheetEl.classList.add("hidden")),a.appendChild(this.sheetTitleEl),a.appendChild(r),this.sheetBodyEl=document.createElement("div"),this.sheetEl.appendChild(a),this.sheetEl.appendChild(this.sheetBodyEl),e.appendChild(s),e.appendChild(o),e.appendChild(this.sheetEl),t.appendChild(e)}connectedCallback(){this.syncAttributes()}attributeChangedCallback(){this.syncAttributes()}configure(t){if(t.meetingId)this.setAttribute("meeting-id",t.meetingId);if(t.meetingTitle)this.setAttribute("meeting-title",t.meetingTitle);if(t.theme&&t.theme!=="auto")this.setAttribute("theme",t.theme);if(t.getTranscript)this.getTranscriptFn=t.getTranscript;if(t.onJoined)this.onJoinedCb=t.onJoined;if(t.onSummary)this.onSummaryCb=t.onSummary}resolveMeetingId(){let t=this.getAttribute("meeting-id")?.trim();return t&&t.length>0?t:"moss-default-meeting"}async join(){let t=this.getAttribute("meeting-title")??"会议室",e=this.resolveMeetingId();this.setBusy(!0);try{let s=await gt({meetingId:e,title:t});return this.joined=s.joined,this.statusEl.textContent=s.statusText,this.statusEl.classList.toggle("joined",this.joined),this.joinBtnEl.textContent=this.joined?"Moss 已在场":"拉 Moss 加入会议",this.joinBtnEl.classList.toggle("moss-btn-primary",!this.joined),this.onJoinedCb?.(s),this.dispatchEvent(new CustomEvent("moss-meeting-joined",{detail:s,bubbles:!0,composed:!0})),s}finally{this.setBusy(!1)}}async summarize(){if(this.busy)return{via:"fallback",summary:""};let t=this.getAttribute("meeting-title")??"会议室",e=this.resolveMeetingId(),s=this.resolveTranscript();this.setBusy(!0),this.sheetEl.classList.remove("hidden"),this.sheetTitleEl.textContent="正在整理会议纪要…",this.sheetBodyEl.textContent="";try{let i=await bt({meetingId:e,title:t,transcript:s});return this.sheetTitleEl.textContent="会议纪要",this.sheetBodyEl.textContent=i.summary,this.onSummaryCb?.(i),this.dispatchEvent(new CustomEvent("moss-meeting-summary",{detail:i,bubbles:!0,composed:!0})),i}finally{this.setBusy(!1)}}async askQuestion(t){let e=(t??this.askInputEl.value).trim();if(!e||this.busy)return{via:"fallback",summary:""};if(!t)this.askInputEl.value="";let s=this.getAttribute("meeting-title")??"会议室",i=this.resolveMeetingId(),n=this.resolveTranscript();this.setBusy(!0),this.sheetEl.classList.remove("hidden"),this.sheetTitleEl.textContent="Mossbot 回复",this.sheetBodyEl.textContent="正在检索会议记录…";try{let o=await vt({meetingId:i,title:s,prompt:e,transcript:n});return this.sheetBodyEl.textContent=o.summary,this.dispatchEvent(new CustomEvent("moss-meeting-answer",{detail:{prompt:e,outcome:o},bubbles:!0,composed:!0})),o}finally{this.setBusy(!1)}}resolveTranscript(){if(this.getTranscriptFn)return this.getTranscriptFn();return document.body?.innerText?.slice(0,2400)??""}setBusy(t){this.busy=t,this.joinBtnEl.disabled=t,this.summaryBtnEl.disabled=t,this.askBtnEl.disabled=t}syncAttributes(){let t=this.getAttribute("meeting-title");if(t)this.titleEl.textContent=t}}var zt=`
.wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
}

.row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.row .moss-input {
  flex: 1;
  min-width: 160px;
}

.preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--moss-radius-control);
  border: 1px solid var(--moss-border);
  background: var(--moss-surface);
  font-size: 13px;
  line-height: 19px;
}

.preview.hidden {
  display: none;
}

.preview img,
.preview video {
  max-width: 100%;
  max-height: 220px;
  border-radius: var(--moss-radius-control);
  object-fit: contain;
}
`;class M extends c{static get observedAttributes(){return["kind","prompt","theme"]}kind="image";busy=!1;onResultCb=null;kindBtnEl;inputEl;runBtnEl;previewEl;constructor(){super();let t=m(this,zt),e=document.createElement("div");e.className="wrap";let s=document.createElement("div");s.className="row",this.kindBtnEl=document.createElement("button"),this.kindBtnEl.type="button",this.kindBtnEl.className="moss-btn",this.kindBtnEl.setAttribute("data-moss-role","toggle-kind"),this.kindBtnEl.textContent="配图",this.kindBtnEl.addEventListener("click",()=>{this.kind=this.kind==="image"?"video":"image",this.syncLabels()}),this.inputEl=document.createElement("input"),this.inputEl.type="text",this.inputEl.className="moss-input",this.inputEl.placeholder="描述要生成的图片或短视频…",this.inputEl.addEventListener("keydown",(i)=>{if(i.key==="Enter")i.preventDefault(),this.trigger()}),this.runBtnEl=document.createElement("button"),this.runBtnEl.type="button",this.runBtnEl.className="moss-btn moss-btn-primary",this.runBtnEl.setAttribute("data-moss-role","generate"),this.runBtnEl.textContent="生成配图",this.runBtnEl.addEventListener("click",()=>void this.trigger()),s.appendChild(this.kindBtnEl),s.appendChild(this.inputEl),s.appendChild(this.runBtnEl),this.previewEl=document.createElement("div"),this.previewEl.className="preview hidden",this.previewEl.setAttribute("data-moss-role","preview"),e.appendChild(s),e.appendChild(this.previewEl),t.appendChild(e)}connectedCallback(){this.syncAttributes()}attributeChangedCallback(){this.syncAttributes()}configure(t){if(t.kind)this.kind=t.kind,this.setAttribute("kind",t.kind);if(t.prompt!==void 0)this.inputEl.value=t.prompt;if(t.theme&&t.theme!=="auto")this.setAttribute("theme",t.theme);if(t.onResult)this.onResultCb=t.onResult;this.syncLabels()}async trigger(t){if(this.busy)return{via:"fallback",kind:this.kind,status:"fallback",text:"生成任务进行中。"};let e=(t??this.inputEl.value).trim()||"Moss 极简暖白插画卡片";this.busy=!0,this.runBtnEl.disabled=!0,this.previewEl.classList.remove("hidden"),this.previewEl.textContent=this.kind==="video"?"正在生成短视频…":"正在生成配图…";try{let s=await Et({kind:this.kind,prompt:e});if(this.previewEl.textContent="",s.url)if(s.kind==="video"){let i=document.createElement("video");i.src=s.url,i.controls=!0,this.previewEl.appendChild(i)}else{let i=document.createElement("img");i.src=s.url,i.alt=e,this.previewEl.appendChild(i)}if(s.text){let i=document.createElement("div");i.textContent=s.text,this.previewEl.appendChild(i)}return this.onResultCb?.(s),this.dispatchEvent(new CustomEvent("moss-media-result",{detail:s,bubbles:!0,composed:!0})),s}finally{this.busy=!1,this.runBtnEl.disabled=!1}}syncAttributes(){let t=this.getAttribute("kind");if(t==="video"||t==="image")this.kind=t;let e=this.getAttribute("prompt");if(e!==null&&!this.inputEl.value)this.inputEl.value=e;this.syncLabels()}syncLabels(){this.kindBtnEl.textContent=this.kind==="video"?"短视频":"配图",this.runBtnEl.textContent=this.kind==="video"?"生成短视频":"生成配图"}}function E(){if(typeof customElements>"u")return;if(!customElements.get("moss-selection-ask"))customElements.define("moss-selection-ask",k);if(!customElements.get("moss-companion-drawer"))customElements.define("moss-companion-drawer",w);if(!customElements.get("moss-bot-meeting-bar"))customElements.define("moss-bot-meeting-bar",C);if(!customElements.get("moss-media-trigger"))customElements.define("moss-media-trigger",M)}function q(t={}){E();let e=document.createElement("moss-selection-ask");return e.configure(t),document.body.appendChild(e),e}function J(t={}){E();let e=document.createElement("moss-companion-drawer");return e.configure(t),(t.container??document.body).appendChild(e),e}function Q(t={}){E();let e=document.createElement("moss-bot-meeting-bar");return e.configure(t),(t.container??document.body).appendChild(e),e}function X(t={}){E();let e=document.createElement("moss-media-trigger");return e.configure(t),(t.container??document.body).appendChild(e),e}var Pt=`
:host { display: inline-flex; }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--moss-radius-control);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.btn:hover:not(:disabled) { background: var(--moss-hover); }
.btn:active:not(:disabled) { background: var(--moss-active); }
.btn.variant-primary { background: var(--moss-ink); color: var(--moss-paper); border-color: transparent; }
.btn.variant-primary:hover:not(:disabled) { background: var(--moss-ink); color: var(--moss-paper); opacity: 0.88; }
.btn.variant-secondary { background: var(--moss-surface); color: var(--moss-ink); border-color: var(--moss-border); }
.btn.variant-ghost { background: transparent; color: var(--moss-ink-2); border-color: transparent; }
.btn.variant-ghost:hover:not(:disabled) { background: var(--moss-hover); color: var(--moss-ink); }
.btn.variant-destructive { background: var(--moss-danger-soft); color: var(--moss-danger); border-color: rgba(224, 46, 42, 0.28); }
.btn.size-xs { height: 24px; padding: 0 8px; font-size: 12px; line-height: 16px; border-radius: 6px; }
.btn.size-sm { height: 28px; padding: 0 10px; font-size: 13px; line-height: 17px; }
.btn.size-lg { height: 40px; padding: 0 16px; font-size: 14px; }
.btn.size-icon-sm { width: 28px; height: 28px; padding: 0; }
.btn.size-icon-xs { width: 24px; height: 24px; padding: 0; border-radius: 6px; }
`;class T extends c{static get observedAttributes(){return["variant","size","disabled","label","theme"]}btnEl;labelSpan;constructor(){super();let t=m(this,Pt);this.btnEl=document.createElement("button"),this.btnEl.type="button",this.btnEl.className="btn",this.labelSpan=document.createElement("span");let e=document.createElement("slot");this.btnEl.appendChild(e),this.btnEl.appendChild(this.labelSpan),t.appendChild(this.btnEl)}connectedCallback(){this.sync()}attributeChangedCallback(){this.sync()}sync(){let t=this.getAttribute("variant")??"default",e=this.getAttribute("size")??"default";this.btnEl.className=`btn variant-${t} size-${e}`,this.btnEl.disabled=this.hasAttribute("disabled")&&this.getAttribute("disabled")!=="false";let s=this.getAttribute("label");this.labelSpan.textContent=s??"",this.labelSpan.style.display=s?"":"none"}}var Ut=`
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border);
  background: var(--moss-card);
  color: var(--moss-ink);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.head.hidden { display: none; }
.title { font-size: 15px; line-height: 20px; font-weight: 500; }
.subtitle { font-size: 13px; line-height: 17px; color: var(--moss-ink-2); margin-top: 2px; }
`;class S extends c{static get observedAttributes(){return["title","subtitle","theme"]}headEl;titleEl;subtitleEl;constructor(){super();let t=m(this,Ut),e=document.createElement("div");e.className="card",this.headEl=document.createElement("div"),this.headEl.className="head";let s=document.createElement("div");this.titleEl=document.createElement("div"),this.titleEl.className="title",this.subtitleEl=document.createElement("div"),this.subtitleEl.className="subtitle",s.appendChild(this.titleEl),s.appendChild(this.subtitleEl);let i=document.createElement("slot");i.name="actions",this.headEl.appendChild(s),this.headEl.appendChild(i);let n=document.createElement("slot"),o=document.createElement("slot");o.name="footer",e.appendChild(this.headEl),e.appendChild(n),e.appendChild(o),t.appendChild(e)}connectedCallback(){this.sync()}attributeChangedCallback(){this.sync()}sync(){let t=this.getAttribute("title")??"",e=this.getAttribute("subtitle")??"";this.titleEl.textContent=t,this.subtitleEl.textContent=e,this.subtitleEl.style.display=e?"":"none",this.headEl.classList.toggle("hidden",!t&&!e)}}var Wt=`
.tabs { display: flex; flex-direction: column; gap: 10px; }
.list {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  border-radius: var(--moss-radius-control);
  background: var(--moss-surface);
  border: 1px solid var(--moss-border);
  width: fit-content;
}
.tab {
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 17px;
  font-weight: 500;
  color: var(--moss-ink-2);
  transition: background-color 120ms ease, color 120ms ease;
}
.tab:hover:not(:disabled) { color: var(--moss-ink); background: var(--moss-hover); }
.tab.active {
  background: var(--moss-card);
  color: var(--moss-ink);
  border: 1px solid var(--moss-border);
}
.panel {
  font-size: 14px;
  line-height: 20px;
}
`;class A extends c{static get observedAttributes(){return["tabs","value","theme"]}items=[];activeId="";listEl;panelEl;constructor(){super();let t=m(this,Wt),e=document.createElement("div");e.className="tabs",this.listEl=document.createElement("div"),this.listEl.className="list",this.listEl.setAttribute("role","tablist"),this.panelEl=document.createElement("div"),this.panelEl.className="panel",this.panelEl.setAttribute("role","tabpanel");let s=document.createElement("slot");this.panelEl.appendChild(s),e.appendChild(this.listEl),e.appendChild(this.panelEl),t.appendChild(e)}connectedCallback(){this.syncFromAttr()}attributeChangedCallback(){this.syncFromAttr()}setTabs(t,e){this.items=[...t],this.activeId=e??this.items[0]?.id??"",this.render()}get value(){return this.activeId}set value(t){this.select(t,!1)}select(t,e=!0){if(!this.items.find((i)=>i.id===t&&!i.disabled))return;if(this.activeId=t,this.render(),e)this.dispatchEvent(new CustomEvent("moss-tab-change",{detail:{value:t},bubbles:!0,composed:!0}))}syncFromAttr(){let t=this.getAttribute("tabs");if(t)try{let s=JSON.parse(t);if(Array.isArray(s))this.items=s}catch{}let e=this.getAttribute("value");if(e)this.activeId=e;if(!this.activeId&&this.items[0])this.activeId=this.items[0].id;this.render()}render(){this.listEl.textContent="";for(let s of this.items){let i=document.createElement("button");i.type="button",i.className=`tab${s.id===this.activeId?" active":""}`,i.setAttribute("role","tab"),i.setAttribute("aria-selected",s.id===this.activeId?"true":"false"),i.setAttribute("data-moss-tab",s.id),i.disabled=!!s.disabled,i.textContent=s.label,i.addEventListener("click",()=>this.select(s.id,!0)),this.listEl.appendChild(i)}let t=this.items.find((s)=>s.id===this.activeId),e=this.panelEl.querySelector("[data-moss-tab-content]");if(t?.content!==void 0){if(!e)e=document.createElement("div"),e.setAttribute("data-moss-tab-content","true"),this.panelEl.prepend(e);e.textContent=t.content}else if(e)e.remove()}}var Kt=`
.drawer {
  display: flex;
  flex-direction: column;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border);
  background: var(--moss-surface);
  overflow: hidden;
}
.drawer.closed .body,
.drawer.closed .foot { display: none; }
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 40px;
  padding: 0 12px;
  background: var(--moss-paper);
  border-bottom: 1px solid var(--moss-border);
}
.drawer.closed .head { border-bottom: 0; }
.title { font-size: 14px; font-weight: 500; }
.body { padding: 12px; }
.foot { padding: 10px 12px; border-top: 1px solid var(--moss-border); background: var(--moss-paper); }
`;class B extends c{static get observedAttributes(){return["title","open","theme"]}wrapEl;titleEl;toggleBtnEl;isOpen=!0;constructor(){super();let t=m(this,Kt);this.wrapEl=document.createElement("div"),this.wrapEl.className="drawer";let e=document.createElement("div");e.className="head",this.titleEl=document.createElement("span"),this.titleEl.className="title",this.titleEl.textContent="侧栏",this.toggleBtnEl=document.createElement("button"),this.toggleBtnEl.type="button",this.toggleBtnEl.className="moss-btn moss-btn-ghost",this.toggleBtnEl.textContent="收起",this.toggleBtnEl.addEventListener("click",()=>this.toggle()),e.appendChild(this.titleEl),e.appendChild(this.toggleBtnEl);let s=document.createElement("div");s.className="body",s.appendChild(document.createElement("slot"));let i=document.createElement("div");i.className="foot";let n=document.createElement("slot");n.name="footer",i.appendChild(n),this.wrapEl.appendChild(e),this.wrapEl.appendChild(s),this.wrapEl.appendChild(i),t.appendChild(this.wrapEl)}connectedCallback(){this.sync()}attributeChangedCallback(){this.sync()}open(){this.isOpen=!0,this.renderState()}close(){this.isOpen=!1,this.renderState()}toggle(){this.isOpen=!this.isOpen,this.renderState(),this.dispatchEvent(new CustomEvent("moss-drawer-change",{detail:{open:this.isOpen},bubbles:!0,composed:!0}))}sync(){let t=this.getAttribute("title");if(t)this.titleEl.textContent=t;let e=this.getAttribute("open");if(e!==null)this.isOpen=e!=="false";this.renderState()}renderState(){this.wrapEl.classList.toggle("closed",!this.isOpen),this.toggleBtnEl.textContent=this.isOpen?"收起":"展开"}}var $t=`
:host { position: fixed; inset: 0; z-index: 2147483200; pointer-events: none; }
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(20, 20, 19, 0.36);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  pointer-events: auto;
}
.backdrop.hidden { display: none; }
.panel {
  width: min(460px, 100%);
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
  box-shadow: var(--moss-shadow-popover);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.title { font-size: 16px; line-height: 22px; font-weight: 500; margin: 0; }
.desc { font-size: 13px; line-height: 19px; color: var(--moss-ink-2); margin: 0; }
.foot { display: flex; justify-content: flex-end; gap: 8px; }
`;class L extends c{static get observedAttributes(){return["open","title","description","theme"]}backdropEl;titleEl;descEl;onKeyDown=(t)=>{if(t.key==="Escape"&&!this.backdropEl.classList.contains("hidden"))this.close()};constructor(){super();let t=m(this,$t);this.backdropEl=document.createElement("div"),this.backdropEl.className="backdrop hidden",this.backdropEl.addEventListener("click",(r)=>{if(r.target===this.backdropEl)this.close()});let e=document.createElement("div");e.className="panel",e.setAttribute("role","dialog"),e.setAttribute("aria-modal","true");let s=document.createElement("div");s.className="head",this.titleEl=document.createElement("h2"),this.titleEl.className="title";let i=document.createElement("button");i.type="button",i.className="moss-btn moss-btn-ghost",i.setAttribute("aria-label","关闭弹窗"),i.textContent="×",i.addEventListener("click",()=>this.close()),s.appendChild(this.titleEl),s.appendChild(i),this.descEl=document.createElement("p"),this.descEl.className="desc";let n=document.createElement("slot"),o=document.createElement("div");o.className="foot";let a=document.createElement("slot");a.name="footer",o.appendChild(a),e.appendChild(s),e.appendChild(this.descEl),e.appendChild(n),e.appendChild(o),this.backdropEl.appendChild(e),t.appendChild(this.backdropEl)}connectedCallback(){document.addEventListener("keydown",this.onKeyDown),this.sync()}disconnectedCallback(){document.removeEventListener("keydown",this.onKeyDown)}attributeChangedCallback(){this.sync()}show(){this.setAttribute("open","true")}close(){this.removeAttribute("open"),this.backdropEl.classList.add("hidden"),this.dispatchEvent(new CustomEvent("moss-dialog-close",{bubbles:!0,composed:!0}))}sync(){let t=this.hasAttribute("open")&&this.getAttribute("open")!=="false";this.backdropEl.classList.toggle("hidden",!t),this.titleEl.textContent=this.getAttribute("title")??"";let e=this.getAttribute("description")??"";this.descEl.textContent=e,this.descEl.style.display=e?"":"none"}}var Ft=`
:host { display: inline-flex; }
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border-radius: var(--moss-radius-pill);
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  background: var(--moss-hover);
  color: var(--moss-ink-2);
}
.badge.variant-accent { background: var(--moss-accent-soft); color: var(--moss-accent); }
.badge.variant-success { background: var(--moss-success-soft); color: var(--moss-success); }
.badge.variant-warn { background: var(--moss-warn-soft); color: var(--moss-warn); }
.badge.variant-danger { background: var(--moss-danger-soft); color: var(--moss-danger); }
`;class I extends c{static get observedAttributes(){return["variant","label","theme"]}badgeEl;textEl;constructor(){super();let t=m(this,Ft);this.badgeEl=document.createElement("span"),this.badgeEl.className="badge",this.textEl=document.createElement("span"),this.badgeEl.appendChild(document.createElement("slot")),this.badgeEl.appendChild(this.textEl),t.appendChild(this.badgeEl)}connectedCallback(){this.sync()}attributeChangedCallback(){this.sync()}sync(){let t=this.getAttribute("variant")??"neutral";this.badgeEl.className=`badge variant-${t}`;let e=this.getAttribute("label");this.textEl.textContent=e??"",this.textEl.style.display=e?"":"none"}}var Gt=`
:host {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483100;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(360px, calc(100vw - 32px));
  padding: 8px 12px;
  border-radius: var(--moss-radius-popover);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-popover);
  backdrop-filter: blur(12px);
  box-shadow: var(--moss-shadow-popover);
  font-size: 13px;
  line-height: 18px;
  color: var(--moss-ink);
}
.toast.hidden { display: none; }
.dot { width: 7px; height: 7px; border-radius: 999px; background: var(--moss-accent); flex-shrink: 0; }
.toast.variant-success .dot { background: var(--moss-success); }
.toast.variant-warn .dot { background: var(--moss-warn); }
.toast.variant-danger .dot { background: var(--moss-danger); }
`;class f extends c{static get observedAttributes(){return["message","variant","open","theme"]}toastEl;textEl;timer=null;static show(t,e={}){if(typeof customElements<"u"&&!customElements.get("moss-toast"))customElements.define("moss-toast",f);let s=document.querySelector("moss-toast[data-moss-singleton='true']");if(!s)s=document.createElement("moss-toast"),s.setAttribute("data-moss-singleton","true"),document.body.appendChild(s);return s.present(t,e.variant??"neutral",e.durationMs??2800),s}constructor(){super();let t=m(this,Gt);this.toastEl=document.createElement("div"),this.toastEl.className="toast hidden",this.toastEl.setAttribute("role","status");let e=document.createElement("span");e.className="dot",this.textEl=document.createElement("span"),this.toastEl.appendChild(e),this.toastEl.appendChild(this.textEl),t.appendChild(this.toastEl)}connectedCallback(){this.sync()}attributeChangedCallback(){this.sync()}present(t,e="neutral",s=2800){if(this.timer!==null)clearTimeout(this.timer);if(this.setAttribute("message",t),this.setAttribute("variant",e),this.setAttribute("open","true"),s>0)this.timer=setTimeout(()=>this.hide(),s)}hide(){this.removeAttribute("open"),this.toastEl.classList.add("hidden")}sync(){let t=this.hasAttribute("open")&&this.getAttribute("open")!=="false",e=this.getAttribute("variant")??"neutral";this.toastEl.className=`toast variant-${e}${t?"":" hidden"}`,this.textEl.textContent=this.getAttribute("message")??""}}var qt=`
.md { font-size: 14px; line-height: 22px; color: var(--moss-ink); }
.md h1, .md h2, .md h3 { margin: 12px 0 6px; font-weight: 500; line-height: 1.35; }
.md h1 { font-size: 18px; }
.md h2 { font-size: 16px; }
.md h3 { font-size: 14px; }
.md p { margin: 6px 0; }
.md ul, .md ol { margin: 6px 0; padding-left: 20px; }
.md li { margin: 3px 0; }
.md blockquote {
  margin: 8px 0;
  padding: 6px 10px;
  border-left: 2px solid var(--moss-border-strong);
  color: var(--moss-ink-2);
  background: var(--moss-hover);
  border-radius: 4px;
}
.md code {
  font-family: var(--moss-mono);
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--moss-hover);
}
.md pre {
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: var(--moss-radius-control);
  background: var(--moss-surface);
  border: 1px solid var(--moss-border);
  overflow-x: auto;
}
.md pre code { background: transparent; padding: 0; }
.md a { color: var(--moss-accent); text-decoration: none; }
.md a:hover { text-decoration: underline; }
`;function j(t,e){let s=/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\))/gu,i=0;for(let n of e.matchAll(s)){let o=n.index??0;if(o>i)t.appendChild(document.createTextNode(e.slice(i,o)));let a=n[0];if(a.startsWith("**")&&a.endsWith("**")){let r=document.createElement("strong");r.style.fontWeight="500",r.textContent=a.slice(2,-2),t.appendChild(r)}else if(a.startsWith("`")&&a.endsWith("`")){let r=document.createElement("code");r.textContent=a.slice(1,-1),t.appendChild(r)}else if(a.startsWith("[")){let r=a.indexOf("]("),l=a.slice(1,r),d=a.slice(r+2,-1),b=document.createElement("a");b.textContent=l,b.href=d,b.target="_blank",b.rel="noopener noreferrer",t.appendChild(b)}i=o+a.length}if(i<e.length)t.appendChild(document.createTextNode(e.slice(i)))}class O extends c{static get observedAttributes(){return["content","theme"]}rootEl;rawContent="";constructor(){super();let t=m(this,qt);this.rootEl=document.createElement("div"),this.rootEl.className="md",t.appendChild(this.rootEl)}connectedCallback(){let t=this.getAttribute("content");if(t!==null)this.rawContent=t;else if(!this.rawContent&&this.textContent?.trim())this.rawContent=this.textContent;this.render()}attributeChangedCallback(){let t=this.getAttribute("content");if(t!==null)this.rawContent=t,this.render()}setContent(t){this.rawContent=t,this.render()}render(){this.rootEl.textContent="";let t=this.rawContent.replace(/\r\n/gu,`
`).split(`
`),e=0;while(e<t.length){let s=t[e];if(s.startsWith("```")){let n=[];e+=1;while(e<t.length&&!t[e].startsWith("```"))n.push(t[e]),e+=1;let o=document.createElement("pre"),a=document.createElement("code");a.textContent=n.join(`
`),o.appendChild(a),this.rootEl.appendChild(o),e+=1;continue}if(!s.trim()){e+=1;continue}if(s.startsWith("### ")||s.startsWith("## ")||s.startsWith("# ")){let n=s.startsWith("### ")?3:s.startsWith("## ")?2:1,o=document.createElement(`h${n}`);j(o,s.slice(n+1)),this.rootEl.appendChild(o),e+=1;continue}if(s.startsWith("> ")){let n=document.createElement("blockquote");j(n,s.slice(2)),this.rootEl.appendChild(n),e+=1;continue}if(/^[-*] /u.test(s)){let n=document.createElement("ul");while(e<t.length&&/^[-*] /u.test(t[e])){let o=document.createElement("li");j(o,t[e].slice(2)),n.appendChild(o),e+=1}this.rootEl.appendChild(n);continue}let i=document.createElement("p");j(i,s),this.rootEl.appendChild(i),e+=1}}}function g(){if(typeof customElements>"u")return;let t=[["moss-button",T],["moss-card",S],["moss-tabs",A],["moss-drawer",B],["moss-dialog",L],["moss-badge",I],["moss-toast",f],["moss-markdown",O]];for(let[e,s]of t)if(!customElements.get(e))customElements.define(e,s)}function Y(t){g();let e=document.createElement("moss-button");if(e.setAttribute("label",t.label),t.variant)e.setAttribute("variant",t.variant);if(t.size)e.setAttribute("size",t.size);if(t.onClick)e.addEventListener("click",t.onClick);return(t.container??document.body).appendChild(e),e}function Z(t={}){g();let e=document.createElement("moss-card");if(t.title)e.setAttribute("title",t.title);if(t.subtitle)e.setAttribute("subtitle",t.subtitle);return(t.container??document.body).appendChild(e),e}function tt(t){g();let e=document.createElement("moss-tabs");return e.setTabs(t.tabs,t.value),(t.container??document.body).appendChild(e),e}function et(t={}){g();let e=document.createElement("moss-drawer");if(t.title)e.setAttribute("title",t.title);if(t.open===!1)e.setAttribute("open","false");return(t.container??document.body).appendChild(e),e}function st(t){g();let e=document.createElement("moss-dialog");if(e.setAttribute("title",t.title),t.description)e.setAttribute("description",t.description);if(t.open)e.setAttribute("open","true");return(t.container??document.body).appendChild(e),e}function it(t){g();let e=document.createElement("moss-badge");if(e.setAttribute("label",t.label),t.variant)e.setAttribute("variant",t.variant);return(t.container??document.body).appendChild(e),e}function nt(t){g();let e=document.createElement("moss-markdown");return e.setContent(t.content),(t.container??document.body).appendChild(e),e}var Jt=`
:host { display: inline-flex; align-items: center; gap: 6px; }
.voice-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--moss-radius-control);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
  font-size: 13px;
  line-height: 17px;
  font-weight: 500;
}
.voice-btn:hover:not(:disabled) { background: var(--moss-hover); }
.voice-btn.circle {
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: var(--moss-radius-pill);
}
.voice-btn.recording {
  background: var(--moss-ink);
  color: var(--moss-paper);
  border-color: transparent;
}
.status {
  font-size: 12px;
  color: var(--moss-ink-2);
  font-variant-numeric: tabular-nums;
}
.status.hidden { display: none; }
`;class H extends c{static get observedAttributes(){return["mode","appearance","text","label","theme"]}mode="dictate";appearance="ghost";recording=!1;speaking=!1;busy=!1;elapsedSec=0;timer=null;onTranscriptCb=null;onSpeakCb=null;btnEl;iconWrapEl;labelEl;statusEl;constructor(){super();let t=m(this,Jt);this.btnEl=document.createElement("button"),this.btnEl.type="button",this.btnEl.className="voice-btn",this.btnEl.setAttribute("data-moss-role","voice-btn"),this.btnEl.addEventListener("click",()=>void this.handlePress()),this.iconWrapEl=document.createElement("span"),this.iconWrapEl.style.display="inline-flex",this.labelEl=document.createElement("span"),this.btnEl.appendChild(this.iconWrapEl),this.btnEl.appendChild(this.labelEl),this.statusEl=document.createElement("span"),this.statusEl.className="status hidden",this.statusEl.setAttribute("data-moss-role","voice-status"),t.appendChild(this.btnEl),t.appendChild(this.statusEl),this.render()}connectedCallback(){this.sync()}disconnectedCallback(){this.stopTimer()}attributeChangedCallback(){this.sync()}configure(t){if(t.mode)this.mode=t.mode,this.setAttribute("mode",t.mode);if(t.appearance)this.appearance=t.appearance,this.setAttribute("appearance",t.appearance);if(t.text!==void 0)this.setAttribute("text",t.text);if(t.theme&&t.theme!=="auto")this.setAttribute("theme",t.theme);if(t.onTranscript)this.onTranscriptCb=t.onTranscript;if(t.onSpeak)this.onSpeakCb=t.onSpeak;this.render()}async handlePress(){if(this.busy)return;if(this.mode==="speak"){if(this.speaking){await yt(),this.speaking=!1,this.render();return}let t=this.getAttribute("text")??"Moss 语音播报已就绪。";this.busy=!0,this.render();try{let e=await F({text:t});this.speaking=e.speaking,this.statusEl.textContent=e.statusText,this.statusEl.classList.remove("hidden"),this.onSpeakCb?.(e),this.dispatchEvent(new CustomEvent("moss-voice-spoken",{detail:e,bubbles:!0,composed:!0}))}finally{this.busy=!1,this.render()}return}if(!this.recording){this.busy=!0,this.render();try{await ft({language:"zh-CN"}),this.recording=!0,this.elapsedSec=0,this.startTimer(),this.statusEl.textContent="00:00",this.statusEl.classList.remove("hidden"),this.dispatchEvent(new CustomEvent("moss-voice-state",{detail:{recording:!0},bubbles:!0,composed:!0}))}finally{this.busy=!1,this.render()}return}this.recording=!1,this.stopTimer(),this.busy=!0,this.statusEl.textContent="识别中…",this.render();try{let t=await xt({language:"zh-CN"});this.statusEl.textContent=t.text,this.statusEl.classList.remove("hidden"),this.onTranscriptCb?.(t),this.dispatchEvent(new CustomEvent("moss-voice-transcript",{detail:t,bubbles:!0,composed:!0}))}finally{this.busy=!1,this.render()}}startTimer(){this.stopTimer(),this.timer=setInterval(()=>{this.elapsedSec+=1;let t=String(Math.floor(this.elapsedSec/60)).padStart(2,"0"),e=String(this.elapsedSec%60).padStart(2,"0");this.statusEl.textContent=`${t}:${e}`},1000)}stopTimer(){if(this.timer!==null)clearInterval(this.timer),this.timer=null}sync(){let t=this.getAttribute("mode");if(t==="speak"||t==="dictate")this.mode=t;let e=this.getAttribute("appearance");if(e==="circle"||e==="ghost")this.appearance=e;this.render()}render(){this.iconWrapEl.textContent="",this.iconWrapEl.appendChild(this.mode==="speak"?W(14):mt(14)),this.btnEl.className=`voice-btn${this.appearance==="circle"?" circle":""}${this.recording||this.speaking?" recording":""}`,this.btnEl.disabled=this.busy;let t=this.getAttribute("label");if(this.appearance==="circle")this.labelEl.textContent="",this.btnEl.setAttribute("aria-label",this.mode==="speak"?this.speaking?"停止朗读":t??"朗读":this.recording?"完成录音":t??"语音输入");else this.labelEl.textContent=this.mode==="speak"?this.speaking?"停止朗读":t??"朗读":this.recording?"完成录音":t??"语音输入"}}var Qt=`
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--moss-radius-card);
  border: 1px solid var(--moss-border-strong);
  background: var(--moss-card);
  color: var(--moss-ink);
}
.left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.waves {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 24px;
}
.wave-bar {
  width: 2px;
  border-radius: 1px;
  background: var(--moss-ink);
  transition: height 160ms ease;
}
.meta {
  font-size: 13px;
  line-height: 17px;
  color: var(--moss-ink-2);
  font-variant-numeric: tabular-nums;
}
.actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
`;class N extends c{static get observedAttributes(){return["topic","theme"]}active=!1;busy=!1;sessionId;elapsedSec=0;waveTimer=null;getContextFn=null;getSummaryTextFn=null;onStateCb=null;wavesEl;metaEl;toggleBtnEl;speakBtnEl;constructor(){super();let t=m(this,Qt),e=document.createElement("div");e.className="bar";let s=document.createElement("div");s.className="left",this.wavesEl=document.createElement("div"),this.wavesEl.className="waves",this.metaEl=document.createElement("span"),this.metaEl.className="meta",this.metaEl.setAttribute("data-moss-role","realtime-status"),this.metaEl.textContent="实时语音待命",s.appendChild(this.wavesEl),s.appendChild(this.metaEl);let i=document.createElement("div");i.className="actions",this.speakBtnEl=document.createElement("button"),this.speakBtnEl.type="button",this.speakBtnEl.className="moss-btn",this.speakBtnEl.setAttribute("data-moss-role","speak-summary"),this.speakBtnEl.appendChild(W(13)),this.speakBtnEl.appendChild(document.createTextNode("朗读纪要")),this.speakBtnEl.addEventListener("click",()=>void this.speakSummary()),this.toggleBtnEl=document.createElement("button"),this.toggleBtnEl.type="button",this.toggleBtnEl.className="moss-btn moss-btn-primary",this.toggleBtnEl.setAttribute("data-moss-role","toggle-realtime"),this.toggleBtnEl.addEventListener("click",()=>void this.toggleSession()),i.appendChild(this.speakBtnEl),i.appendChild(this.toggleBtnEl),e.appendChild(s),e.appendChild(i),t.appendChild(e),this.render()}disconnectedCallback(){this.stopWaveTimer()}configure(t){if(t.topic)this.setAttribute("topic",t.topic);if(t.theme&&t.theme!=="auto")this.setAttribute("theme",t.theme);if(t.getContext)this.getContextFn=t.getContext;if(t.getSummaryText)this.getSummaryTextFn=t.getSummaryText;if(t.onStateChange)this.onStateCb=t.onStateChange}async toggleSession(){if(this.busy)return{via:"fallback",active:this.active,statusText:this.metaEl.textContent??""};this.busy=!0,this.render();try{if(!this.active){let e=await kt({topic:this.getAttribute("topic")??document.title,context:this.getContextFn?.()??""});if(this.active=e.active,this.sessionId=e.sessionId,this.elapsedSec=0,this.active)this.startWaveTimer();return this.metaEl.textContent=e.statusText,this.onStateCb?.(e),this.dispatchEvent(new CustomEvent("moss-realtime-voice-state",{detail:e,bubbles:!0,composed:!0})),e}let t=await wt(this.sessionId!==void 0?{sessionId:this.sessionId}:{});return this.active=!1,this.sessionId=void 0,this.stopWaveTimer(),this.metaEl.textContent=t.statusText,this.onStateCb?.(t),this.dispatchEvent(new CustomEvent("moss-realtime-voice-state",{detail:t,bubbles:!0,composed:!0})),t}finally{this.busy=!1,this.render()}}async speakSummary(t){let e=(t??this.getSummaryTextFn?.()??"会议要点已准备就绪。").trim(),s=await F({text:e});return this.metaEl.textContent=s.statusText,this.dispatchEvent(new CustomEvent("moss-voice-spoken",{detail:s,bubbles:!0,composed:!0})),s}startWaveTimer(){this.stopWaveTimer(),this.waveTimer=setInterval(()=>{this.elapsedSec+=1;let t=String(Math.floor(this.elapsedSec/60)).padStart(2,"0"),e=String(this.elapsedSec%60).padStart(2,"0");this.metaEl.textContent=`实时语音中 · ${t}:${e}`,this.renderWaves()},500)}stopWaveTimer(){if(this.waveTimer!==null)clearInterval(this.waveTimer),this.waveTimer=null}renderWaves(){this.wavesEl.textContent="";let t=this.active?[6,14,18,10,16,8,12,17,9,13]:[4,7,11,8,5,4,7,10,6,4];for(let e=0;e<t.length;e+=1){let s=document.createElement("span");s.className="wave-bar";let i=this.active?(this.elapsedSec+e)%3*2:0;s.style.height=`${Math.min(22,t[e]+i)}px`,s.style.opacity=this.active?"0.9":"0.35",this.wavesEl.appendChild(s)}}render(){this.renderWaves(),this.toggleBtnEl.textContent="",this.toggleBtnEl.appendChild(pt(this.busy)),this.toggleBtnEl.appendChild(document.createTextNode(this.active?"结束实时语音":"开启实时语音")),this.toggleBtnEl.disabled=this.busy,this.speakBtnEl.disabled=this.busy}}function R(){if(typeof customElements>"u")return;if(!customElements.get("moss-voice-button"))customElements.define("moss-voice-button",H);if(!customElements.get("moss-realtime-voice-bar"))customElements.define("moss-realtime-voice-bar",N)}function ot(t={}){R();let e=document.createElement("moss-voice-button");return e.configure(t),(t.container??document.body).appendChild(e),e}function at(t={}){R();let e=document.createElement("moss-realtime-voice-bar");return e.configure(t),(t.container??document.body).appendChild(e),e}function rt(){g(),R(),E()}rt();var Ct=Object.freeze({version:x,tokensCss:D,catalog:P,recipes:U,MossButton:T,MossCard:S,MossTabs:A,MossDrawer:B,MossDialog:L,MossBadge:I,MossToast:f,MossMarkdown:O,MossVoiceButton:H,MossRealtimeVoiceBar:N,MossSelectionAsk:k,MossCompanionDrawer:w,MossbotMeetingBar:C,MossMediaTrigger:M,mountButton:Y,mountCard:Z,mountTabs:tt,mountDrawer:et,mountDialog:st,mountBadge:it,mountMarkdown:nt,mountVoiceButton:ot,mountRealtimeVoiceBar:at,mountSelectionAsk:q,mountCompanionDrawer:J,mountMossbotMeetingBar:Q,mountMediaTrigger:X,registerMossUIKit:rt});if(typeof globalThis<"u")globalThis.MossUIKit=Ct;var Yt=Ct;})();
