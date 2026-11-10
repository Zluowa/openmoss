// FILE: tripAnimator.ts
// Purpose: `window.createTripAnimator`, the shared controller an agent's itinerary page uses
//   to drop numbered map pins one by one, with pause, replay, seek and reduced motion.
// Layer: Shared runtime utility (script source for HTML renders)
// Origin: Adapted from apps/app/src/components/generative-ui/open-generative-ui/trip-animator.ts
//   in Open Intelligent UI (https://github.com/CopilotKit/OpenIntelligentUI, MIT) at
//   8391a94. Moss ships it as plain script source, because a bundled function's
//   `toString()` can reference bundler helpers that do not exist inside the page.
//   See THIRD_PARTY_NOTICES.md.

/**
 * Plain ES2017 that defines `window.createTripAnimator(options)` and returns
 * `{ play, pause, replay, seek, dispose }`. Options: `stopCount` (2-30),
 * `durationMs` (1000-120000, default 6000), `pinElements` (the inner numbered
 * dots, never Leaflet's positioned wrappers), `onFrame(frame)` and
 * `onState("playing" | "paused" | "complete")`. A frame carries `progress`,
 * `pinIndex`, `pinProgress` and `activeStop`, all zero-based.
 */
export const TRIP_ANIMATOR_SOURCE = `(function(){
function createTripAnimator(options){
  var stopCount=options.stopCount,onFrame=options.onFrame,onState=options.onState;
  var duration=options.durationMs==null?6000:options.durationMs;
  if(!Number.isInteger(stopCount)||stopCount<2||stopCount>30)throw new Error("A trip needs 2-30 stops.");
  if(!Number.isFinite(duration)||duration<1000||duration>120000)throw new Error("Trip duration must be between 1 and 120 seconds.");
  if(typeof onFrame!=="function")throw new Error("createTripAnimator needs an onFrame callback.");
  var pins=Array.isArray(options.pinElements)?options.pinElements:[];
  pins.forEach(function(pin,index){if(pin&&!(pin.textContent||"").trim())pin.textContent=String(index+1);});
  var elapsed=0,lastTime=null,frameId=null,playing=false,disposed=false;
  function reduceMotion(){return !!(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches);}
  function state(value){if(typeof onState==="function")onState(value);}
  function emit(){
    var progress=Math.min(1,elapsed/duration);
    var step=progress*(stopCount-1);
    var fromIndex=Math.min(stopCount-2,Math.floor(step));
    var travel=Math.min(1,(step-fromIndex)/0.8);
    var fraction=travel*travel*(3-2*travel);
    var pinStep=progress*stopCount;
    var pinIndex=Math.min(stopCount-1,Math.floor(pinStep));
    var pinProgress=progress===1?1:Math.min(1,(pinStep-pinIndex)/0.55);
    pins.forEach(function(pin,index){
      if(!pin||!pin.style)return;
      var landing=index<pinIndex?1:index===pinIndex?pinProgress:0;
      var t=landing-1,ease=1+2.2*t*t*t+1.2*t*t;
      pin.style.opacity=landing>0?"1":"0";
      pin.style.transform="translateY("+(-18*(1-ease))+"px) scale("+(0.72+0.28*ease)+")";
    });
    onFrame({progress:progress,fromIndex:fromIndex,toIndex:fromIndex+1,fraction:fraction,activeStop:pinIndex,pinIndex:pinIndex,pinProgress:pinProgress});
  }
  function halt(){
    playing=false;lastTime=null;
    if(frameId!==null)cancelAnimationFrame(frameId);
    frameId=null;
  }
  function pause(){
    if(disposed)return;
    halt();
    state(elapsed>=duration?"complete":"paused");
  }
  function tick(time){
    if(!playing||disposed)return;
    if(lastTime!==null)elapsed=Math.min(duration,elapsed+Math.max(0,time-lastTime));
    lastTime=time;
    emit();
    if(elapsed>=duration)pause();else frameId=requestAnimationFrame(tick);
  }
  function play(){
    if(disposed||playing)return;
    if(reduceMotion()){elapsed=duration;emit();state("complete");return;}
    if(elapsed>=duration)return;
    playing=true;lastTime=null;state("playing");
    frameId=requestAnimationFrame(tick);
  }
  function seek(stop){
    if(disposed)return;
    if(!Number.isInteger(stop)||stop<0||stop>=stopCount)throw new Error("Stop index is outside this trip.");
    halt();
    elapsed=stop===stopCount-1?duration:duration*(stop+0.6)/stopCount;
    emit();
    state(elapsed>=duration?"complete":"paused");
  }
  function replay(){if(disposed)return;halt();elapsed=0;emit();play();}
  function onVisibility(){if(document.hidden)pause();}
  function dispose(){
    if(disposed)return;
    pause();disposed=true;
    document.removeEventListener("visibilitychange",onVisibility);
    window.removeEventListener("pagehide",dispose);
  }
  document.addEventListener("visibilitychange",onVisibility);
  window.addEventListener("pagehide",dispose);
  if(reduceMotion())elapsed=duration;
  emit();
  return {play:play,pause:pause,replay:replay,seek:seek,dispose:dispose};
}
window.createTripAnimator=createTripAnimator;
})();`;

/** Whether a page calls the shared animator, so only those pages carry it. */
export function htmlUsesTripAnimator(html: string): boolean {
  return /\bcreateTripAnimator\b/.test(html);
}
