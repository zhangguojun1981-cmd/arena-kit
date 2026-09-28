/* ArenaKit injected/unlock.js
 * Source: theraker526/Arena-AI-Model-Unlocker-Extension (opus-restorer, research use)
 * MAIN world, document_start. Rewrites Next.js __next_f data to reveal hidden models.
 * PORT NOTE: the extension's boot.js (extension storage → window._ac) is replaced
 * by the ArenaKit boot below; the dock's switches reach it via __AK_UNLOCK_SET__.
 */
// ---- ArenaKit boot (replaces the extension's boot.js) ----
// The extension kept its settings in extension storage and handed them to
// the MAIN-world interceptor through window._ac. Here both halves run in the
// MAIN world at document_start, so the settings live in localStorage "_at"
// ({e: enabled, o: Opus, h: hidden/blind-test models}) and the dock writes
// them through window.__AK_UNLOCK_SET__(kind, on) (更多 → 解锁 Opus 全系 /
// 解锁隐藏 / 盲测模型). The rewrite below runs while the page data streams
// in, so a change applies on the next page load — the dock reloads.
(function(){
var d={e:true,o:false,h:false};
try{var s=localStorage.getItem("_at");if(s)d=Object.assign(d,JSON.parse(s)||{});}catch(x){}
window._ac=d;
window.__AK_UNLOCK_SET__=function(kind,on){
var cur={};try{cur=JSON.parse(localStorage.getItem("_at")||"{}")||{};}catch(x){cur={};}
var k=kind==="opus"?"o":kind==="hidden"?"h":kind==="enabled"?"e":"";
if(!k)return{ok:false};
var before=cur[k];cur[k]=!!on;
try{localStorage.setItem("_at",JSON.stringify(cur));}catch(x){return{ok:false};}
return{ok:true,changed:before!==cur[k],settings:cur};
};
window.__AK_UNLOCK_GET__=function(){try{return JSON.parse(localStorage.getItem("_at")||"null")||d;}catch(x){return d;}};
})();
// ---- main.js (data interceptor) — ArenaKit safe rewrite ----
// The extension's interceptor, made safe for the React Server Component
// stream Next.js hydrates from (0.4.4 activated it for the first time and
// taps on the page stopped working):
//   * every edit keeps the byte length: RSC text rows are length-prefixed, a
//     shorter string corrupts the parse → React never hydrates → no click
//     handlers. false → "true " and "disable-opus" → "$undefined" + spaces
//     (JSON whitespace, all ASCII);
//   * router fetches are rewritten as a stream (no buffering) and only for
//     text/x-component; the replacement Response keeps url / redirected /
//     type (Next's router reads them); chat streams (text/plain,
//     text/event-stream) are never touched;
//   * any error → the original data, untouched.
(function(){
var c=window._ac||{e:true,o:false,h:false};
delete window._ac;
if(!c.e||(!c.o&&!c.h))return;
function keep(orig,repl){var pad=orig.length-repl.length;return pad<0?orig:repl+" ".repeat(pad);}
function p(s){
if(typeof s!=="string"||s.length<40)return s;
try{
var m=s;
if(c.o){
m=m.replace(/(\\?)"disable-opus\1"(\s*):(\s*)\1"disable-opus\1"/g,function(all,b,s1,s2){return keep(all,b+'"disable-opus'+b+'"'+s1+':'+s2+b+'"$undefined'+b+'"');});
m=m.replace(/(\\?"(?:publicName|name)\\?":\s*\\?"[^"\\]*opus[^"\\]*\\?"[\s\S]{0,500}?\\?"userSelectable\\?":\s*)false/gi,function(all,pre){return pre+"true ";});
}
if(c.h){
m=m.replace(/(\\?"userSelectable\\?":\s*)false/g,function(all,pre){return pre+"true ";});
}
return m.length===s.length?m:s;
}catch(e){return s;}
}
var np=Array.prototype.push;
function pp(){
var a=arguments;
for(var i=0;i<a.length;i++){if(Array.isArray(a[i])){for(var j=1;j<a[i].length;j++)a[i][j]=p(a[i][j]);}}
return np.apply(this,a);
}
function patch(v){if(Array.isArray(v)){for(var i=0;i<v.length;i++){if(Array.isArray(v[i])){for(var j=1;j<v[i].length;j++)v[i][j]=p(v[i][j]);}}if(v.push===np)v.push=pp;}}
try{
var f=self.__next_f;
Object.defineProperty(self,"__next_f",{configurable:true,enumerable:true,
get:function(){return f;},
set:function(v){f=v;patch(v);}
});
if(Array.isArray(f))patch(f);
}catch(e){}
var of=self.fetch;
if(typeof of!=="function")return;
function rewriteStream(r){
if(!r||!r.ok||!r.body||typeof TransformStream!=="function"||typeof TextDecoder!=="function"||typeof TextEncoder!=="function")return r;
var dec=new TextDecoder(),enc=new TextEncoder();
var ts=new TransformStream({
transform:function(chunk,ctl){ctl.enqueue(enc.encode(p(dec.decode(chunk,{stream:true}))));},
flush:function(ctl){var t=dec.decode();if(t)ctl.enqueue(enc.encode(p(t)));}
});
var out=new Response(r.body.pipeThrough(ts),{status:r.status,statusText:r.statusText,headers:r.headers});
try{Object.defineProperty(out,"url",{value:r.url});Object.defineProperty(out,"redirected",{value:r.redirected});Object.defineProperty(out,"type",{value:r.type});}catch(e){return r;}
return out;
}
self.fetch=function(){var a=arguments;return of.apply(this,a).then(function(r){
try{
var u=typeof a[0]==="string"?a[0]:(a[0]&&a[0].url)||"";
u=String(u);
if(!(u.charAt(0)==="/"&&u.charAt(1)!=="/")&&!/^https:\/\/([\w-]+\.)*(lm)?arena\.ai\//.test(u))return r;
var ct=(r.headers&&r.headers.get("content-type"))||"";
if(ct.indexOf("text/x-component")===-1)return r;
return rewriteStream(r);
}catch(e){return r;}
});};
})();
