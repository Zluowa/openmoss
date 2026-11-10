// FILE: htmlRenderMaps.ts
// Purpose: Live maps in html_render pages. A page calls `window.mossMaps.create(...)`; the
//   server stores the page with the map helper and Moss's own copy of the map libraries,
//   never a map key. When the page opens in the Moss app, the helper asks the app which map
//   to draw (`moss/mapConfig`) and gets the provider and key for the reader's account then.
// Layer: Shared runtime utility (provider rules for the server, script source for HTML renders)
// Exports: HTML_RENDER_MAP_ENV, resolveHtmlRenderMapConfig, resolveGuestHtmlRenderMapConfig,
//   htmlUsesMossMaps,
//   htmlRenderMapLibraries, MOSS_MAPS_SCRIPT_SOURCE,
//   HTML_RENDER_MAP_STYLE_URL, HTML_RENDER_MAP_ATTRIBUTION
//
// Providers, by account lane:
// - mainland China (phone) accounts: Amap; without an Amap key (or when it cannot load), the
//   stops and line on a plain background with a note, because a map shown in mainland China
//   must use approved map data, so no OpenStreetMap basemap there.
// - every other account: Google Maps; without a Google key (or when it cannot load), the
//   OpenFreeMap world map (https://openfreemap.org/, terms https://openfreemap.org/tos/:
//   no key, commercial use allowed, attribution required), drawn by the bundled MapLibre GL.
// The person's own keys in the server environment override the keys Moss ships.

import { HTML_RENDER_MAP_CONFIG_METHOD } from "./htmlRender";
import {
  LEAFLET_CSS,
  LEAFLET_JS,
  MAPLIBRE_GL_CSS,
  MAPLIBRE_GL_JS,
  MAPLIBRE_GL_LEAFLET_JS,
} from "./htmlRenderMapAssets.generated";
import { MOSS_PUBLIC_MAPS_ENV } from "./mossProductionPublicConfig";

/** The person's own map keys, set in the Moss server's environment. They win over Moss's. */
export const HTML_RENDER_MAP_ENV = {
  googleApiKey: "MOSS_GOOGLE_MAPS_API_KEY",
  amapKey: "MOSS_AMAP_JS_KEY",
  amapSecurityCode: "MOSS_AMAP_SECURITY_CODE",
} as const;

export type HtmlRenderMapLane = "cn" | "global";

/** What the app hands a live map page. A key never appears in a stored page. */
export type HtmlRenderMapConfig =
  | {
      readonly lane: "global";
      readonly provider: "google";
      readonly google: { readonly apiKey: string };
    }
  | { readonly lane: "global"; readonly provider: "openfreemap" }
  | {
      readonly lane: "cn";
      readonly provider: "amap";
      readonly amap: { readonly key: string; readonly securityJsCode?: string };
    }
  | { readonly lane: "cn"; readonly provider: "plain" };

type MapEnv = Readonly<Record<string, string | undefined>>;

const envValue = (env: MapEnv, name: string) => env[name]?.trim() || undefined;

/**
 * The map for an account lane: the lane's provider when a key is there (the person's own
 * first, then Moss's), otherwise the lane's keyless fallback.
 */
export function resolveHtmlRenderMapConfig(input: {
  readonly env: MapEnv;
  readonly lane: HtmlRenderMapLane;
}): HtmlRenderMapConfig {
  const { env, lane } = input;
  if (lane === "cn") {
    const own = envValue(env, HTML_RENDER_MAP_ENV.amapKey);
    const key = own ?? envValue(env, MOSS_PUBLIC_MAPS_ENV.amapKey);
    if (!key) return { lane, provider: "plain" };
    // A security code belongs to its key, so the person's key never takes Moss's code.
    const securityJsCode = own
      ? envValue(env, HTML_RENDER_MAP_ENV.amapSecurityCode)
      : envValue(env, MOSS_PUBLIC_MAPS_ENV.amapSecurityCode);
    return { lane, provider: "amap", amap: { key, ...(securityJsCode ? { securityJsCode } : {}) } };
  }
  const apiKey =
    envValue(env, HTML_RENDER_MAP_ENV.googleApiKey) ??
    envValue(env, MOSS_PUBLIC_MAPS_ENV.googleApiKey);
  return apiKey
    ? { lane, provider: "google", google: { apiKey } }
    : { lane, provider: "openfreemap" };
}

/**
 * The map a shared conversation's guest gets: the same lane, but only the keys Moss ships
 * publicly. The person's own key is theirs and never leaves their computer.
 */
export function resolveGuestHtmlRenderMapConfig(input: {
  readonly env: MapEnv;
  readonly lane: HtmlRenderMapLane;
}): HtmlRenderMapConfig {
  const publicEnv: Record<string, string | undefined> = {};
  for (const name of Object.values(MOSS_PUBLIC_MAPS_ENV)) publicEnv[name] = input.env[name];
  return resolveHtmlRenderMapConfig({ env: publicEnv, lane: input.lane });
}

/** The OpenFreeMap style the keyless world map uses. */
export const HTML_RENDER_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

/** OpenFreeMap's required credit, as its own tile metadata words it. */
export const HTML_RENDER_MAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

/**
 * Plain ES2017, after the inlined Leaflet, MapLibre GL and binding. Pages run in a sandbox
 * with an opaque origin, where storage and cookies throw; the helper first gives the map
 * SDKs in-memory stand-ins, so a provider that caches tiles or settings starts instead of
 * failing.
 *
 * `window.mossMaps.create(container, options)` resolves to
 * `{ provider, pins, setLineCount(n), setActive(i), focus(i), fit(), destroy(), native }`.
 * Options: `points` ([{ lat, lng, title? }], 1-30), `coordinates` ("wgs84" by default, or
 * "gcj02" for points from Amap), `line` (a line through the points in order), `zoom`,
 * `onError(message)`. It always draws a map: a provider that cannot load falls back to its
 * lane's keyless map. A page outside the Moss app (a download, the headless preview) gets
 * the plain map, since only the app knows the reader's account.
 */
const MOSS_MAPS_SOURCE = `(function(){
var Leaflet=window.L,STYLE=${JSON.stringify(HTML_RENDER_MAP_STYLE_URL)},CREDIT=${JSON.stringify(HTML_RENDER_MAP_ATTRIBUTION)},METHOD=${JSON.stringify(HTML_RENDER_MAP_CONFIG_METHOD)};
function memoryStorage(){var m={};return {getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null;},setItem:function(k,v){m[k]=String(v);},removeItem:function(k){delete m[k];},clear:function(){m={};},key:function(i){return Object.keys(m)[i]||null;},get length(){return Object.keys(m).length;}};}
["localStorage","sessionStorage"].forEach(function(n){try{window[n].getItem("moss");}catch(e){try{Object.defineProperty(window,n,{value:memoryStorage(),configurable:true});}catch(x){}}});
try{void document.cookie;}catch(e){try{var jar="";Object.defineProperty(document,"cookie",{get:function(){return jar;},set:function(){},configurable:true});}catch(x){}}
var PI=Math.PI;
var REGION=[[79.4462,42.8899,96.33,49.2204],[109.6872,39.3742,135.0002,54.1415],[73.1246,29.5297,124.143255,42.8899],[82.9684,26.7186,97.0352,29.5297],[97.0253,20.414096,124.367395,29.5297],[107.975793,17.871542,111.744104,20.414096]];
var EXCLUDE=[[119.921265,21.785006,122.497559,25.398623],[101.8652,20.0988,106.665,22.284],[106.4525,20.4878,108.051,21.5422],[109.0323,50.3257,119.127,55.8175],[127.4568,49.5574,137.0227,55.8175],[131.2662,42.5692,137.0227,44.8922]];
function inBox(b,lng,lat){return lng>=b[0]&&lng<=b[2]&&lat>=b[1]&&lat<=b[3];}
function inChina(lng,lat){return REGION.some(function(b){return inBox(b,lng,lat);})&&!EXCLUDE.some(function(b){return inBox(b,lng,lat);});}
function tLat(x,y){var r=-100+2*x+3*y+0.2*y*y+0.1*x*y+0.2*Math.sqrt(Math.abs(x));r+=(20*Math.sin(6*x*PI)+20*Math.sin(2*x*PI))*2/3;r+=(20*Math.sin(y*PI)+40*Math.sin(y/3*PI))*2/3;r+=(160*Math.sin(y/12*PI)+320*Math.sin(y*PI/30))*2/3;return r;}
function tLng(x,y){var r=300+x+2*y+0.1*x*x+0.1*x*y+0.1*Math.sqrt(Math.abs(x));r+=(20*Math.sin(6*x*PI)+20*Math.sin(2*x*PI))*2/3;r+=(20*Math.sin(x*PI)+40*Math.sin(x/3*PI))*2/3;r+=(150*Math.sin(x/12*PI)+300*Math.sin(x/30*PI))*2/3;return r;}
function toGcj(lng,lat){
  if(!inChina(lng,lat))return [lng,lat];
  var a=6378245.0,ee=0.00669342162296594323;
  var dLat=tLat(lng-105,lat-35),dLng=tLng(lng-105,lat-35),rad=lat/180*PI,m=Math.sin(rad);
  m=1-ee*m*m;var s=Math.sqrt(m);
  dLat=(dLat*180)/((a*(1-ee))/(m*s)*PI);dLng=(dLng*180)/(a/s*Math.cos(rad)*PI);
  return [lng+dLng,lat+dLat];
}
function toWgs(lng,lat){var g=toGcj(lng,lat);return [lng*2-g[0],lat*2-g[1]];}
function readPoints(points){
  if(!Array.isArray(points)||points.length<1||points.length>30)throw new Error("A map needs 1-30 points.");
  return points.map(function(p){
    var lat=Number(p&&p.lat),lng=Number(p&&p.lng);
    if(!isFinite(lat)||!isFinite(lng)||lat<-90||lat>90||lng<-180||lng>180)throw new Error("Each point needs a lat and lng in degrees.");
    return {lat:lat,lng:lng,title:p&&p.title?String(p.title):""};
  });
}
function text(value){return typeof value==="string"?value:"";}
function readConfig(value){
  var v=value&&typeof value==="object"?value:{},note=text(v.note).slice(0,300);
  if(v.provider==="google"&&v.google&&text(v.google.apiKey))return {provider:"google",fallback:"openfreemap",google:{apiKey:v.google.apiKey},note:note};
  if(v.provider==="amap"&&v.amap&&text(v.amap.key))return {provider:"amap",fallback:"plain",amap:{key:v.amap.key,securityJsCode:text(v.amap.securityJsCode)},note:note};
  if(v.provider==="openfreemap")return {provider:"openfreemap",fallback:"openfreemap",note:note};
  return {provider:"plain",fallback:"plain",note:note};
}
var configLoad=null;
function hostConfig(){
  configLoad=configLoad||new Promise(function(resolve){
    if(window.parent===window){resolve(readConfig(null));return;}
    var id="moss-map-config-"+Math.random().toString(36).slice(2),done=false,timer;
    function finish(value){if(done)return;done=true;clearTimeout(timer);window.removeEventListener("message",onMessage);resolve(readConfig(value));}
    function onMessage(e){var d=e.data;if(e.source===window.parent&&d&&d.jsonrpc==="2.0"&&d.id===id)finish(d.result);}
    window.addEventListener("message",onMessage);
    timer=setTimeout(function(){finish(null);},3000);
    window.parent.postMessage({jsonrpc:"2.0",id:id,method:METHOD},"*");
  });
  return configLoad;
}
function isDark(){return /dark/.test(getComputedStyle(document.documentElement).colorScheme||"");}
function styleOnce(){
  if(document.getElementById("moss-map-style"))return;
  var s=document.createElement("style");s.id="moss-map-style";
  s.textContent=".moss-map-anchor{position:absolute;transform:translate(-50%,-50%)}.moss-map-pin{display:grid;place-items:center;min-width:24px;height:24px;padding:0 6px;box-sizing:border-box;border-radius:999px;background:var(--foreground,#111);color:var(--background,#fff);font:600 12px/1 var(--font-sans,sans-serif);border:2px solid var(--background,#fff);box-shadow:0 1px 3px rgba(0,0,0,.35);cursor:pointer}.moss-map-pin[data-active]{background:var(--primary,#d9534f);color:var(--primary-foreground,#fff)}.moss-map-icon{background:none;border:0}.moss-map-plain{background:var(--muted,#f1f1f0)!important;background-image:radial-gradient(circle,var(--border,rgba(0,0,0,.12)) 1px,transparent 1px)!important;background-size:16px 16px!important}.moss-map-note{position:absolute;left:8px;right:8px;bottom:8px;z-index:1000;margin:0;padding:6px 10px;border-radius:8px;background:var(--background,#fff);color:var(--muted-foreground,#555);font:12px/1.4 var(--font-sans,sans-serif);box-shadow:0 1px 3px rgba(0,0,0,.2)}";
  document.head.appendChild(s);
}
function pin(index,title){var d=document.createElement("span");d.className="moss-map-pin";d.textContent=String(index+1);if(title){d.title=title;d.setAttribute("aria-label",(index+1)+". "+title);}return d;}
function withTimeout(promise,name){return new Promise(function(resolve,reject){var t=setTimeout(function(){reject(new Error(name+" did not load in time."));},10000);promise.then(function(v){clearTimeout(t);resolve(v);},function(e){clearTimeout(t);reject(e);});});}
function loadScript(src,ready,name){
  return withTimeout(new Promise(function(resolve,reject){
    var s=document.createElement("script");s.src=src;s.async=true;
    s.onload=function(){var v=ready();v?resolve(v):reject(new Error(name+" did not start."));};
    s.onerror=function(){reject(new Error(name+" could not be loaded on this network."));};
    document.head.appendChild(s);
  }),name);
}
var googleLoad=null,amapLoad=null;
function loadGoogle(config,onError){
  if(window.google&&google.maps&&google.maps.OverlayView)return Promise.resolve(google.maps);
  window.gm_authFailure=function(){onError("Google Maps did not accept this map key.");};
  googleLoad=googleLoad||withTimeout(new Promise(function(resolve,reject){
    var cb="__mossGoogleMapsReady";window[cb]=function(){resolve(google.maps);};
    var s=document.createElement("script");
    s.src="https://maps.googleapis.com/maps/api/js?key="+encodeURIComponent(config.google.apiKey)+"&v=weekly&loading=async&callback="+cb;
    s.async=true;s.onerror=function(){reject(new Error("Google Maps could not be loaded on this network."));};
    document.head.appendChild(s);
  }),"Google Maps").catch(function(e){googleLoad=null;throw e;});
  return googleLoad;
}
function loadAmap(config){
  if(window.AMap&&AMap.Map)return Promise.resolve(window.AMap);
  // Amap's JS API takes its security code in the page. It is a client key, so this is
  // accepted for now; a Moss proxy that adds the code server-side (serviceHost) goes here later.
  if(config.amap.securityJsCode)window._AMapSecurityConfig={securityJsCode:config.amap.securityJsCode};
  amapLoad=amapLoad||loadScript("https://webapi.amap.com/maps?v=2.0&key="+encodeURIComponent(config.amap.key)+"&plugin=AMap.ToolBar,AMap.Scale",function(){return window.AMap&&AMap.Map?window.AMap:null;},"Amap").catch(function(e){amapLoad=null;throw e;});
  return amapLoad;
}
function lineColor(){return getComputedStyle(document.documentElement).getPropertyValue("--chart-1").trim()||"#d9534f";}
function googleMap(maps,el,pts,o){
  var dark=isDark();
  // Google's street map of mainland China is drawn in GCJ-02 too, so those points convert as well.
  var path=pts.map(function(p){var q=o.coordinates==="gcj02"?[p.lng,p.lat]:toGcj(p.lng,p.lat);return {lat:q[1],lng:q[0]};});
  var map=new maps.Map(el,{center:path[0],zoom:o.zoom||12,gestureHandling:"cooperative",clickableIcons:false,mapTypeControl:false,streetViewControl:false,fullscreenControl:true,styles:dark?[{elementType:"geometry",stylers:[{color:"#242f3e"}]},{elementType:"labels.text.fill",stylers:[{color:"#9ca5b3"}]},{elementType:"labels.text.stroke",stylers:[{color:"#242f3e"}]},{featureType:"road",elementType:"geometry",stylers:[{color:"#38414e"}]},{featureType:"water",elementType:"geometry",stylers:[{color:"#17263c"}]}]:null});
  var pins=[],overlays=pts.map(function(p,i){
    var anchor=document.createElement("div");anchor.className="moss-map-anchor";var dot=pin(i,p.title);anchor.appendChild(dot);pins.push(dot);
    var ov=new maps.OverlayView(),pos=new maps.LatLng(path[i].lat,path[i].lng);
    ov.onAdd=function(){this.getPanes().overlayMouseTarget.appendChild(anchor);};
    ov.draw=function(){var q=this.getProjection().fromLatLngToDivPixel(pos);if(q){anchor.style.left=q.x+"px";anchor.style.top=q.y+"px";}};
    ov.onRemove=function(){anchor.remove();};ov.setMap(map);return ov;
  });
  var line=o.line?new maps.Polyline({path:path,strokeColor:lineColor(),strokeOpacity:0.85,strokeWeight:2,map:map}):null;
  function fit(){if(pts.length===1){map.setCenter(path[0]);map.setZoom(o.zoom||12);return;}var b=new maps.LatLngBounds();path.forEach(function(p){b.extend(p);});map.fitBounds(b,48);}
  return {provider:"google",native:map,pins:pins,fit:fit,
    setLineCount:function(n){if(line)line.setPath(path.slice(0,Math.max(0,Math.min(path.length,n))));},
    focus:function(i){if(path[i])map.panTo(path[i]);},
    destroy:function(){overlays.forEach(function(ov){ov.setMap(null);});if(line)line.setMap(null);}};
}
function amapMap(AMap,el,pts,o){
  var path=pts.map(function(p){return o.coordinates==="gcj02"?[p.lng,p.lat]:toGcj(p.lng,p.lat);});
  var map=new AMap.Map(el,{zoom:o.zoom||12,center:path[0],viewMode:"2D",scrollWheel:false,mapStyle:isDark()?"amap://styles/dark":"amap://styles/normal"});
  if(AMap.ToolBar)map.addControl(new AMap.ToolBar({position:"RB"}));
  if(AMap.Scale)map.addControl(new AMap.Scale());
  var pins=[],markers=path.map(function(p,i){var dot=pin(i,pts[i].title);pins.push(dot);return new AMap.Marker({position:p,content:dot,anchor:"center"});});
  map.add(markers);
  var line=o.line?new AMap.Polyline({path:path,strokeColor:lineColor(),strokeOpacity:0.85,strokeWeight:2}):null;
  if(line)map.add(line);
  function fit(){if(pts.length===1){map.setZoomAndCenter(o.zoom||12,path[0]);return;}map.setFitView(markers,false,[48,48,48,48]);}
  return {provider:"amap",native:map,pins:pins,fit:fit,
    setLineCount:function(n){if(!line)return;n=Math.max(0,Math.min(path.length,n));if(n<2){line.hide();return;}line.setPath(path.slice(0,n));line.show();},
    focus:function(i){if(path[i])map.panTo(path[i]);},
    destroy:function(){map.destroy();}};
}
function reason(error){var t=error&&(error.message||(error.error&&error.error.message));return typeof t==="string"&&t?t:"The map could not be drawn.";}
// The keyless maps: OpenFreeMap under Leaflet for "openfreemap", no basemap for "plain".
function leafletMap(el,pts,o,basemap,note,onError){
  if(!Leaflet||typeof Leaflet.map!=="function")throw new Error("The map library did not load.");
  el.innerHTML="";
  var path=pts.map(function(p){var q=o.coordinates==="gcj02"?toWgs(p.lng,p.lat):[p.lng,p.lat];return [q[1],q[0]];});
  var map=Leaflet.map(el,{scrollWheelZoom:false,attributionControl:basemap,zoomSnap:0.5});
  function fit(){map.invalidateSize();if(pts.length===1){map.setView(path[0],o.zoom||12);return;}map.fitBounds(path,{padding:[48,48]});}
  // The basemap layer reads the map's view when it is added, so the view comes first.
  fit();
  var provider="plain";
  if(basemap&&typeof Leaflet.maplibreGL==="function"){
    try{
      var layer=Leaflet.maplibreGL({style:STYLE,attributionControl:{customAttribution:CREDIT}}).addTo(map),gl=layer.getMaplibreMap(),loaded=false;
      if(gl){provider="openfreemap";gl.once("load",function(){loaded=true;});gl.on("error",function(e){if(!loaded)onError("The map background could not be drawn: "+reason(e));});}
    }catch(error){onError("The map background could not be drawn: "+reason(error));}
  }
  if(provider==="plain"){
    if(map.attributionControl)map.removeControl(map.attributionControl);
    el.classList.add("moss-map-plain");
    if(note){var n=document.createElement("p");n.className="moss-map-note";n.setAttribute("role","note");n.textContent=note;el.appendChild(n);}
  }
  var pins=[],markers=path.map(function(p,i){
    var anchor=document.createElement("div");anchor.className="moss-map-anchor";var dot=pin(i,pts[i].title);anchor.appendChild(dot);pins.push(dot);
    return Leaflet.marker(p,{icon:Leaflet.divIcon({className:"moss-map-icon",html:anchor,iconSize:[0,0]}),keyboard:false}).addTo(map);
  });
  var line=o.line?Leaflet.polyline(path,{color:lineColor(),opacity:0.85,weight:2}).addTo(map):null;
  return {provider:provider,native:map,pins:pins,fit:fit,
    setLineCount:function(n){if(line)line.setLatLngs(path.slice(0,Math.max(0,Math.min(path.length,n))));},
    focus:function(i){if(path[i])map.panTo(path[i]);},
    destroy:function(){markers.forEach(function(m){m.remove();});map.remove();}};
}
function create(el,options){
  var o=options||{};
  return Promise.resolve().then(function(){
    if(!el||!el.appendChild)throw new Error("mossMaps.create needs a container element.");
    var pts=readPoints(o.points),onError=typeof o.onError==="function"?o.onError:function(){};
    styleOnce();
    return hostConfig().then(function(config){
      function keyless(error){if(error)onError(reason(error));return leafletMap(el,pts,o,config.fallback==="openfreemap",config.note,onError);}
      if(config.provider==="google")return loadGoogle(config,onError).then(function(maps){return googleMap(maps,el,pts,o);}).catch(keyless);
      if(config.provider==="amap")return loadAmap(config).then(function(AMap){return amapMap(AMap,el,pts,o);}).catch(keyless);
      return keyless(null);
    }).then(function(m){
      var active=-1;
      m.setActive=function(i){if(i===active)return;if(m.pins[active])m.pins[active].removeAttribute("data-active");active=i;if(m.pins[i])m.pins[i].setAttribute("data-active","");};
      m.setLineCount(o.line?pts.length:0);
      m.fit();
      return m;
    });
  });
}
window.mossMaps={inChina:function(lat,lng){return inChina(Number(lng),Number(lat));},toGcj02:function(lat,lng){var r=toGcj(Number(lng),Number(lat));return {lat:r[1],lng:r[0]};},create:create};
})();`;

/** For tests: the helper source. It carries no key: the app hands keys to the live page. */
export const MOSS_MAPS_SCRIPT_SOURCE = MOSS_MAPS_SOURCE;

/** Whether a page calls the map helper, so only those pages carry it and the map libraries. */
export function htmlUsesMossMaps(html: string): boolean {
  return /\bmossMaps\b/.test(html);
}

/**
 * The head markup that gives a map page its libraries and the helper, for the server to
 * store with the page. Empty for any other page. It never holds a key.
 */
export function htmlRenderMapLibraries(html: string): string {
  if (!htmlUsesMossMaps(html)) return "";
  return [
    `<style>${LEAFLET_CSS}\n${MAPLIBRE_GL_CSS}</style>`,
    `<script>${MAPLIBRE_GL_JS}</script>`,
    `<script>${LEAFLET_JS}</script>`,
    `<script>${MAPLIBRE_GL_LEAFLET_JS}</script>`,
    `<script>${MOSS_MAPS_SOURCE}</script>`,
  ].join("");
}
