import { PAGE_APP_BUILTIN_CAPABILITIES, PAGE_APP_PREVIEW_LIMITS } from "@moss/contracts";
import { isPageAppHttpOrigin } from "./pageAppContentPolicy";

/** Only a nonce and the public parent origin enter the document. The parent
 * holds the proof, forwards each state request and never returns owner data. */
export function buildGuestReadonlyPermissionRuntime(
  origin: string,
  nonce: string,
  protocol: string,
): string {
  if (!isPageAppHttpOrigin(origin) || !/^[A-Za-z0-9_-]{16,64}$/u.test(nonce))
    throw new Error("Invalid guest frame");
  const script = `(() => {
"use strict";
const origin=${JSON.stringify(origin)}, nonce=${JSON.stringify(nonce)}, protocol=${JSON.stringify(protocol)};
const states=Object.freeze(Object.fromEntries(${JSON.stringify(PAGE_APP_BUILTIN_CAPABILITIES)}.map(name => [name,name==="permissions"?"granted":"unavailable"])));
const send=parent.postMessage.bind(parent), deadline=${PAGE_APP_PREVIEW_LIMITS.operationMs};
let ready=false, next=0, pending=null;
const submit=()=>{if(ready && pending && !pending.sent){pending.sent=true;send({protocol,nonce,kind:"permissions-state",id:pending.id},origin);}};
function state(name) {
  if(name!==undefined && (typeof name!=="string" || !/^[a-z][a-z0-9-]{0,31}$/.test(name))) return Promise.reject(Error("Invalid capability"));
  if(!pending){
    const id=++next; let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const timer=setTimeout(()=>{if(pending?.id===id){pending=null;reject(Error("Preview unavailable"));}},deadline);
    pending={id,promise,resolve,reject,timer,sent:false}; submit();
  }
  return pending.promise.then(()=>name===undefined?states:Object.prototype.hasOwnProperty.call(states,name)?states[name]:"unavailable");
}
addEventListener("message",event=>{
  if(event.source!==parent || event.origin!==origin) return;
  const m=event.data;
  if(!m || m.protocol!==protocol || m.nonce!==nonce) return;
  if(m.kind==="permissions-ready"){ready=true;submit();return;}
  if(m.kind!=="permissions-state-result" || !pending || !pending.sent || m.id!==pending.id) return;
  const current=pending; pending=null;clearTimeout(current.timer);
  if(m.ok===true) current.resolve(); else current.reject(Error("Preview unavailable"));
});
const permissions=Object.freeze({state});
Object.defineProperty(window,"moss",{value:Object.freeze({use:name=>Promise.resolve(name==="permissions"?permissions:null)}),writable:false,configurable:false});
})();`;
  return script.replace(/<\//gu, "<\\/");
}
