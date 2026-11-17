/** Dashboard de operación: una sola página sin build (HTML + JS vanilla) servida por la propia API. */
export function dashboardHtml(needsToken: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orderflow</title>
<style>
:root{--bg:#0e1116;--panel:#171b23;--p2:#1e2430;--b:#2a3140;--t:#e8ebf2;--m:#8e97aa;--ac:#6c8cff;--ok:#3ecf8e;--warn:#f5b942;--bad:#ff6b6b;color-scheme:dark}
@media(prefers-color-scheme:light){:root{--bg:#f4f5f9;--panel:#fff;--p2:#eef0f6;--b:#dde1ec;--t:#1b1f2b;--m:#656d82;--ac:#4668e0;color-scheme:light}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--t)}
header{display:flex;justify-content:space-between;align-items:center;padding:.8rem 1.25rem;border-bottom:1px solid var(--b);background:var(--panel);flex-wrap:wrap;gap:.5rem}
h1{font-size:1.1rem;margin:0;color:var(--ac)}h2{font-size:.95rem;margin:0 0 .6rem}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:1rem;padding:1rem 1.25rem}
.card{background:var(--panel);border:1px solid var(--b);border-radius:12px;padding:1rem}.wide{grid-column:1/-1}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid var(--b);font-size:.85rem;vertical-align:top}th{color:var(--m);font-weight:500}
button,input,select{font:inherit;border-radius:8px;border:1px solid var(--b);background:var(--p2);color:var(--t);padding:.35rem .7rem}button{cursor:pointer}button.p{background:var(--ac);border-color:var(--ac);color:#fff}button.d{color:var(--bad)}
.pill{display:inline-block;padding:0 .55rem;border-radius:99px;font-size:.75rem;border:1px solid var(--b)}
.SHIPPED{color:var(--ok)}.CANCELLED,.PAYMENT_FAILED{color:var(--bad)}.PENDING,.RESERVED,.PAID{color:var(--warn)}
.row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.3rem 0}.m{color:var(--m)}code{background:var(--p2);padding:0 .3rem;border-radius:4px;font-size:.8rem}
.bad{color:var(--bad)}.ok{color:var(--ok)}pre{margin:0;white-space:pre-wrap;font-size:.8rem}
</style></head><body>
<header><h1>▤ Orderflow</h1><div class="row"><span class="m">refreshes every 1.5s</span>${needsToken ? '<input id="tok" type="password" placeholder="admin token">' : ''}</div></header>
<main>
 <section class="card"><h2>Place orders</h2>
  <div class="row"><select id="sku"></select><input id="qty" type="number" min="1" value="1" style="width:5rem"><button class="p" onclick="place(1)">Place order</button><button onclick="place(10)">Place 10</button><button onclick="doubleSubmit()">Double-submit (same key)</button></div>
  <div id="placeMsg" class="m"></div></section>
 <section class="card"><h2>Chaos <span class="m">(inject failures)</span></h2>
  <div class="row"><label>Payment timeouts <input id="c_rate" type="range" min="0" max="1" step="0.1" value="0" oninput="chaos()"> <b id="c_rate_v">0</b></label></div>
  <div class="row"><label><input type="checkbox" id="c_decline" onchange="chaos()"> Decline payments above $50</label></div>
  <div class="row"><label><input type="checkbox" id="c_bug" onchange="chaos()"> Deploy a bug in <code>inventory</code></label> <button onclick="replayAll()">Replay all dead letters</button></div></section>
 <section class="card wide"><h2>Queues (per consumer group)</h2><table id="queues"></table></section>
 <section class="card wide"><h2>Dead-letter queue</h2><table id="dlq"></table></section>
 <section class="card"><h2>Stock</h2><table id="stock"></table></section>
 <section class="card"><h2>Orders <span class="m">(read model, eventually consistent)</span></h2><table id="orders"></table><pre id="tl" class="m"></pre></section>
</main>
<script>
const H=()=>{const t=document.getElementById('tok');return t&&t.value?{Authorization:'Bearer '+t.value}:{}};
const j=async(u,o={})=>{const h={...H(),...(o.headers||{})};if(o.body)h['content-type']='application/json';const r=await fetch(u,{...o,headers:h});return r.json().catch(()=>({}))};
let lastKey=null;
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function place(n){let ok=0;for(let i=0;i<n;i++){const r=await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({customerId:'user'+Math.floor(Math.random()*90+10)+'@example.com',items:[{sku:sku.value,qty:+qty.value||1,priceCents:Math.floor(Math.random()*9000)+1000}]})});if(r.ok)ok++}placeMsg.textContent=ok+' order(s) accepted';refresh()}
async function doubleSubmit(){const key=crypto.randomUUID();const body=JSON.stringify({customerId:'dup@example.com',items:[{sku:sku.value,qty:1,priceCents:2500}]});const send=()=>fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':key},body}).then(async r=>[r.status,(await r.json()).id]);const [a,b]=await Promise.all([send(),send()]);placeMsg.innerHTML='Two requests, same key → <code>'+a[0]+'</code> and <code>'+b[0]+'</code>; same order id: <b>'+(a[1]===b[1])+'</b>';refresh()}
async function chaos(){c_rate_v.textContent=c_rate.value;await j('/api/admin/chaos',{method:'PUT',body:JSON.stringify({paymentTransientRate:+c_rate.value,paymentDeclineAboveCents:c_decline.checked?5000:null,inventoryBug:c_bug.checked})})}
async function replay(id){await j('/api/admin/dlq/'+id+'/replay',{method:'POST'});refresh()}
async function replayAll(){c_bug.checked=false;await chaos();const r=await j('/api/admin/dlq/replay-all',{method:'POST'});placeMsg.textContent='replayed '+(r.replayed||0)+' dead letter(s)';refresh()}
async function showTl(id){const t=await j('/api/orders/'+id+'/timeline');tl.textContent=id.slice(0,8)+':\\n'+t.events.map(e=>'  '+new Date(e.at).toLocaleTimeString()+'  '+e.type).join('\\n')}
async function refresh(){
 const [q,d,s,o,c]=await Promise.all([j('/api/admin/queues'),j('/api/admin/dlq'),j('/api/admin/stock'),j('/api/orders'),j('/api/admin/chaos')]);
 if(!sku.options.length&&s.items)s.items.forEach(i=>sku.add(new Option(i.sku,i.sku)));
 queues.innerHTML='<tr><th>consumer</th><th>ready</th><th>waiting (backoff)</th><th>processing</th><th>done</th><th>dead</th><th>lag</th></tr>'+(q.queues||[]).map(x=>'<tr><td>'+x.consumer+'</td><td>'+x.ready+'</td><td>'+(x.pending-x.ready)+'</td><td>'+x.processing+'</td><td class=ok>'+x.done+'</td><td class="'+(x.dead?'bad':'')+'">'+x.dead+'</td><td>'+x.oldestReadyAgeSec+'s</td></tr>').join('');
 dlq.innerHTML=(d.items&&d.items.length)?'<tr><th>id</th><th>consumer</th><th>topic</th><th>attempts</th><th>error</th><th></th></tr>'+d.items.map(x=>'<tr><td>'+x.id+'</td><td>'+x.consumer+'</td><td>'+x.topic+'</td><td>'+x.attempts+'</td><td class=bad>'+esc(x.last_error)+'</td><td><button onclick="replay('+x.id+')">Replay</button></td></tr>').join(''):'<tr><td class=m>Empty. Turn on "Deploy a bug", place orders, and watch them land here.</td></tr>';
 stock.innerHTML='<tr><th>sku</th><th>available</th><th>reserved</th></tr>'+(s.items||[]).map(x=>'<tr><td>'+x.sku+'</td><td>'+x.available+'</td><td>'+x.reserved+'</td></tr>').join('');
 orders.innerHTML='<tr><th>id</th><th>status</th><th>total</th><th></th></tr>'+(o.items||[]).slice(0,12).map(x=>'<tr><td><code>'+x.id.slice(0,8)+'</code></td><td><span class="pill '+x.status+'">'+x.status+'</span></td><td>$'+(x.totalCents/100).toFixed(2)+'</td><td><button onclick="showTl(\\''+x.id+'\\')">timeline</button></td></tr>').join('');
 if(c&&document.activeElement.id!=='c_rate'){c_rate.value=c.paymentTransientRate;c_rate_v.textContent=c.paymentTransientRate;c_decline.checked=c.paymentDeclineAboveCents!==null;c_bug.checked=c.inventoryBug}
}
refresh();setInterval(refresh,1500);
</script></body></html>`;
}
