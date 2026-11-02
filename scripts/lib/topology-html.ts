// TOPOLOGY.html: the map stage's topology.json as one self-contained interactive
// page (no CDN, works offline). Written after merge-topology, then again at report
// time with verified findings and architecture dispositions overlaid per module.
// Repository-derived text only ever enters the page as JSON inside a
// <script type="application/json"> block ("<" escaped), and the page script builds
// the DOM with textContent — never innerHTML — so repository text cannot inject markup.
import { join } from "node:path";
import type { Finding } from "./types.ts";
import { redact } from "./redact.ts";
import { SEV_RANK } from "./types.ts";
import { writeText } from "./util.ts";

type Obj = Record<string, any>;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export interface TopologyNode {
  id: string; type: "module" | "store" | "external" | "other";
  path?: string; kind?: string; lines?: number; description?: string; disposition?: string; rationale?: string;
  counts: Record<string, number>; worst?: string;
  findings: { id: string; severity: string; dimension: string; title: string; file: string; line: number; verdict?: string }[];
  entries: { name: string; kind?: string; file: string; line: number }[];
}

export interface TopologyData {
  name: string; generated: "map" | "report";
  nodes: TopologyNode[];
  edges: { from: string; to: string; type: string; evidence: string }[];
  flows: { name: string; steps: string[]; evidence: string[] }[];
  stores: { name: string; kind?: string; evidence: string }[];
  externals: { name: string; kind?: string; evidence: string }[];
  dead_ends: { name: string; reason?: string; evidence?: string }[];
  observations: string[];
}

/** The module owning a file: longest matching path; "." owns everything left. */
function ownerOf(mods: Obj[]): (file: string) => string | undefined {
  const roots = mods.map((m) => ({ name: m.name, root: m.path.replace(/\/+$/, "") })).sort((a, b) => b.root.length - a.root.length);
  return (file) => roots.find((r) => r.root === "." || r.root === "" || file === r.root || file.startsWith(r.root + "/"))?.name;
}

export function topologyData(t: Obj, opts: { name: string; findings?: Finding[]; architecture?: Obj | null }): TopologyData {
  const mods: Obj[] = arr(t.modules).filter((m) => str(m.name)).map((m) => ({ ...m, name: str(m.name), path: str(m.path) }));
  const owner = ownerOf(mods);
  const disp = new Map(arr(opts.architecture?.dispositions).map((d) => [str(d.module), d]));
  const nodes = new Map<string, TopologyNode>();
  for (const m of mods) {
    if (nodes.has(m.name)) continue;
    const d = disp.get(m.name);
    nodes.set(m.name, {
      id: m.name, type: "module", path: m.path, kind: str(m.kind) || undefined, description: str(m.description) || undefined,
      lines: typeof m.lines === "number" && Number.isFinite(m.lines) ? m.lines : undefined,
      disposition: d ? str(d.disposition) : undefined, rationale: d ? str(d.rationale) || undefined : undefined,
      counts: {}, findings: [], entries: [],
    });
  }
  // Refuted findings are not problems; everything else (confirmed, needs-human, pending) is shown with its verdict.
  for (const f of (opts.findings ?? []).filter((x) => x.verdict !== "refuted" && !x.accepted)) {
    const n = nodes.get(owner(f.file) ?? "");
    if (!n) continue;
    n.counts[f.severity] = (n.counts[f.severity] ?? 0) + 1;
    if (!n.worst || SEV_RANK[f.severity] < SEV_RANK[n.worst as Finding["severity"]]) n.worst = f.severity;
    n.findings.push({ id: f.id, severity: f.severity, dimension: f.dimension, title: f.title, file: f.file, line: f.line, ...(f.verdict ? { verdict: f.verdict } : {}) });
  }
  for (const n of nodes.values()) {
    n.findings.sort((a, b) => SEV_RANK[a.severity as Finding["severity"]] - SEV_RANK[b.severity as Finding["severity"]] || a.id.localeCompare(b.id));
    n.findings = n.findings.slice(0, 12);
  }
  for (const e of arr(t.entry_points)) {
    const n = nodes.get(owner(str(e.file)) ?? "");
    if (n) n.entries.push({ name: str(e.name), kind: str(e.kind) || undefined, file: str(e.file), line: Number(e.line) || 0 });
  }
  const stores = arr(t.data_stores).map((s) => ({ name: str(s.name), kind: str(s.kind) || undefined, evidence: str(s.evidence) }));
  const externals = arr(t.externals).map((s) => ({ name: str(s.name), kind: str(s.kind) || undefined, evidence: str(s.evidence) }));
  const edges = arr(t.edges).map((e) => ({ from: str(e.from), to: str(e.to), type: str(e.type), evidence: str(e.evidence) })).filter((e) => e.from && e.to && e.from !== e.to);
  // An edge may point at a data store or external system rather than a module: give it a node.
  const storeNames = new Set(stores.map((s) => s.name)), extNames = new Set(externals.map((s) => s.name));
  for (const e of edges) for (const id of [e.from, e.to]) {
    if (nodes.has(id)) continue;
    const s = stores.find((x) => x.name === id) ?? externals.find((x) => x.name === id);
    nodes.set(id, { id, type: storeNames.has(id) ? "store" : extNames.has(id) ? "external" : "other", kind: s?.kind, description: s?.evidence ? `Cited at ${s.evidence}` : undefined, counts: {}, findings: [], entries: [] });
  }
  return {
    name: opts.name, generated: opts.findings ? "report" : "map",
    nodes: [...nodes.values()], edges,
    flows: arr(t.flows).map((f) => ({ name: str(f.name), steps: (Array.isArray(f.steps) ? f.steps : []).map(str), evidence: (Array.isArray(f.evidence) ? f.evidence : []).map(str) })),
    stores, externals,
    dead_ends: arr(t.dead_ends).map((d) => ({ name: str(d.name), reason: str(d.reason) || undefined, evidence: str(d.evidence) || undefined })),
    observations: (Array.isArray(t.observations) ? t.observations : []).map(str),
  };
}

const CSS = `
:root{--bg:#fbfaf8;--fg:#1d1d1b;--muted:#6b6a66;--card:#ffffff;--line:#e3e1dc;--accent:#b4532a;--crit:#b42318;--high:#c4520f;--med:#a37a00;--low:#4a6fa5;--edge:#9a978f;
--e-call:#3b6fd4;--e-dispatch:#7a4cc2;--e-read:#2f8a6a;--e-write:#c2410c;--e-import:#8a8780;--e-http:#0e7c9b;--e-event:#b7317a;
--k0:#3b6fd4;--k1:#2f8a6a;--k2:#7a4cc2;--k3:#0e7c9b;--k4:#5f7fa8;--k5:#3f8f3a;--k6:#6b5a3e;--k7:#7b8794;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#171716;--fg:#e8e6e1;--muted:#a3a19b;--card:#211f1d;--line:#36332f;--accent:#e08a5c;--crit:#f97066;--high:#f79009;--med:#eaaa08;--low:#84adff;--edge:#6e6b65;
--e-call:#7aa2f7;--e-dispatch:#b392f0;--e-read:#5fd0a5;--e-write:#fb923c;--e-import:#a3a19b;--e-http:#4fc3dc;--e-event:#f472b6;
--k0:#7aa2f7;--k1:#5fd0a5;--k2:#b392f0;--k3:#4fc3dc;--k4:#9db4d6;--k5:#8bd17c;--k6:#c2ad8a;--k7:#9aa8b5;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#171716;--fg:#e8e6e1;--muted:#a3a19b;--card:#211f1d;--line:#36332f;--accent:#e08a5c;--crit:#f97066;--high:#f79009;--med:#eaaa08;--low:#84adff;--edge:#6e6b65;
--e-call:#7aa2f7;--e-dispatch:#b392f0;--e-read:#5fd0a5;--e-write:#fb923c;--e-import:#a3a19b;--e-http:#4fc3dc;--e-event:#f472b6;
--k0:#7aa2f7;--k1:#5fd0a5;--k2:#b392f0;--k3:#4fc3dc;--k4:#9db4d6;--k5:#8bd17c;--k6:#c2ad8a;--k7:#9aa8b5;color-scheme:dark}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;display:flex;flex-direction:column}
header{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:10px 16px;border-bottom:1px solid var(--line)}
header h1{font-size:1.05rem;margin:0}header .muted{font-size:.85rem}
input[type=search]{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:.3rem .5rem;min-width:180px}
button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:.3rem .6rem;cursor:pointer;font:inherit}button:hover{border-color:var(--accent)}
.legend{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:.82rem}.legend label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.sw{display:inline-block;width:14px;height:3px;border-radius:2px}
.layout{flex:1;display:flex;min-height:0}#canvas{flex:1;position:relative;min-width:0}
svg{width:100%;height:100%;display:block;touch-action:none;cursor:grab}svg.panning{cursor:grabbing}
aside{width:360px;max-width:100%;border-left:1px solid var(--line);overflow-y:auto;padding:12px 16px 32px;background:var(--bg)}
aside h2{font-size:1rem;margin:.2rem 0 .4rem;overflow-wrap:anywhere}aside h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:1rem 0 .3rem}
aside ul{list-style:none;margin:0;padding:0}aside li{padding:.25rem 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
aside li button{all:unset;cursor:pointer;color:var(--fg)}aside li button:hover,aside li button:focus-visible{color:var(--accent);text-decoration:underline}
code{color:var(--accent);font-size:.85em;overflow-wrap:anywhere}.muted{color:var(--muted)}
.chip{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 .45rem;font-size:.75rem;margin:0 .25rem .25rem 0}
.sev-Blocker,.sev-Critical{color:var(--crit)}.sev-High{color:var(--high)}.sev-Medium{color:var(--med)}.sev-Low,.sev-Nit{color:var(--low)}
.node circle.body{stroke:var(--bg);stroke-width:1.5}.node text{font-size:var(--fs,11px);fill:var(--fg);paint-order:stroke;stroke:var(--bg);stroke-width:3px;stroke-linejoin:round;pointer-events:none}
.node{cursor:pointer}.node:focus{outline:none}.node:focus-visible circle.body,.node.sel circle.body{stroke:var(--fg);stroke-width:3}
.node.match circle.body{stroke:var(--accent);stroke-width:3}
.edge{fill:none;stroke-width:1.4;opacity:.75;vector-effect:non-scaling-stroke}.node circle{vector-effect:non-scaling-stroke}.edge.hit{stroke-width:2.6;opacity:1}.edge-hit{fill:none;stroke:transparent;stroke-width:10;cursor:pointer}
.dim{opacity:.12}.hidden{display:none}
.empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted)}
@media (max-width:760px){.layout{flex-direction:column}#canvas{min-height:55vh}aside{width:auto;border-left:0;border-top:1px solid var(--line)}}
`;

const EDGE_TYPES = ["call", "dispatch", "read", "write", "import", "http", "event"];

// Plain ES5 so it runs anywhere the report opens; no external code.
const JS = `
(function(){
var D=JSON.parse(document.getElementById('topo-data').textContent);
var NS='http://www.w3.org/2000/svg',SEV=['Blocker','Critical','High','Medium','Low','Nit'];
var svg=document.getElementById('graph'),vp=document.getElementById('vp'),gE=document.getElementById('edges'),gN=document.getElementById('nodes'),panel=document.getElementById('panel');
function h(tag,attrs,text){var e=document.createElement(tag);if(attrs)for(var k in attrs)e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=String(text);return e}
function s(tag,attrs){var e=document.createElementNS(NS,tag);for(var k in attrs)e.setAttribute(k,attrs[k]);return e}
function add(p){for(var i=1;i<arguments.length;i++){var c=arguments[i];if(c!=null)p.appendChild(typeof c==='string'?document.createTextNode(c):c)}return p}
var kinds={},kn=0;function kindColor(n){if(n.type==='store')return 'var(--k6)';if(n.type==='external'||n.type==='other')return 'var(--k7)';var k=n.kind||'module';if(!(k in kinds))kinds[k]=kn++%6;return 'var(--k'+kinds[k]+')'}
var nodes=D.nodes,byId={},N=nodes.length,R=Math.max(120,28*Math.sqrt(N)*2);
nodes.forEach(function(n,i){byId[n.id]=n;var a=2*Math.PI*i/Math.max(1,N);n.x=Math.cos(a)*R;n.y=Math.sin(a)*R;n.vx=0;n.vy=0;
  n.r=n.type==='module'?Math.max(7,Math.min(26,4+Math.sqrt(n.lines||100)/3)):7;n.out=[];n.inc=[]});
var edges=D.edges.filter(function(e){return byId[e.from]&&byId[e.to]});
var pair={};edges.forEach(function(e){var k=e.from<e.to?e.from+'\\u0000'+e.to:e.to+'\\u0000'+e.from;e.k=(pair[k]=(pair[k]||0)+1)-1;byId[e.from].out.push(e);byId[e.to].inc.push(e)});
// Deterministic force layout: repulsion, springs along edges, gentle gravity.
function tick(al){var i,j,a,b,dx,dy,d2,d,f;
  for(i=0;i<N;i++){a=nodes[i];for(j=i+1;j<N;j++){b=nodes[j];dx=a.x-b.x;dy=a.y-b.y;d2=dx*dx+dy*dy;if(d2<1){dx=(i-j)*.01+.01;dy=.01;d2=1}
    if(d2>360000)continue;f=2200*al/d2;a.vx+=dx*f;a.vy+=dy*f;b.vx-=dx*f;b.vy-=dy*f}}
  edges.forEach(function(e){a=byId[e.from];b=byId[e.to];dx=b.x-a.x;dy=b.y-a.y;d=Math.sqrt(dx*dx+dy*dy)||1;f=(d-(55+a.r+b.r))*.05*al/d;a.vx+=dx*f;a.vy+=dy*f;b.vx-=dx*f;b.vy-=dy*f});
  nodes.forEach(function(n){n.vx-=n.x*.004*al;n.vy-=n.y*.004*al;if(n.fixed){n.vx=n.vy=0;return}n.x+=n.vx;n.y+=n.vy;n.vx*=.6;n.vy*=.6})}
for(var t=0;t<450;t++)tick(1-t/470);
// Draw.
var defs=s('defs',{});svg.insertBefore(defs,vp);
${JSON.stringify(EDGE_TYPES)}.concat(['other']).forEach(function(t){var m=s('marker',{id:'arr-'+t,viewBox:'0 0 10 10',refX:'9',refY:'5',markerWidth:'7',markerHeight:'7',orient:'auto-start-reverse'});
  var p=s('path',{d:'M0,0L10,5L0,10z'});p.style.fill='var(--e-'+t+', var(--edge))';m.appendChild(p);defs.appendChild(m)});
edges.forEach(function(e){var t=${JSON.stringify(EDGE_TYPES)}.indexOf(e.type)>=0?e.type:'other';
  e.el=s('path',{'class':'edge','marker-end':'url(#arr-'+t+')'});e.el.style.stroke='var(--e-'+t+', var(--edge))';
  e.hit=s('path',{'class':'edge-hit'});var ti=s('title',{});ti.textContent=e.from+' \\u2192 '+e.to+' ('+e.type+') '+e.evidence;e.hit.appendChild(ti);
  e.hit.addEventListener('click',function(ev){ev.stopPropagation();showEdge(e)});gE.appendChild(e.el);gE.appendChild(e.hit)});
nodes.forEach(function(n){var g=s('g',{'class':'node',tabindex:'0',role:'button'});g.setAttribute('aria-label',n.id);
  if(n.worst){var ring=s('circle',{r:n.r+4,fill:'none','stroke-width':'3'});ring.style.stroke='var(--'+({Blocker:'crit',Critical:'crit',High:'high',Medium:'med'}[n.worst]||'low')+')';g.appendChild(ring)}
  var c=s('circle',{'class':'body',r:n.r});c.style.fill=kindColor(n);g.appendChild(c);
  if(n.type!=='module'){var sq=s('rect',{x:-n.r/2,y:-n.r/2,width:n.r,height:n.r,rx:n.type==='store'?1:n.r/2});sq.style.fill='var(--bg)';g.appendChild(sq)}
  var lb=s('text',{y:n.r+13,'text-anchor':'middle'});n.lb=lb;lb.textContent=n.id.length>28?n.id.slice(0,27)+'\\u2026':n.id;g.appendChild(lb);
  var ti=s('title',{});ti.textContent=n.id+(n.path?' \\u2014 '+n.path:'');g.appendChild(ti);
  g.addEventListener('click',function(ev){ev.stopPropagation();if(!moved)select(n)});
  g.addEventListener('keydown',function(ev){if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();select(n)}});
  g.addEventListener('pointerdown',function(ev){ev.stopPropagation();drag={n:n,x:ev.clientX,y:ev.clientY};moved=false;g.setPointerCapture(ev.pointerId)});
  n.g=g;gN.appendChild(g)});
function place(){edges.forEach(function(e){var a=byId[e.from],b=byId[e.to],dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1,ux=dx/d,uy=dy/d;
    var sx=a.x+ux*a.r,sy=a.y+uy*a.r,ex=b.x-ux*(b.r+3),ey=b.y-uy*(b.r+3),bend=(e.k%2?1:-1)*Math.ceil(e.k/2)*18,mx=(sx+ex)/2-uy*bend,my=(sy+ey)/2+ux*bend;
    var dd='M'+sx.toFixed(1)+','+sy.toFixed(1)+'Q'+mx.toFixed(1)+','+my.toFixed(1)+' '+ex.toFixed(1)+','+ey.toFixed(1);e.el.setAttribute('d',dd);e.hit.setAttribute('d',dd)});
  nodes.forEach(function(n){n.g.setAttribute('transform','translate('+n.x.toFixed(1)+','+n.y.toFixed(1)+')')})}
place();
// Zoom and pan.
var tf={x:0,y:0,k:1},drag=null,pan=null,moved=false;
function apply(){vp.setAttribute('transform','translate('+tf.x+','+tf.y+') scale('+tf.k+')');svg.style.setProperty('--fs',(11/tf.k).toFixed(2)+'px');nodes.forEach(function(n){n.lb.setAttribute('y',(n.r+13/tf.k).toFixed(1))})}
function fit(){if(!N)return;var r=svg.getBoundingClientRect(),x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;nodes.forEach(function(n){x0=Math.min(x0,n.x-n.r);y0=Math.min(y0,n.y-n.r);x1=Math.max(x1,n.x+n.r);y1=Math.max(y1,n.y+n.r+16)});
  var k=Math.min(2,.92*Math.min(r.width/Math.max(1,x1-x0),r.height/Math.max(1,y1-y0)));tf={k:k,x:r.width/2-k*(x0+x1)/2,y:r.height/2-k*(y0+y1)/2};apply()}
function pt(ev){var r=svg.getBoundingClientRect();return{x:(ev.clientX-r.left-tf.x)/tf.k,y:(ev.clientY-r.top-tf.y)/tf.k}}
svg.addEventListener('wheel',function(ev){ev.preventDefault();var r=svg.getBoundingClientRect(),mx=ev.clientX-r.left,my=ev.clientY-r.top,k2=Math.max(.15,Math.min(5,tf.k*Math.exp(-ev.deltaY*.0015)));
  tf.x=mx-(mx-tf.x)*k2/tf.k;tf.y=my-(my-tf.y)*k2/tf.k;tf.k=k2;apply()},{passive:false});
svg.addEventListener('pointerdown',function(ev){pan={x:ev.clientX,y:ev.clientY,tx:tf.x,ty:tf.y};moved=false;svg.classList.add('panning');svg.setPointerCapture(ev.pointerId)});
svg.addEventListener('pointermove',function(ev){if(drag){if(Math.abs(ev.clientX-drag.x)+Math.abs(ev.clientY-drag.y)>3)moved=true;if(!moved)return;var p=pt(ev);drag.n.x=p.x;drag.n.y=p.y;drag.n.fixed=true;place()}
  else if(pan){var dx=ev.clientX-pan.x,dy=ev.clientY-pan.y;if(Math.abs(dx)+Math.abs(dy)>3)moved=true;tf.x=pan.tx+dx;tf.y=pan.ty+dy;apply()}});
function up(){drag=null;pan=null;svg.classList.remove('panning')}
svg.addEventListener('pointerup',up);svg.addEventListener('pointercancel',up);
svg.addEventListener('click',function(){if(!moved)clear()});
document.getElementById('fit').addEventListener('click',fit);
document.getElementById('relayout').addEventListener('click',function(){nodes.forEach(function(n){n.fixed=false});for(var t=0;t<200;t++)tick(.5*(1-t/200));place();fit()});
// Edge-type filters.
var off={};document.querySelectorAll('[data-etype]').forEach(function(cb){cb.addEventListener('change',function(){off[cb.getAttribute('data-etype')]=!cb.checked;
  edges.forEach(function(e){var hide=!!off[e.type];e.el.classList.toggle('hidden',hide);e.hit.classList.toggle('hidden',hide)})})});
// Highlighting.
function dimAll(keep,keepEdges){nodes.forEach(function(n){n.g.classList.toggle('dim',!!keep&&!keep[n.id]);n.g.classList.remove('sel')});
  edges.forEach(function(e){var on=!!keepEdges&&keepEdges.indexOf(e)>=0;e.el.classList.toggle('dim',!!keep&&!on);e.el.classList.toggle('hit',on)})}
function clear(){dimAll(null,null);home()}
function select(n){var keep={};keep[n.id]=1;var es=n.out.concat(n.inc);es.forEach(function(e){keep[e.from]=1;keep[e.to]=1});dimAll(keep,es);n.g.classList.add('sel');showNode(n)}
function link(id){var b=h('button',null,id);b.addEventListener('click',function(){if(byId[id])select(byId[id])});return b}
function sec(title){return h('h3',null,title)}
function list(items,fn){var ul=h('ul');items.forEach(function(x){ul.appendChild(add(h('li'),fn(x)))});return ul}
function frag(){var f=document.createDocumentFragment();for(var i=0;i<arguments.length;i++){var c=arguments[i];if(c!=null)f.appendChild(typeof c==='string'?document.createTextNode(c):c)}return f}
function countsLine(n){var p=h('p');SEV.forEach(function(sv){if(n.counts[sv])add(p,h('span',{'class':'chip sev-'+sv},n.counts[sv]+' '+sv))});return p.childNodes.length?p:null}
function showNode(n){panel.textContent='';add(panel,h('h2',null,n.id));
  var meta=h('p',{'class':'muted'});if(n.path)add(meta,h('code',null,n.path),' ');add(meta,(n.type==='module'?(n.kind||'module'):n.type)+(n.lines!=null?' \\u00b7 '+n.lines+' lines':''));add(panel,meta);
  if(n.disposition)add(panel,h('p',null,frag(h('span',{'class':'chip'},n.disposition),n.rationale||'')));
  if(n.description)add(panel,h('p',null,n.description));
  if(n.findings.length){add(panel,sec('Findings'),countsLine(n),list(n.findings,function(f){return frag(h('span',{'class':'sev-'+f.severity},f.severity),' ',f.title,' ',h('code',null,f.file+':'+f.line),h('span',{'class':'muted'},' '+f.id+' \\u00b7 '+f.dimension+(f.verdict?' \\u00b7 '+f.verdict:'')))}))}
  else if(D.generated==='report'&&n.type==='module')add(panel,sec('Findings'),h('p',{'class':'muted'},'No open findings in this module.'));
  if(n.entries.length)add(panel,sec('Entry points'),list(n.entries,function(e){return frag(e.name+(e.kind?' ('+e.kind+') ':' '),h('code',null,e.file+':'+e.line))}));
  if(n.out.length)add(panel,sec('Depends on ('+n.out.length+')'),list(n.out,function(e){return frag(h('span',{'class':'chip'},e.type),link(e.to),' ',h('code',null,e.evidence))}));
  if(n.inc.length)add(panel,sec('Used by ('+n.inc.length+')'),list(n.inc,function(e){return frag(h('span',{'class':'chip'},e.type),link(e.from),' ',h('code',null,e.evidence))}));
  var back=h('button',null,'\\u2190 Overview');back.addEventListener('click',clear);add(panel,h('p'),back)}
function showEdge(e){dimAll((function(){var k={};k[e.from]=1;k[e.to]=1;return k})(),[e]);panel.textContent='';
  add(panel,h('h2',null,e.from+' \\u2192 '+e.to),h('p',null,frag(h('span',{'class':'chip'},e.type),' ',h('code',null,e.evidence))),h('p',null,frag(link(e.from),' \\u00b7 ',link(e.to))));
  var back=h('button',null,'\\u2190 Overview');back.addEventListener('click',clear);add(panel,back)}
function showFlow(f){var keep={},hit=[],seq=[];f.steps.forEach(function(st){nodes.forEach(function(n){if(st.indexOf(n.id)>=0&&!keep[n.id]){keep[n.id]=1;seq.push(n.id)}})});
  edges.forEach(function(e){if(keep[e.from]&&keep[e.to])hit.push(e)});dimAll(seq.length?keep:null,hit);panel.textContent='';
  add(panel,h('h2',null,f.name),sec('Steps'),list(f.steps,function(st){return st}),sec('Evidence'),list(f.evidence,function(ev){return h('code',null,ev)}));
  var back=h('button',null,'\\u2190 Overview');back.addEventListener('click',clear);add(panel,h('p'),back)}
function home(){panel.textContent='';var mods=nodes.filter(function(n){return n.type==='module'});
  add(panel,h('h2',null,'Overview'),h('p',{'class':'muted'},mods.length+' modules \\u00b7 '+edges.length+' dependencies \\u00b7 '+D.stores.length+' data stores \\u00b7 '+D.externals.length+' external systems'+(D.generated==='report'?' \\u00b7 rings show the worst open finding':'')));
  if(D.flows.length)add(panel,sec('Key flows'),list(D.flows,function(f){var b=h('button',null,f.name);b.addEventListener('click',function(){showFlow(f)});return b}));
  var ranked=mods.slice().sort(function(a,b){return (a.worst?SEV.indexOf(a.worst):9)-(b.worst?SEV.indexOf(b.worst):9)||(b.out.length+b.inc.length)-(a.out.length+a.inc.length)||(a.id<b.id?-1:1)});
  add(panel,sec('Modules'),list(ranked,function(n){var c=n.worst?h('span',{'class':'sev-'+n.worst},' \\u25cf'):null;return frag(link(n.id),c,h('span',{'class':'muted'},' '+(n.out.length+n.inc.length)+' links'))}));
  if(D.stores.length)add(panel,sec('Data stores'),list(D.stores,function(x){return frag(x.name+(x.kind?' ('+x.kind+') ':' '),h('code',null,x.evidence))}));
  if(D.externals.length)add(panel,sec('External systems'),list(D.externals,function(x){return frag(x.name+(x.kind?' ('+x.kind+') ':' '),h('code',null,x.evidence))}));
  if(D.dead_ends.length)add(panel,sec('Dead ends'),list(D.dead_ends,function(x){return frag(x.name+(x.reason?' \\u2014 '+x.reason+' ':' '),x.evidence?h('code',null,x.evidence):null)}));
  if(D.observations.length)add(panel,sec('Observations'),list(D.observations,function(x){return x}))}
// Search.
var q=document.getElementById('q');q.addEventListener('input',function(){var v=q.value.trim().toLowerCase();nodes.forEach(function(n){n.g.classList.toggle('match',!!v&&(n.id.toLowerCase().indexOf(v)>=0||(n.path||'').toLowerCase().indexOf(v)>=0))})});
q.addEventListener('keydown',function(ev){if(ev.key!=='Enter')return;var v=q.value.trim().toLowerCase();for(var i=0;i<N;i++){var n=nodes[i];if(v&&(n.id.toLowerCase().indexOf(v)>=0||(n.path||'').toLowerCase().indexOf(v)>=0)){select(n);return}}});
if(!N)add(document.getElementById('canvas'),h('div',{'class':'empty'},'No modules in topology.json'));
home();fit();window.addEventListener('resize',fit);
})();
`;

export function topologyHtml(data: TopologyData): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c"); // no "</script>" can close the block early
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const legend = EDGE_TYPES.map((t) => `<label><input type="checkbox" data-etype="${t}" checked><span class="sw" style="background:var(--e-${t})"></span>${t}</label>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>System Topology</title><style>${CSS}</style></head>
<body>
<header><h1>System topology</h1><span class="muted">${esc(data.name)} · ${data.generated === "report" ? "with verified findings" : "from the map stage"} · drag to pan, scroll to zoom, click a module</span>
<input type="search" id="q" placeholder="Find a module…" aria-label="Find a module">
<button id="fit" type="button">Fit</button><button id="relayout" type="button">Re-layout</button>
<div class="legend" aria-label="Dependency types">${legend}</div></header>
<div class="layout"><div id="canvas"><svg id="graph" role="img" aria-label="Module dependency graph"><g id="vp"><g id="edges"></g><g id="nodes"></g></g></svg></div>
<aside id="panel" aria-live="polite"></aside></div>
<script type="application/json" id="topo-data">${json}</script>
<script>${JS}</script>
</body></html>
`;
}

/** Write TOPOLOGY.html (redacted, like every rendered file). Returns the redaction count. */
export function writeTopologyHtml(analysis: string, data: TopologyData): number {
  const r = redact(topologyHtml(data));
  writeText(join(analysis, "TOPOLOGY.html"), r.text);
  return r.count;
}
