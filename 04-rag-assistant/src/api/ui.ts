/** Interfaz de chat con streaming: una sola página sin build (HTML + JS vanilla). */
export function uiHtml(needsToken: boolean, llm: string, embedder: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Docs Assistant</title>
<style>
:root{--bg:#0e1116;--panel:#171b23;--p2:#1e2430;--b:#2a3140;--t:#e8ebf2;--m:#8e97aa;--ac:#6c8cff;--ok:#3ecf8e;--warn:#f5b942;--bad:#ff6b6b;color-scheme:dark}
@media(prefers-color-scheme:light){:root{--bg:#f4f5f9;--panel:#fff;--p2:#eef0f6;--b:#dde1ec;--t:#1b1f2b;--m:#656d82;--ac:#4668e0;color-scheme:light}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--t);height:100vh;display:flex;flex-direction:column}
header{display:flex;justify-content:space-between;align-items:center;padding:.7rem 1.2rem;border-bottom:1px solid var(--b);background:var(--panel);gap:.5rem;flex-wrap:wrap}
h1{font-size:1.05rem;margin:0;color:var(--ac)}h2{font-size:.85rem;margin:0 0 .5rem;color:var(--m);text-transform:uppercase;letter-spacing:.04em}
.tag{font-size:.75rem;color:var(--m);border:1px solid var(--b);border-radius:99px;padding:0 .55rem;margin-left:.3rem}
.layout{flex:1;display:grid;grid-template-columns:270px 1fr;min-height:0}
aside{border-right:1px solid var(--b);background:var(--panel);padding:1rem;overflow:auto}
main{display:flex;flex-direction:column;min-height:0}
#log{flex:1;overflow:auto;padding:1.2rem;display:flex;flex-direction:column;gap:1rem}
.msg{max-width:780px}.me{align-self:flex-end;background:var(--ac);color:#fff;padding:.55rem .85rem;border-radius:14px 14px 3px 14px}
.bot{background:var(--panel);border:1px solid var(--b);border-radius:14px 14px 14px 3px;padding:.8rem 1rem}
.cite{display:inline-block;background:var(--p2);border:1px solid var(--b);color:var(--ac);border-radius:6px;padding:0 .35rem;margin:0 1px;cursor:pointer;font-size:.8rem}
.src{margin-top:.6rem;display:grid;gap:.4rem}.src div{background:var(--p2);border-radius:8px;padding:.4rem .6rem;font-size:.82rem;border-left:3px solid var(--ac)}
.src b{display:block}.src .ex{color:var(--m)}.src .hl{border-left-color:var(--ok);outline:1px solid var(--ok)}
.meta{margin-top:.5rem;font-size:.75rem;color:var(--m)}.warn{color:var(--warn)}.bad{color:var(--bad)}.ok{color:var(--ok)}
form{display:flex;gap:.5rem;padding:.8rem 1.2rem;border-top:1px solid var(--b);background:var(--panel)}
input,textarea,button{font:inherit;border-radius:8px;border:1px solid var(--b);background:var(--p2);color:var(--t);padding:.5rem .75rem}
input,textarea{width:100%}textarea{resize:vertical;min-height:70px}button{cursor:pointer}button.p{background:var(--ac);border-color:var(--ac);color:#fff}button:disabled{opacity:.5}
.doc{display:flex;justify-content:space-between;gap:.4rem;font-size:.85rem;padding:.25rem 0;border-bottom:1px solid var(--b)}.doc small{color:var(--m)}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:.4rem;font-size:.8rem;margin-bottom:1rem}.stats div{background:var(--p2);border-radius:8px;padding:.4rem .6rem}.stats b{display:block;font-size:1rem}
.suggest{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.4rem}.suggest button{font-size:.8rem;padding:.25rem .6rem}
@media(max-width:760px){.layout{grid-template-columns:1fr}aside{display:none}}
</style></head><body>
<header><h1>✦ Docs Assistant</h1><div><span class="tag">llm: ${llm}</span><span class="tag">embeddings: ${embedder}</span>${needsToken ? '<input id="tok" type="password" placeholder="admin token" style="width:9rem;margin-left:.5rem">' : ''}</div></header>
<div class="layout">
<aside>
 <h2>Usage</h2><div class="stats" id="stats"></div>
 <h2>Documents</h2><div id="docs"></div>
 <h2 style="margin-top:1rem">Add document</h2>
 <input id="dtitle" placeholder="Title"><textarea id="dcontent" placeholder="Paste Markdown or text…" style="margin-top:.4rem"></textarea>
 <input type="file" id="dfile" accept=".md,.txt" style="margin-top:.4rem;padding:.3rem">
 <button class="p" style="margin-top:.4rem;width:100%" onclick="addDoc()">Ingest</button><div id="dmsg" class="meta"></div>
</aside>
<main>
 <div id="log"><div class="msg bot">Ask anything about the loaded documents (security, time off, expenses, incidents, API, pricing, SLA, onboarding). Answers cite their sources and the assistant says so when the documents don't cover a question.
  <div class="suggest" id="suggest"></div></div></div>
 <form id="f"><input id="q" placeholder="Ask a question…" maxlength="1000" autocomplete="off"><button class="p" id="send">Ask</button></form>
</main></div>
<script>
const cid=(localStorage.cid=localStorage.cid||('u'+Math.random().toString(36).slice(2,12)));
const H=(json=true)=>{const h={'x-client-id':cid};if(json)h['content-type']='application/json';const t=document.getElementById('tok');if(t&&t.value)h.Authorization='Bearer '+t.value;return h};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const log=document.getElementById('log');let history=[];
['How long must passwords be?','What do I do if my laptop gets stolen?','What is the Enterprise uptime guarantee?','Does Northwind offer a student discount?'].forEach(s=>{const b=document.createElement('button');b.textContent=s;b.type='button';b.onclick=()=>{q.value=s;f.requestSubmit()};suggest.appendChild(b)});
function render(el,text,sources){el.querySelector('.ans').innerHTML=esc(text).replace(/\\[(\\d+(?:\\s*,\\s*\\d+)*)\\]/g,(m,n)=>n.split(',').map(x=>'<span class="cite" data-n="'+x.trim()+'">['+x.trim()+']</span>').join(''))}
f.onsubmit=async e=>{e.preventDefault();const question=q.value.trim();if(!question)return;q.value='';send.disabled=true;
 log.insertAdjacentHTML('beforeend','<div class="msg me">'+esc(question)+'</div>');
 const el=document.createElement('div');el.className='msg bot';el.innerHTML='<div class="ans"></div><div class="src"></div><div class="meta"></div>';log.appendChild(el);log.scrollTop=log.scrollHeight;
 let text='',sources=[];
 try{
  const res=await fetch('/api/chat',{method:'POST',headers:H(),body:JSON.stringify({question,history})});
  if(!res.ok){const j=await res.json().catch(()=>({}));el.querySelector('.ans').innerHTML='<span class="bad">'+esc(j.message||j.error||'Request failed')+'</span>';send.disabled=false;return}
  const reader=res.body.getReader();const dec=new TextDecoder();let buf='';
  while(true){const{done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;
   while((i=buf.indexOf('\\n\\n'))>=0){const raw=buf.slice(0,i);buf=buf.slice(i+2);const ev=/event: (.*)/.exec(raw)?.[1];const data=JSON.parse(/data: (.*)/s.exec(raw)?.[1]||'null');
    if(ev==='sources'){sources=data;el.querySelector('.src').innerHTML=data.map(s=>'<div data-n="'+s.n+'"><b>['+s.n+'] '+esc(s.title)+' <span class="ex">· '+esc(s.section)+'</span></b><span class="ex">'+esc(s.excerpt)+'</span></div>').join('')}
    else if(ev==='token'){text+=data.text;render(el,text)}
    else if(ev==='done'){const r=data;history.push({role:'user',content:question},{role:'assistant',content:r.answer});
      el.querySelector('.meta').innerHTML=(r.cached?'<span class="ok">cache hit</span> · ':'')+(r.refused?'<span class="warn">no supporting documents</span> · ':'')+(!r.grounded?'<span class="bad">ungrounded</span> · ':'')+r.usage.inputTokens+' in / '+r.usage.outputTokens+' out tokens · '+(r.usage.costUsd?'$'+r.usage.costUsd.toFixed(5)+' · ':'')+r.latencyMs.total+' ms'+(r.latencyMs.firstToken!=null?' (first token '+r.latencyMs.firstToken+' ms)':'');
      if(r.refused)el.querySelector('.src').innerHTML='';refresh()}
    else if(ev==='error'){el.querySelector('.ans').innerHTML+=' <span class="bad">'+esc(data.message)+'</span>'}}
   log.scrollTop=log.scrollHeight}
 }catch(err){el.querySelector('.ans').innerHTML='<span class="bad">Connection error</span>'}
 send.disabled=false;q.focus()};
log.onclick=e=>{const n=e.target.dataset?.n;if(!e.target.classList.contains('cite'))return;const box=e.target.closest('.bot').querySelectorAll('.src div');box.forEach(d=>d.classList.toggle('hl',d.dataset.n===n))};
async function refresh(){
 const [d,u]=await Promise.all([fetch('/api/documents').then(r=>r.json()),fetch('/api/usage',{headers:H(false)}).then(r=>r.ok?r.json():null)]);
 docs.innerHTML=(d.items||[]).map(x=>'<div class="doc"><span>'+esc(x.title)+'<br><small>'+x.chunkCount+' chunks</small></span></div>').join('')||'<span class="meta">No documents yet.</span>';
 if(u)stats.innerHTML=[['requests',u.requests],['cache hits',u.cacheHits],['refusals',u.refusals],['p95 ms',u.p95Ms],['tokens',u.inputTokens+u.outputTokens],['cost $',u.costUsd.toFixed(4)]].map(([k,v])=>'<div>'+k+'<b>'+v+'</b></div>').join('')}
async function addDoc(){let content=dcontent.value,title=dtitle.value;const f=dfile.files[0];if(f){content=await f.text();title=title||f.name.replace(/\\.[^.]+$/,'')}
 if(!title||content.length<20){dmsg.textContent='Title and some content required';return}
 const r=await fetch('/api/documents',{method:'POST',headers:H(),body:JSON.stringify({title,content})});const j=await r.json();
 dmsg.textContent=r.ok?(j.status+': '+j.chunks+' chunks'):(j.message||j.error);dtitle.value=dcontent.value='';refresh()}
refresh();
</script></body></html>`;
}
