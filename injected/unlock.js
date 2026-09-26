/* ArenaKit injected/unlock.js
 * Source: theraker526/Arena-AI-Model-Unlocker-Extension (opus-restorer, research use)
 * MAIN world, document_start. Rewrites Next.js __next_f data to reveal hidden models.
 * PORT NOTE: boot.js set window._ac from ArenaKit front-end config before this runs.
 */
// ---- boot.js (settings loader) ----
(function(){
var d={e:true,o:true,h:false};
try{var s=localStorage.getItem("_at");if(s)d=Object.assign(d,JSON.parse(s));}catch(x){}
var t=document.createElement("script");
t.textContent="window._ac="+JSON.stringify(d)+";";
(document.documentElement||document).prepend(t);
t.remove();
if(chrome.storage&&chrome.storage.sync){
chrome.storage.sync.get(d,function(r){localStorage.setItem("_at",JSON.stringify(r));});
chrome.storage.onChanged.addListener(function(c,a){if(a==="sync"){try{var cur=JSON.parse(localStorage.getItem("_at")||"{}");for(var k in c)cur[k]=c[k].newValue;localStorage.setItem("_at",JSON.stringify(cur));}catch(x){}}});
}
chrome.runtime&&chrome.runtime.onMessage&&chrome.runtime.onMessage.addListener(function(m,s,r){
if(m.t==="g"){try{var s=localStorage.getItem("_at");r(s?JSON.parse(s):d);}catch(x){r(d);}return true;}
if(m.t==="s"){try{var cur=JSON.parse(localStorage.getItem("_at")||"{}");Object.assign(cur,m.d);localStorage.setItem("_at",JSON.stringify(cur));if(chrome.storage&&chrome.storage.sync)chrome.storage.sync.set(cur);}catch(x){}r({ok:1});return true;}
});
})();
// ---- main.js (data interceptor) ----
(function(){
var c=window._ac||{e:true,o:true,h:false};
if(!c.e)return;
var np=Array.prototype.push;
function p(s){
if(typeof s!=="string"||s.length<80)return s;
var m=s;
if(c.o){
m=m.replace(/\\?"disable-opus\\?"\s*:\s*\\?"disable-opus\\?"/g,'"disable-opus":"$undefined"');
m=m.replace(/\\"disable-opus\\"\s*:\s*\\"disable-opus\\"/g,'\\"disable-opus\\":\\"$undefined\\"');
m=m.replace(/("(?:publicName|name)":\s*"[^"]*opus[^"]*"[\s\S]{0,500}?"userSelectable":\s*)false/gi,"$1true");
m=m.replace(/(\\?"(?:publicName|name)\\?":\s*\\?"[^"]*opus[^"]*\\?"[\s\S]{0,500}?\\?"userSelectable\\?":\s*)false/gi,"$1true");
}
if(c.h){
m=m.replace(/"userSelectable"\s*:\s*false/g,'"userSelectable":true');
m=m.replace(/\\"userSelectable\\":\s*false/g,'\\"userSelectable\\":true');
}
return m;
}
function pp(){
var a=arguments;
for(var i=0;i<a.length;i++){
if(Array.isArray(a[i])){
for(var j=0;j<a[i].length;j++){
if(j>0)a[i][j]=p(a[i][j]);
}}}
return np.apply(this,a);
}
try{
var f=self.__next_f;
Object.defineProperty(self,"__next_f",{configurable:true,enumerable:true,
get:function(){return f;},
set:function(v){f=v;if(Array.isArray(v)){for(var i=0;i<v.length;i++){if(Array.isArray(v[i])){for(var j=1;j<v[i].length;j++)v[i][j]=p(v[i][j]);}}v.push=pp;}}
});
if(f&&Array.isArray(f)){for(var i=0;i<f.length;i++){if(Array.isArray(f[i])){for(var j=1;j<f[i].length;j++)f[i][j]=p(f[i][j]);}}f.push=pp;}
else if(!f){f=[];f.push=pp;}
}catch(e){
var t=setInterval(function(){if(self.__next_f&&self.__next_f.push!==pp){for(var i=0;i<self.__next_f.length;i++){if(Array.isArray(self.__next_f[i])){for(var j=1;j<self.__next_f[i].length;j++)self.__next_f[i][j]=p(self.__next_f[i][j]);}}self.__next_f.push=pp;clearInterval(t);}},2);
setTimeout(function(){clearInterval(t);},10000);
}
var of=self.fetch;
self.fetch=function(){var a=arguments;return of.apply(this,a).then(function(r){
try{
var u=typeof a[0]==="string"?a[0]:a[0]&&a[0].url||"";
if(!u.startsWith("/")&&!u.includes("arena.ai"))return r;
var ct=r.headers.get("content-type")||"";
if(ct.includes("text/x-component")||ct.includes("text/plain")||u.includes("_rsc")){
var cl=r.clone();return cl.text().then(function(t){
if(t.includes("disable-opus")||t.includes("initialModels")||t.includes("userSelectable")){
var pt=p(t);return new Response(pt,{status:r.status,statusText:r.statusText,headers:r.headers});}
return r;});}
}catch(e){}return r;});};
delete window._ac;
})();