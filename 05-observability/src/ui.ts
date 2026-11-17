/** Dashboard: una sola página sin build ni librerías; los gráficos se dibujan a mano sobre <canvas>. */
export function uiHtml(needsKey: boolean, simulate: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pulse</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--p2:#1c232d;--b:#2a3340;--t:#e6edf3;--m:#8b98a9;--ac:#58a6ff;--ok:#3fb950;--warn:#d29922;--bad:#f85149;color-scheme:dark}
@media(prefers-color-scheme:light){:root{--bg:#f3f5f8;--panel:#fff;--p2:#eef1f6;--b:#d8dee8;--t:#1b2330;--m:#5f6c7e;--ac:#0969da;color-scheme:light}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--t)}
header{display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap;padding:.7rem 1.1rem;border-bottom:1px solid var(--b);background:var(--panel);position:sticky;top:0;z-index:5}
h1{font-size:1.05rem;margin:0;color:var(--ac)}h2{font-size:.78rem;margin:0 0 .5rem;color:var(--m);text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));gap:.9rem;padding:.9rem 1.1rem}
.card{background:var(--panel);border:1px solid var(--b);border-radius:10px;padding:.8rem .9rem;min-width:0}.wide{grid-column:1/-1}
canvas{width:100%;height:190px;display:block}
select,input,button{font:inherit;background:var(--p2);color:var(--t);border:1px solid var(--b);border-radius:7px;padding:.3rem .6rem}button{cursor:pointer}button.p{background:var(--ac);border-color:var(--ac);color:#fff}button.d{color:var(--bad)}
.legend{display:flex;gap:.8rem;flex-wrap:wrap;font-size:.78rem;color:var(--m);margin-top:.3rem}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:.3rem;vertical-align:-1px}
table{width:100%;border-collapse:collapse;font-size:.84rem}th,td{text-align:left;padding:.3rem .45rem;border-bottom:1px solid var(--b)}th{color:var(--m);font-weight:500}
.pill{display:inline-block;padding:0 .5rem;border-radius:99px;font-size:.74rem;border:1px solid var(--b)}.firing{color:var(--bad);border-color:var(--bad)}.pending{color:var(--warn);border-color:var(--warn)}.up{color:var(--ok)}.down{color:var(--bad)}
.m{color:var(--m)}.tip{position:fixed;pointer-events:none;background:var(--p2);border:1px solid var(--b);border-radius:7px;padding:.3rem .5rem;font-size:.78rem;display:none;z-index:9}
.stats{display:flex;gap:.5rem;flex-wrap:wrap}.stats div{background:var(--p2);border-radius:8px;padding:.3rem .6rem;font-size:.78rem}.stats b{display:block;font-size:.95rem}
.banner{background:color-mix(in srgb,var(--bad) 16%,transparent);border-bottom:1px solid var(--bad);padding:.45rem 1.1rem;display:none}
</style></head><body>
<header><h1>◉ Pulse</h1>
<div class="row">
 <select id="range"><option value="900">Last 15 min</option><option value="3600" selected>Last hour</option><option value="21600">Last 6 h</option><option value="86400">Last 24 h</option><option value="604800">Last 7 d</option></select>
 <label class="m"><input type="checkbox" id="auto" checked> auto-refresh</label>
 ${simulate ? '<button id="inc" onclick="toggleIncident()">Trigger incident</button>' : ''}
 ${needsKey ? '<input id="key" type="password" placeholder="API key" style="width:9rem">' : ''}
</div></header>
<div class="banner" id="banner"></div>
<main>
 <section class="card"><h2>Requests / s · by service</h2><canvas id="c1"></canvas><div class="legend" id="l1"></div></section>
 <section class="card"><h2>p99 latency (ms) · by service</h2><canvas id="c2"></canvas><div class="legend" id="l2"></div></section>
 <section class="card"><h2>5xx errors / s · by service</h2><canvas id="c3"></canvas><div class="legend" id="l3"></div></section>
 <section class="card"><h2>CPU % · by host</h2><canvas id="c4"></canvas><div class="legend" id="l4"></div></section>
 <section class="card wide"><h2>Alerts <span class="m" id="alertcount"></span></h2><table id="alerts"></table></section>
 <section class="card"><h2>Uptime monitors</h2><table id="monitors"></table>
  <div class="row" style="margin-top:.5rem"><input id="mname" placeholder="name" style="width:7rem"><input id="murl" placeholder="https://…" style="flex:1;min-width:8rem"><button class="p" onclick="addMonitor()">Add</button></div><div class="m" id="mmsg"></div></section>
 <section class="card"><h2>Alert history</h2><table id="events"></table></section>
 <section class="card wide"><h2>Pipeline health <span class="m">(Pulse monitors itself with its own pipeline)</span></h2><div class="stats" id="stats"></div></section>
</main><div class="tip" id="tip"></div>
<script>
const COLORS=['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#39c5cf','#ff7b72','#79c0ff'];
const key=()=>document.getElementById('key')?.value||'';
const H=()=>key()?{Authorization:'Bearer '+key()}:{};
const j=async(u,o={})=>{const r=await fetch(u,{...o,headers:{...H(),...(o.body?{'content-type':'application/json'}:{})}});const b=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(b.message||b.error||r.statusText),{status:r.status});return b};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>v==null?'–':Math.abs(v)>=1000?(v/1000).toFixed(1)+'k':Math.abs(v)>=10?v.toFixed(0):v.toFixed(2);
const label=l=>Object.values(l).join(' / ')||'all';
const charts={};
function draw(id,res,unit){
 const cv=document.getElementById(id),dpr=devicePixelRatio||1,w=cv.clientWidth,h=cv.clientHeight;cv.width=w*dpr;cv.height=h*dpr;
 const g=cv.getContext('2d');g.scale(dpr,dpr);g.clearRect(0,0,w,h);
 const css=getComputedStyle(document.documentElement),m=css.getPropertyValue('--m').trim(),bd=css.getPropertyValue('--b').trim();
 const L=40,R=8,T=8,B=20,S=res.series;charts[id]={res,L,R,T,B,w,h,unit};
 if(!S.length){g.fillStyle=m;g.fillText('no data in this range',L+10,h/2);return}
 let ymax=0;S.forEach(s=>s.points.forEach(p=>ymax=Math.max(ymax,p[1])));ymax=ymax*1.1||1;
 const x=t=>L+(t-res.from)/(res.to-res.from)*(w-L-R),y=v=>T+(1-v/ymax)*(h-T-B);
 g.font='11px system-ui';g.strokeStyle=bd;g.fillStyle=m;g.lineWidth=1;
 for(let i=0;i<=4;i++){const v=ymax*i/4,yy=y(v);g.beginPath();g.moveTo(L,yy);g.lineTo(w-R,yy);g.stroke();g.fillText(fmt(v),2,yy+3)}
 for(let i=0;i<=4;i++){const t=res.from+(res.to-res.from)*i/4;g.fillText(new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),x(t)-14,h-4)}
 S.forEach((s,i)=>{g.strokeStyle=COLORS[i%COLORS.length];g.lineWidth=1.6;g.beginPath();let pen=false,prev=0;
  s.points.forEach(p=>{if(pen&&p[0]-prev>res.stepSec*1000*2.5)pen=false;(pen?g.lineTo:g.moveTo).call(g,x(p[0]),y(p[1]));pen=true;prev=p[0]});g.stroke()});
 document.getElementById('l'+id.slice(1)).innerHTML=S.map((s,i)=>'<span><i style="background:'+COLORS[i%COLORS.length]+'"></i>'+esc(label(s.labels))+'</span>').join('')+'<span>· resolution '+res.tier+', step '+res.stepSec+'s</span>';
}
document.addEventListener('mousemove',e=>{const cv=e.target;const c=charts[cv.id];const tip=document.getElementById('tip');if(!c){tip.style.display='none';return}
 const r=cv.getBoundingClientRect(),t=c.res.from+(e.clientX-r.left-c.L)/(c.w-c.L-c.R)*(c.res.to-c.res.from);if(t<c.res.from||t>c.res.to){tip.style.display='none';return}
 const rows=c.res.series.map((s,i)=>{let best=null;s.points.forEach(p=>{if(!best||Math.abs(p[0]-t)<Math.abs(best[0]-t))best=p});return best&&Math.abs(best[0]-t)<c.res.stepSec*1500?'<div><i style="display:inline-block;width:8px;height:8px;background:'+COLORS[i%COLORS.length]+'"></i> '+esc(label(s.labels))+': <b>'+fmt(best[1])+'</b></div>':''}).join('');
 tip.innerHTML='<div class="m">'+new Date(t).toLocaleTimeString()+'</div>'+rows;tip.style.display='block';tip.style.left=Math.min(e.clientX+12,innerWidth-200)+'px';tip.style.top=(e.clientY+12)+'px'});
const q=(metric,agg,extra='')=>j('/v1/query?metric='+metric+'&agg='+agg+'&range='+range.value+extra);
async function refresh(){
 try{
  const [a,b,c,d]=await Promise.all([q('http_requests_total','rate','&groupBy=service'),q('http_request_duration_ms','p99','&groupBy=service'),q('http_requests_total','rate','&groupBy=service&f.status=5xx'),q('cpu_usage_percent','avg','&groupBy=host')]);
  draw('c1',a);draw('c2',b);draw('c3',c);draw('c4',d);
  const [al,ev,mo,st]=await Promise.all([j('/v1/alerts'),j('/v1/alerts/events?limit=12'),j('/v1/monitors'),j('/v1/stats')]);
  const act=al.alerts;alertcount.textContent='· '+act.filter(x=>x.state==='firing').length+' firing, '+act.filter(x=>x.state==='pending').length+' pending';
  alerts.innerHTML=act.length?'<tr><th>state</th><th>rule</th><th>group</th><th>value</th><th>since</th></tr>'+act.map(x=>'<tr><td><span class="pill '+x.state+'">'+x.state+'</span></td><td>'+esc(x.ruleName)+' <span class="m">('+x.severity+')</span></td><td>'+esc(label(x.labels))+'</td><td>'+fmt(x.value)+'</td><td class="m">'+new Date(x.since).toLocaleTimeString()+'</td></tr>').join(''):'<tr><td class="up">✓ All clear</td></tr>';
  const firing=act.filter(x=>x.state==='firing');banner.style.display=firing.length?'block':'none';banner.textContent=firing.length?'🔥 '+firing.length+' alert(s) firing: '+firing.map(x=>x.ruleName+' ['+label(x.labels)+']').join(', '):'';
  events.innerHTML=ev.events.length?ev.events.map(e=>'<tr><td class="m">'+new Date(e.ts).toLocaleTimeString()+'</td><td>'+esc(e.ruleName)+' <span class="m">'+esc(label(e.labels))+'</span></td><td><span class="pill '+(e.to==='firing'?'firing':'up')+'">'+(e.to==='ok'?'resolved':e.to)+'</span></td></tr>').join(''):'<tr><td class="m">No alert events yet.</td></tr>';
  monitors.innerHTML=mo.monitors.length?'<tr><th>monitor</th><th>status</th><th>latency</th><th></th></tr>'+mo.monitors.map(m=>'<tr><td>'+esc(m.name)+'<br><span class="m">'+esc(m.url)+'</span></td><td>'+(m.last?'<span class="'+(m.last.ok?'up':'down')+'">'+(m.last.ok?'● up':'● down')+'</span>'+(m.last.error?'<br><span class="m">'+esc(m.last.error)+'</span>':''):'<span class="m">pending…</span>')+'</td><td>'+(m.last?m.last.latencyMs+' ms':'')+'</td><td><button class="d" onclick="delMonitor(\\''+m.id+'\\')">×</button></td></tr>').join(''):'<tr><td class="m">No monitors yet. Add a public URL below.</td></tr>';
  const s=st.ingest;stats.innerHTML=[['series',st.storage.series],['accepted',s.accepted],['rejected (invalid)',s.rejectedInvalid],['rejected (cardinality)',s.rejectedCardinality],['shed (overload)',s.rejectedShed],['pending buckets',s.pendingKeys],['last flush',s.lastFlushMs+' ms'],['10s rows',st.storage.buckets_10s],['1m rows',st.storage.buckets_1m],['1h rows',st.storage.buckets_1h]].map(([k,v])=>'<div>'+k+'<b>'+v+'</b></div>').join('');
  if(window.toggleIncident)document.getElementById('inc').textContent=st.simulate?.incident?'Resolve incident':'Trigger incident';
 }catch(e){banner.style.display='block';banner.textContent=e.message}
}
async function toggleIncident(){const st=await j('/v1/stats');await j('/v1/demo/incident',{method:'POST',body:JSON.stringify({active:!st.simulate.incident})});refresh()}
async function addMonitor(){try{await j('/v1/monitors',{method:'POST',body:JSON.stringify({name:mname.value,url:murl.value,intervalSec:15})});mmsg.textContent='';mname.value=murl.value='';setTimeout(refresh,1500)}catch(e){mmsg.textContent=e.message}}
async function delMonitor(id){await j('/v1/monitors/'+id,{method:'DELETE'});refresh()}
range.onchange=refresh;refresh();setInterval(()=>{if(auto.checked)refresh()},5000);addEventListener('resize',refresh);
</script></body></html>`;
}
