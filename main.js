"use strict";
// Gantt Planner — an Obsidian plugin port of gantt_obsidian.html.
// Plain JavaScript, no build step: Obsidian loads this file as is.
const { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, TFile, normalizePath, Menu, setIcon,
        ToggleComponent, DropdownComponent,
        AbstractInputSuggest, prepareFuzzySearch } = require("obsidian");

const VIEW_TYPE = "gantt-planner";
const DEFAULT_SETTINGS = { planPath: "gantt-plan.json", taskDir: "04-tasks" };

// ---- small dialogs (Obsidian has no prompt(); confirm() breaks text focus in Electron) ----
class TextModal extends Modal {
  constructor(app, title, value, done){ super(app); this.title=title; this.value=value||""; this.done=done; this.answered=false; }
  onOpen(){
    this.titleEl.setText(this.title);
    const input=this.contentEl.createEl("input", { type:"text" });
    input.value=this.value; input.style.width="100%";
    const ok=()=>{ this.answered=true; this.done(input.value); this.close(); };
    input.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); ok(); } });
    const row=this.contentEl.createDiv({ cls:"modal-button-container" });
    row.createEl("button", { text:"OK", cls:"mod-cta" }).addEventListener("click", ok);
    row.createEl("button", { text:"Cancel" }).addEventListener("click", ()=>this.close());
    setTimeout(()=>{ input.focus(); input.select(); }, 0);
  }
  onClose(){ this.contentEl.empty(); if(!this.answered) this.done(null); }
}
class ConfirmModal extends Modal {
  constructor(app, message, yes, no, danger, done){ super(app); Object.assign(this, { message, yes, no, danger, done }); this.answer=false; }
  onOpen(){
    this.contentEl.createEl("p", { text:this.message }).style.whiteSpace="pre-wrap";
    const row=this.contentEl.createDiv({ cls:"modal-button-container" });
    row.createEl("button", { text:this.yes, cls:this.danger?"mod-warning":"mod-cta" })
       .addEventListener("click", ()=>{ this.answer=true; this.close(); });
    row.createEl("button", { text:this.no }).addEventListener("click", ()=>this.close());
  }
  onClose(){ this.contentEl.empty(); this.done(this.answer); }
}

// ---- the planner, mounted into one view's container ----
function mountPlanner(root, obsView, plugin){
const app = plugin.app;
const $ = id => root.querySelector("#"+id);
const askText = (title, value) => new Promise(res=>new TextModal(app, title, value, res).open());
const confirmBox = (message, yes, no, danger) => new Promise(res=>new ConfirmModal(app, message, yes||"OK", no||"Cancel", danger, res).open());
root.innerHTML = `
<header>
  <span class="hdr-side"></span>
  <div class="tabs">
    <button data-view="timeline" class="on" title="Click a task to open its note · double-click to create one&#10;Drag to move · drag an edge to resize · wheel to zoom · 0 to fit">Timeline</button>
    <button data-view="tree" title="Tasks by dependency depth (time not to scale)&#10;Click a task to open its note · double-click to create one">Tech tree</button>
    <button data-view="editor" title="Add, edit and delete tasks">Editor</button>
    <button data-view="pretty" title="Presentation copy of the plan, to save as HTML or print">Gantt export</button>
  </div>
  <span class="hdr-side right">
    <span class="gp-ctl" id="treesortbox" hidden title="Order of tasks within each column, top to bottom"></span>
    <label class="gp-ctl" id="donebox" hidden title="Show finished tasks in a column on the left">Done</label>
    <label class="gp-ctl" id="phasesbox" title="Show only phases, hiding their tasks">Phases only</label>
    <button id="export" title="Save the plan as CSV next to the plan file">CSV</button>
    <button id="exportop" title="Save a CSV for importing into OpenProject">OpenProject</button>
  </span>
</header>

<div id="ownerbar" hidden></div>

<div id="scroller"><div id="inner">
  <div class="timehead" id="timehead"></div>
  <svg id="links"></svg>
  <div id="rows"></div>
</div></div>

<div id="treewrap" hidden><div id="tree"><svg id="tlinks"></svg></div></div>

<div id="editwrap" hidden>
  <div class="ed-list">
    <div class="ed-top">
      <button data-act="newtask">+ Task</button>
      <button data-act="newgate">+ Milestone</button>
      <button data-act="newgroup">+ Section</button>
    </div>
    <div class="ed-scroll" id="edList"></div>
  </div>
  <div class="ed-form" id="edForm"></div>
</div>

<div id="prettywrap" hidden>
  <div class="pretty-bar">
    <label>Eyebrow<input data-p="eyebrow" placeholder="optional, e.g. programme name"></label>
    <label>Heading<input data-p="heading" placeholder="Project Timeline"></label>
    <label>Subtitle<input data-p="subtitle"></label>
    <span class="spacer"></span>
    <button id="prettyhtml" title="Save the export as an HTML file next to the plan">Save HTML</button>
    <button id="prettyprint">Print / PDF</button>
  </div>
  <iframe id="prettyframe" title="Gantt export preview"></iframe>
</div>

<div id="tip"></div>
<footer>
  <span id="legend"></span>
  <span class="spacer"></span>
  <span id="status">Loading…</span>
</footer>
`;

// ---- utilities --------------------------------------------------------
const DAY = 86400000;
const d = s => Date.parse(s + "T00:00:00Z");
const iso = t => new Date(t).toISOString().slice(0,10);
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmt = t => { const x=new Date(t);
  return x.toISOString().slice(8,10)+" "+MON[x.getUTCMonth()]+" "+String(x.getUTCFullYear()).slice(2); };
const esc = s => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
                  .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const monFloor = t => { const x=new Date(t); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1); };
const monCeil  = t => { const x=new Date(t); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth()+1, 1); };
const TODAY = (()=>{ const n=new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()); })();

const PALETTE = ["var(--c-mission)","var(--c-docking)","var(--c-layout)","var(--c-model)",
                 "var(--c-tlo)","var(--c-impulse)","var(--c-nozzle)"];
const EXTRA = ["#6fd0e8","#d8a0ff","#ffd166","#8fe0a8","#ff9ec4","#c6d36a","#ffa07a"];

let T0 = d("2026-07-01"), T1 = d("2027-10-01");
const LANE = 330;
let PXD = 3.1;
try{ const z=parseFloat(localStorage.getItem("gantt-planner.zoom")); if(z>0.2&&z<40) PXD=z; }catch(e){}
const x = t => (t - T0)/DAY*PXD;

// ---- state ------------------------------------------------------------
let groups=[], tasks=[], order=[], selId=null, view="timeline";
let planTitle="Gantt plan";
let pretty={eyebrow:"", heading:"", subtitle:""};   // captions for the gantt export
const ownerFilter=new Set();                        // selected responsibles; empty means everyone
let phasesOnly=false;                               // Timeline and Gantt export: hide tasks, keep phases
const expanded=new Set();                           // editor: phases shown open (all closed at start)
const ownerKey = t => (t.owner||"").trim();         // "" is the Unassigned chip
const visible = t => !ownerFilter.size || ownerFilter.has(ownerKey(t));
const byId={};

const end = t => t.start + (t.gate?0:t.dur)*DAY;
const gcolor = g => (groups.find(z=>z.id===g)||{}).c || "var(--ink-faint)";
const labelOf = id => { const t=byId[id]; if(!t) return id;
  const n=t.short||id; return n.length>52 ? n.slice(0,52)+"…" : n; };

function reindex(){
  Object.keys(byId).forEach(k=>delete byId[k]);
  tasks.forEach(t=>byId[t.id]=t);
  order=topo();
}
function topo(){
  const seen={}, out=[];
  const visit = id => { if(seen[id]||!byId[id]) return; seen[id]=1;
    (byId[id].deps||[]).forEach(visit); out.push(id); };
  tasks.forEach(t=>visit(t.id));
  return out;
}
// push every successor to at least the end of its predecessors
function settle(anchor){
  order.forEach(id=>{
    const t=byId[id]; if(!t || !t.deps || !t.deps.length) return;
    if(id===anchor) return;
    const min=Math.max(...t.deps.map(p=>byId[p]?end(byId[p]):-Infinity));
    if(isFinite(min) && t.start<min) t.start=min;
  });
}
// everything that transitively depends on id — adding one of these as a dep would loop
function successors(id){
  const out=new Set(); let grew=true;
  while(grew){ grew=false;
    tasks.forEach(t=>{ if(out.has(t.id)) return;
      if((t.deps||[]).some(p=>p===id||out.has(p))){ out.add(t.id); grew=true; } });
  }
  return out;
}
function nextId(prefix){ let n=1; while(byId[prefix+n]) n++; return prefix+n; }
// older plans carried a separate full name: fold it into the notes (no-op once it's gone)
function absorbName(t){
  const short=(t.short||"").trim(), name=(t.name||"").trim(), notes=t.notes||"";
  if(!short) return {short:name||String(t.id), notes};
  const keep = name && name!==short && name!==String(t.id) && !notes.includes(name);
  return {short, notes: keep ? (notes ? name+"\n"+notes : name) : notes};
}
// Sections hold phases, phases hold tasks. A phase has no dates of its own: it spans its tasks.
function nextPhaseId(gs){
  const used=new Set(gs.flatMap(g=>(g.phases||[]).map(p=>p.id)));
  let n=1; while(used.has("p"+n)) n++; return "p"+n;
}
function ensurePhase(g, name){
  g.phases=g.phases||[];
  let ph=g.phases.find(z=>z.name.toLowerCase()===name.toLowerCase());
  if(!ph){ ph={ id:nextPhaseId(groups), name }; g.phases.push(ph); }
  return ph;
}
function defaultPhase(gid){
  const g=groups.find(z=>z.id===gid);
  return (g.phases&&g.phases[0] ? g.phases[0] : ensurePhase(g, "General")).id;
}
const phaseOf = t => { const g=groups.find(z=>z.id===t.g); return g && (g.phases||[]).find(p=>p.id===t.phase); };
// a section's phases in order, each with its (visible) tasks
function phaseBlocks(g, keepId){
  const mine=tasks.filter(t=>t.g===g.id && (visible(t)||t.id===keepId));
  return (g.phases||[]).map(ph=>({ phase:ph, items:mine.filter(t=>t.phase===ph.id) }));
}
// start and end of a phase, from the tasks given
function phaseSpan(items){
  if(!items.length) return null;
  return { a:Math.min(...items.map(t=>t.start)), b:Math.max(...items.map(end)) };
}

function snapshot(){
  return { v:3, savedAt:new Date().toISOString(), title:planTitle, pretty:{...pretty},
    groups:groups.map(g=>({ id:g.id, name:g.name, c:g.c, phases:(g.phases||[]).map(ph=>({ id:ph.id, name:ph.name })) })),
    tasks: tasks.map(t=>({ id:t.id, g:t.g, phase:t.phase, gate:!!t.gate, short:t.short||"",
      owner:t.owner||"", start:iso(t.start), dur:t.gate?0:t.dur,
      deps:(t.deps||[]).slice(), state:t.state||"", tag:t.tag||"", notes:t.notes||"", link:t.link||"",
      ...(t.deadline!=null ? { deadline:iso(t.deadline) } : {}) })) };
}
function hydrate(obj){
  if(!obj || !Array.isArray(obj.tasks)) throw new Error("not a plan file");
  const gs = Array.isArray(obj.groups) ? obj.groups : [];
  const next = obj.tasks.map(t=>{
    const start=Date.parse(t.start+"T00:00:00Z");
    if(!t.id || isNaN(start)) throw new Error("bad entry: "+(t.id||"?"));
    return { id:String(t.id), g:t.g, phase:String(t.phase||""), gate:!!t.gate, ...absorbName(t),
      owner:t.owner||"", start, dur:t.gate?0:Math.max(1,parseInt(t.dur||30,10)),
      deps:(t.deps||[]).slice(), state:t.state||"", tag:t.tag||"", link:t.link||"",
      deadline: t.deadline && !isNaN(d(t.deadline)) ? d(t.deadline) : null };   // optional; not used for scheduling (yet)
  });
  const ids=new Set(next.map(t=>t.id));
  next.forEach(t=>{ t.deps=t.deps.filter(p=>ids.has(p));
    if(!t.g) t.g="general";
    if(!gs.some(g=>g.id===t.g)) gs.push({id:t.g, name:t.g==="general"?"General":t.g, c:EXTRA[gs.length%EXTRA.length], phases:[]}); });
  groups=gs.map(g=>({ id:g.id, name:g.name, c:g.c, phases:(g.phases||[]).map(ph=>({ id:String(ph.id), name:String(ph.name||ph.id) })) }));
  // every task lives in a phase of its section
  next.forEach(t=>{ const g=groups.find(z=>z.id===t.g); if(!g.phases.some(ph=>ph.id===t.phase)) t.phase=ensurePhase(g, "Unsorted").id; });
  tasks=next;
  setTitle(obj.title || planTitle);
  pretty={eyebrow:"", heading:"", subtitle:"", ...(obj.pretty||{})};
  reindex(); settle();
}
function persist(){
  syncOwners();                                  // every edit lands here, so the bar stays current
  queueDiskSave();
}
let stickyUntil=0;
function setStatus(msg, warn, sticky){
  const s=$("status");
  s.textContent=msg; s.classList.toggle("warn", !!warn);
  if(sticky) stickyUntil=Date.now()+4000;
}
function setTitle(txt){
  planTitle = String(txt||"").trim() || "Untitled plan";
  const h=$("title");
  if(h && h.textContent!==planTitle) h.textContent=planTitle;
}
function slug(){ return planTitle.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"plan"; }

function loadEmpty(){
  setTitle("Gantt plan");
  pretty={eyebrow:"", heading:"", subtitle:""};
  groups=[]; tasks=[];
  reindex();
}
// ---- timeline ---------------------------------------------------------
const rowsEl=$("rows"), head=$("timehead"),
      links=$("links"), inner=$("inner"),
      scroller=$("scroller");

function computeRange(){
  if(!tasks.length){ T0=monFloor(TODAY-25*DAY); T1=monCeil(TODAY+120*DAY); return; }
  const lo=Math.min(TODAY, ...tasks.map(t=>t.deadline!=null ? Math.min(t.start, t.deadline) : t.start));
  const hi=Math.max(TODAY, ...tasks.map(t=>t.deadline!=null ? Math.max(end(t), t.deadline) : end(t)));   // keep deadline dots in view
  T0=monFloor(lo-25*DAY); T1=monCeil(hi+25*DAY);
}
function buildHead(){
  head.style.width = inner.style.width = (LANE+x(T1))+"px";
  let h="";
  for(let t=T0;t<T1;){
    const dt=new Date(t), y=dt.getUTCFullYear(), m=dt.getUTCMonth();
    if(m%3===0) h+=`<div class="qtr" style="left:${LANE+x(t)}px">Q${m/3+1} ${y}</div>`;
    if(PXD>=1.15) h+=`<div class="mon" style="left:${LANE+x(t)}px">${MON[m].toUpperCase()}${PXD>=6?" "+String(y).slice(2):""}</div>`;
    t=Date.UTC(y,m+1,1);
  }
  head.innerHTML=h;
}
function buildRows(){
  let h="";
  groups.forEach(g=>{
    const mine=tasks.filter(t=>t.g===g.id && visible(t));
    if(!mine.length) return;
    h+=`<div class="row grouphead"><div class="label">${esc(g.name)}</div><div class="lane"></div></div>`;
    phaseBlocks(g).forEach(({phase,items})=>{
      if(!items.length && ownerFilter.size) return;
      h+=`<div class="row subhead phaserow"><div class="label">${esc(phase.name)}</div>
            <div class="lane"><div class="pbar" data-phase="${phase.id}" style="background:${g.c}"></div></div></div>`;
      if(phasesOnly) return;
      items.forEach(t=>{
      h+=`<div class="row nested" data-row="${t.id}">
        <div class="label">
          <span class="swatch" style="background:${t.gate?"var(--gate)":g.c}"></span>
          <span class="name">${esc(t.short||t.id)}</span>
          ${t.owner?`<span class="owner">@${esc(t.owner)}</span>`:""}
          ${t.tag?`<span class="tag">${esc(t.tag)}</span>`:""}
          ${t.state==="done"?`<span class="tag">done</span>`:""}
          ${t.state==="progress"?`<span class="tag">wip</span>`:""}
          ${t.gate?`<span class="tag">gate</span>`:""}
          ${t.link?`<span class="tag" title="${esc(t.link)}">note</span>`:""}
        </div>
        <div class="lane">${
          t.gate
          ? `<div class="gate" data-id="${t.id}"><i></i></div>`
          : `<div class="bar ${t.state||""}" data-id="${t.id}" style="background:${g.c}">
               <span class="grip l"></span><span class="dates"></span><span class="grip r"></span>
             </div>`}${t.deadline!=null ? `<span class="dl" data-dl="${t.id}" title="Deadline ${fmt(t.deadline)}"></span>` : ""}</div>
      </div>`;
      });
    });
  });
  rowsEl.innerHTML=h;

  inner.querySelectorAll(".vline").forEach(v=>v.remove());
  if(PXD>=7){                                   // week rules once days are legible
    const firstMon = T0 + ((8 - new Date(T0).getUTCDay())%7)*DAY;
    for(let t=firstMon;t<T1;t+=7*DAY){
      const v=document.createElement("div");
      v.className="vline wk"; v.style.left=(LANE+x(t))+"px"; inner.appendChild(v);
    }
  }
  for(let t=T0;t<T1;){
    const dt=new Date(t);
    const v=document.createElement("div");
    v.className="vline"+(dt.getUTCMonth()%3===0?" q":"");
    v.style.left=(LANE+x(t))+"px"; inner.appendChild(v);
    t=Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth()+1, 1);
  }
  const now=document.createElement("div");
  now.className="vline today"; now.style.left=(LANE+x(TODAY))+"px";
  now.title="today"; inner.appendChild(now);
}
function paint(){
  tasks.forEach(t=>{
    const el=rowsEl.querySelector(`[data-id="${t.id}"]`);
    if(!el) return;
    el.style.left=x(t.start)+"px";
    if(!t.gate){
      el.style.width=Math.max(16,t.dur*PXD)+"px";
      el.querySelector(".dates").textContent=`${fmt(t.start)} → ${fmt(end(t))}`;
    }
  });
  rowsEl.querySelectorAll(".dl").forEach(el=>{ const t=byId[el.dataset.dl]; if(t && t.deadline!=null) el.style.left=x(t.deadline)+"px"; });
  rowsEl.querySelectorAll(".pbar").forEach(el=>{          // phases follow their tasks, also mid-drag
    const sp=phaseSpan(tasks.filter(t=>t.phase===el.dataset.phase && visible(t)));
    el.style.display = sp ? "" : "none";
    if(!sp) return;
    el.style.left=x(sp.a)+"px"; el.style.width=Math.max(6,(sp.b-sp.a)/DAY*PXD)+"px";
    el.title=`${fmt(sp.a)} → ${fmt(sp.b)}`;
  });
  drawLinks();
}
function rowY(id){
  const r=rowsEl.querySelector(`[data-row="${id}"]`);
  return r ? r.offsetTop - rowsEl.offsetTop + r.offsetHeight/2 : 0;
}
function drawLinks(hot){
  links.style.top = rowsEl.offsetTop + "px";
  links.setAttribute("width", x(T1)); links.setAttribute("height", rowsEl.offsetHeight);
  if(phasesOnly){ links.innerHTML=""; return; }
  let p="";
  tasks.forEach(t=>(t.deps||[]).forEach(pid=>{
    const a=byId[pid]; if(!a || !visible(a) || !visible(t)) return;
    const x1=x(end(a)), y1=rowY(pid), x2=x(t.start), y2=rowY(t.id);
    const mid=Math.max(x1+10, x2-10);
    const cls=(hot&&(hot===t.id||hot===pid))?' class="hot"':"";
    p+=`<path${cls} d="M${x1} ${y1} H${mid} V${y2} H${x2}"/>`;
  }));
  links.innerHTML=p;
}
function buildLegend(){
  $("legend").innerHTML =
    groups.map(g=>`<span class="key"><i style="background:${g.c}"></i>${esc(g.name)}</span>`).join("")
    + `<span class="key"><i style="background:var(--gate);transform:rotate(45deg)"></i>Milestone</span>`;
}

// ---- hover detail -----------------------------------------------------
const tip=$("tip");
function tipHTML(t){
  const r=[];
  if(t.gate){
    r.push(["Type","Milestone — zero length"]);
    r.push(["Date", fmt(t.start)]);
  } else {
    r.push(["Window", `${fmt(t.start)} → ${fmt(end(t))}`]);
    r.push(["Duration", `${t.dur} days (${(t.dur/30.44).toFixed(1)} months)`]);
  }
  if(t.owner) r.push(["Owner","@"+esc(t.owner)]);
  if(t.state) r.push(["Status", t.state==="done"?"Complete":"In progress"]);
  if(t.tag) r.push(["Priority", esc(t.tag)]);
  const deps=(t.deps||[]).filter(p=>byId[p]);
  r.push(["Waits on", deps.length? deps.map(p=>esc(labelOf(p))).join("<br>") : "nothing — can start immediately"]);
  if(deps.length){
    const min=Math.max(...deps.map(p=>end(byId[p])));
    r.push(["Earliest start", fmt(min)+(t.start>min?` <span class="warn">(${Math.round((t.start-min)/DAY)} d of slack)</span>`:"")]);
  }
  const blocks=tasks.filter(o=>(o.deps||[]).includes(t.id));
  r.push(["Blocks", blocks.length? blocks.map(o=>esc(labelOf(o.id))).join("<br>") : "nothing downstream"]);
  if(t.deadline!=null) r.push(["Deadline", fmt(t.deadline)]);
  if(t.notes) r.push(["Notes", esc(t.notes)]);
  r.push(["Note", t.link ? esc(t.link) : "none"]);
  return `<b>${esc(t.short||t.id)}</b><dl>`+r.map(([k,v])=>`<dt>${k}</dt><dd>${v}</dd>`).join("")+`</dl>`;
}
function placeTip(e){
  const w=tip.offsetWidth, h=tip.offsetHeight;
  let l=e.clientX+16, tp=e.clientY+16;
  if(l+w>window.innerWidth-8) l=e.clientX-w-16;
  if(tp+h>window.innerHeight-8) tp=e.clientY-h-16;
  tip.style.left=Math.max(8,l)+"px"; tip.style.top=Math.max(8,tp)+"px";
}
rowsEl.addEventListener("pointerover", e=>{
  const el=e.target.closest(".bar, .gate"); if(!el) return;
  tip.innerHTML=tipHTML(byId[el.dataset.id]); tip.classList.add("on"); placeTip(e);
  if(!drag) drawLinks(el.dataset.id);
});
rowsEl.addEventListener("pointermove", e=>{ if(tip.classList.contains("on")) placeTip(e); });
rowsEl.addEventListener("pointerout", e=>{
  if(e.target.closest(".bar, .gate") && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".bar, .gate"))){
    tip.classList.remove("on"); if(!drag) drawLinks();
  }
});
scroller.addEventListener("scroll", ()=>tip.classList.remove("on"));

// ---- drag -------------------------------------------------------------
let drag=null;
rowsEl.addEventListener("pointerdown", e=>{
  const bar=e.target.closest(".bar, .gate"); if(!bar) return;
  const t=byId[bar.dataset.id];
  const mode = e.target.classList.contains("grip")
    ? (e.target.classList.contains("l")?"l":"r") : "move";
  drag={t,mode,x0:e.clientX,s0:t.start,d0:t.dur,el:bar};
  bar.classList.add("dragging"); bar.setPointerCapture(e.pointerId);
  drawLinks(t.id); e.preventDefault();
});
rowsEl.addEventListener("pointermove", e=>{
  if(!drag) return;
  const dd=Math.round((e.clientX-drag.x0)/PXD), t=drag.t;
  if(drag.mode==="move") t.start=drag.s0+dd*DAY;
  else if(drag.mode==="r") t.dur=Math.max(1, drag.d0+dd);
  else { const nd=Math.max(1, drag.d0-dd); t.start=drag.s0+(drag.d0-nd)*DAY; t.dur=nd; }
  settle(t.id); paint(); drawLinks(t.id);
  tip.innerHTML=tipHTML(t); tip.classList.add("on"); placeTip(e);
});
["pointerup","pointercancel"].forEach(ev=>rowsEl.addEventListener(ev, ()=>{
  if(!drag) return;
  drag.el.classList.remove("dragging"); drag=null;
  settle();
  const lo=Math.min(...tasks.map(t=>t.start)), hi=Math.max(...tasks.map(t=>end(t)));
  if(lo < T0+20*DAY || hi > T1-20*DAY){ computeRange(); buildHead(); buildRows(); }
  paint(); persist();
}));

// ---- tech tree --------------------------------------------------------
const tree=$("tree"), treewrap=$("treewrap"),
      tlinks=$("tlinks");
function depthOf(id, memo){
  const walk=(k,seen)=>{
    if(memo[k]!=null) return memo[k];
    if(seen.has(k)) return 0;
    seen.add(k);
    const dps=((byId[k]||{}).deps||[]).filter(p=>byId[p] && byId[p].state!=="done");   // finished work blocks nothing
    const v=dps.length ? 1+Math.max(...dps.map(p=>walk(p,seen))) : 0;
    memo[k]=v; return v;
  };
  return walk(id, new Set());
}
function buildTree(){
  tree.querySelectorAll(".node,.tier").forEach(n=>n.remove());
  const shownTasks=tasks.filter(t=>visible(t) && (showDone || t.state!=="done"));
  if(!shownTasks.length){ tlinks.innerHTML=""; tree.style.width="0px"; tree.style.height="0px"; return; }
  const memo={}, cols={};
  // column -1 holds finished tasks; the rest is dependency depth among unfinished work
  shownTasks.forEach(t=>{ const dp=t.state==="done" ? -1 : depthOf(t.id,memo); (cols[dp]=cols[dp]||[]).push(t); });
  const CW=250; let maxY=0;
  const first=Math.min(...Object.keys(cols).map(Number));
  const colX=dp=>(dp-first)*CW;
  Object.keys(cols).map(Number).sort((a,b)=>a-b).forEach(dp=>{
    const lab=document.createElement("div");
    lab.className="tier"; lab.style.left=colX(dp)+"px";
    lab.textContent = dp===-1 ? "DONE" : dp===0 ? "CAN START NOW" : "AFTER "+dp+(dp>1?" STEPS":" STEP");
    tree.appendChild(lab);
    let y=0;
    cols[dp].sort(treeOrder)
    .forEach(t=>{
      const el=document.createElement("div");
      el.className="node "+(t.gate?"ms ":"")+(t.state||"")+(t.link?" linked":"");
      el.dataset.id=t.id;
      el.style.left=colX(dp)+"px"; el.style.top=y+"px";
      el.style.borderLeftColor=t.gate?"var(--gate)":gcolor(t.g);
      el.innerHTML=`<div class="n">${esc(t.short||t.id)}</div><div class="m">
        ${t.owner?`<span class="owner">@${esc(t.owner)}</span>`:""}
        ${t.state?`<span class="tag">${t.state==="done"?"done":"wip"}</span>`:""}
        ${t.tag?`<span class="tag">${esc(t.tag)}</span>`:""}
        ${t.gate?`<span class="tag">gate</span>`:""}
        <span class="tag">${fmt(t.start)}</span></div>`;
      tree.appendChild(el);
      y+=el.offsetHeight+10;
    });
    maxY=Math.max(maxY,y);
  });
  const w=colX(Math.max(...Object.keys(cols).map(Number)))+200;
  tree.style.width=w+"px"; tree.style.height=maxY+"px";
  tlinks.setAttribute("width", w); tlinks.setAttribute("height", maxY);
  drawTree();
}
function drawTree(hot){
  const p=[];
  tasks.forEach(t=>(t.deps||[]).forEach(pid=>{
    const a=tree.querySelector(`.node[data-id="${pid}"]`), b=tree.querySelector(`.node[data-id="${t.id}"]`);
    if(!a||!b) return;
    const x1=a.offsetLeft+a.offsetWidth, y1=a.offsetTop+a.offsetHeight/2,
          x2=b.offsetLeft, y2=b.offsetTop+b.offsetHeight/2, mx=(x1+x2)/2;
    const cls=(hot&&(hot===t.id||hot===pid))?' class="hot"':"";
    p.push(`<path${cls} d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/>`);
  }));
  tlinks.innerHTML=p.join("");
}
tree.addEventListener("pointerover", e=>{
  const el=e.target.closest(".node"); if(!el) return;
  tip.innerHTML=tipHTML(byId[el.dataset.id]); tip.classList.add("on"); placeTip(e);
  drawTree(el.dataset.id);
});
tree.addEventListener("pointermove", e=>{ if(tip.classList.contains("on")) placeTip(e); });
tree.addEventListener("pointerout", e=>{
  if(e.target.closest(".node") && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".node"))){
    tip.classList.remove("on"); drawTree();
  }
});
treewrap.addEventListener("scroll", ()=>tip.classList.remove("on"));

// ---- note frontmatter ----------------------------------------------------
// The planner owns these keys in a linked note; anything else in the note is left alone.
const NOTE_STATUS={done:"Done", progress:"Doing"};
const ys=v=>{ v=String(v);                     // YAML scalar: bare when safe, else JSON-quoted
  return /^[A-Za-z0-9][\w .\/()&'+-]*$/.test(v) && !/\s$/.test(v) && !/^[\d.+-]+$/.test(v)
    && !/^(true|false|null|yes|no|on|off)$/i.test(v) ? v : JSON.stringify(v); };
const unq=v=>{ v=v.trim(); if(/^".*"$/.test(v)){ try{ return JSON.parse(v); }catch(e){} } return v.replace(/^'(.*)'$/,"$1"); };
const ownerTag=o=>o.trim().replace(/\s+/g,"-");
// undefined: keep whatever the note has · null: remove the key
function noteMeta(t){
  const g=groups.find(z=>z.id===t.g)||{}, ph=phaseOf(t);
  return {
    title:ys(t.short||t.id), type:t.gate?"milestone":"task",
    status:NOTE_STATUS[t.state]||"To do",
    priority:t.tag==="low"?"Low":t.tag==="high"?"High":"Normal",
    parent:ys(ph?ph.name:""), section:ys(g.name||""), subsection:null,
    start:t.gate?null:iso(t.start), deadline:iso(end(t)),
    percent_complete:t.state==="done"?"100%":t.state==="progress"?undefined:"0%",
    owner:(t.owner||"").trim()?ys(t.owner.trim()):null,
    gantt_id:ys(t.id),
  };
}
function mergeMeta(txt, t, creating){
  txt=txt.replace(/\r\n/g,"\n");
  let fm=[], body=txt;
  if(txt.startsWith("---\n")){
    const rest=txt.slice(4), m=rest.match(/^---[ \t]*$/m);
    if(m){ fm=rest.slice(0,m.index).split("\n"); if(fm[fm.length-1]==="") fm.pop();
           body=rest.slice(m.index+m[0].length).replace(/^\n/,""); }
  }
  const blocks=[];
  fm.forEach(line=>{
    if(/^[A-Za-z_][\w -]*:/.test(line)) blocks.push({key:line.slice(0,line.indexOf(":")).trim(), lines:[line]});
    else if(blocks.length) blocks[blocks.length-1].lines.push(line);
    else blocks.push({key:null, lines:[line]});
  });
  const get=k=>blocks.find(b=>b.key===k);
  const inline=b=>b?b.lines[0].slice(b.lines[0].indexOf(":")+1).trim():"";
  const set=(k,v)=>{ const b=get(k);
    if(v===null){ if(b) blocks.splice(blocks.indexOf(b),1); return; }
    const lines=Array.isArray(v)?v:[k+": "+v];
    if(b) b.lines=lines; else blocks.push({key:k, lines}); };

  const meta=noteMeta(t), prevOwner=unq(inline(get("owner")));
  if(meta.percent_complete===undefined && !get("percent_complete"))
    meta.percent_complete=Math.round(pctOf(t))+"%";
  // the owner doubles as a tag; swap the old owner's tag, keep every other tag
  const tb=get("tags"); let tags=[];
  if(tb){
    const v=inline(tb);
    if(v.startsWith("[")) tags=v.replace(/^\[|\]$/g,"").split(",");
    else if(v) tags=[v];
    tb.lines.slice(1).forEach(l=>{ const m=l.match(/^\s*-\s*(.*)$/); if(m) tags.push(m[1]); });
    tags=tags.map(unq).filter(Boolean);
  }
  if(prevOwner) tags=tags.filter(x=>x!==ownerTag(prevOwner));
  if(meta.owner) { const tg=ownerTag(t.owner); if(!tags.includes(tg)) tags.push(tg); }

  ["title","type","status","priority","parent","section","subsection","start","deadline","percent_complete"]
    .forEach(k=>{ if(meta[k]!==undefined) set(k, meta[k]); });
  if(creating && !get("work_hours")) set("work_hours","Not specified");
  set("owner", meta.owner); set("gantt_id", meta.gantt_id);
  if(tags.length) set("tags", ["tags:", ...tags.map(x=>"  - "+ys(x))]);
  else if(tb) set("tags","[]");
  return "---\n"+blocks.flatMap(b=>b.lines).join("\n")+"\n---\n"+body;
}
// ---- notes in the vault ----------------------------------------------
const taskDir=()=>normalizePath(plugin.settings.taskDir||"04-tasks");
// the note path inside a link: plain path, [[wikilink]] or obsidian:// URL
function linkpath(link){
  let s=(link||"").trim();
  if(!s) return null;
  if(/^obsidian:/i.test(s)){ try{ s=new URL(s).searchParams.get("file")||""; }catch(e){ return null; } }
  const m=s.match(/^\[\[([^|\]#]+)/); if(m) s=m[1];
  s=s.replace(/^\.?\//,"").trim();
  return s||null;
}
function noteFile(t){
  const lp=linkpath(t.link); if(!lp) return null;
  const f=app.metadataCache.getFirstLinkpathDest(lp.replace(/\.md$/i,""), planPath())
       || fileAt(lp) || fileAt(lp+".md");
  return f && f.extension==="md" ? f : null;
}
const noteMissing = t => !!linkpath(t.link) && !noteFile(t);
function openNote(t){
  const f=noteFile(t); if(!f) return;
  app.workspace.getLeaf(true).openFile(f);
}
const metaSeen=new Map();                      // task id → what was last synced, to skip unchanged notes
// rewrite the frontmatter of every linked note whose task changed; never creates notes
function syncNotes(){
  if(!loaded) return;
  diskQ=diskQ.then(async ()=>{
    for(const t of tasks){
      if(!t.link) continue;
      const key=t.link+"|"+JSON.stringify(noteMeta(t));
      if(metaSeen.get(t.id)===key) continue;
      const f=noteFile(t); if(!f) continue;
      const old=await app.vault.read(f), next=mergeMeta(old,t,false);
      if(next!==old) await app.vault.modify(f,next);
      metaSeen.set(t.id,key);
    }
  }).catch(e=>{ console.warn("note sync failed:", e); setStatus("Couldn't update note metadata — "+e.message, true); });
}
async function createNote(t){
  const base=(t.short||"").replace(/[\\/:*?"<>|#^\[\]]+/g," ").replace(/\s+/g," ").replace(/^[\s.]+|[\s.]+$/g,"")||t.id;
  const dir=taskDir();
  const clash=tasks.some(o=>o!==t && (o.link||"").trim()===dir+"/"+base);
  const old=linkpath(t.link);                   // recreating a deleted note: keep its path
  const path=old ? old.replace(/\.md$/i,"") : dir+"/"+(clash ? base+" ("+t.id+")" : base);
  const fp=normalizePath(path+".md");
  const body=t.notes?"\n"+t.notes+"\n":"";
  tip.classList.remove("on");
  try{
    let f=fileAt(fp);
    pendingNotes.add(fp);
    if(f) setStatus("Linked existing "+fp, false, true);
    else {
      await ensureFolder(fp.includes("/") ? fp.slice(0, fp.lastIndexOf("/")) : "");
      f=await app.vault.create(fp, mergeMeta(body,t,true));
      setStatus("Created "+fp, false, true);
    }
    t.link=path; metaSeen.delete(t.id);
    app.workspace.getLeaf(true).openFile(f);
  }catch(e){ setStatus("Couldn't create "+fp+" — "+e.message, true); return; }
  finally{ pendingNotes.delete(fp); }
  refreshViews(); persist();
}
// a drag also ends in a click, so only treat it as one if the pointer stayed put
let downX=0;
rowsEl.addEventListener("pointerdown", e=>{ downX=e.clientX; }, true);
const rowTask=e=>{ const hit=e.target.closest(".bar, .gate, .label"), row=hit&&hit.closest("[data-row]");
  return row?byId[row.dataset.row]:null; };
const nodeTask=e=>{ const n=e.target.closest(".node"); return n?byId[n.dataset.id]:null; };
function clickTask(t){
  if(!t || !t.link) return;
  if(noteMissing(t)){ setStatus(t.link+" no longer exists — double-click to create it again", true, true); return; }
  openNote(t);
}
function dblclickTask(t){
  if(t && (!t.link || noteMissing(t))) createNote(t);
}
rowsEl.addEventListener("click", e=>{
  if(e.detail>1 || Math.abs(e.clientX-downX)>3) return;
  clickTask(rowTask(e));
});
rowsEl.addEventListener("dblclick", e=>dblclickTask(rowTask(e)));
tree.addEventListener("click", e=>{ if(e.detail>1) return; clickTask(nodeTask(e)); });
tree.addEventListener("dblclick", e=>dblclickTask(nodeTask(e)));

// ---- editor -----------------------------------------------------------
const edListEl=$("edList"), edFormEl=$("edForm");

function edList(){
  let h="";
  groups.forEach(g=>{
    const mine=tasks.filter(t=>t.g===g.id);
    h+=`<div class="ed-ghead" data-group="${g.id}" title="Right-click for options"><span class="gs" style="background:${g.c}"></span>
          <span style="flex:1">${esc(g.name)}</span>
          <button class="mini icon" data-addphase="${g.id}" data-icon="plus" title="Add phase" aria-label="Add phase">+</button>
        </div>`;
    const item=(t,nested)=>`<div class="ed-item ${t.id===selId?"sel":""} ${t.state==="done"?"isdone":""} ${nested?"nested":""}" data-pick="${t.id}">
        ${t.gate?`<span class="k">◆</span>`
                :`<input type="checkbox" data-done="${t.id}" ${t.state==="done"?"checked":""} title="mark as done" aria-label="Mark ${esc(t.short||t.id)} as done">`}
        <span class="t">${esc(t.short||t.id)}</span>
        ${t.owner?`<span class="owner">@${esc(t.owner)}</span>`:""}
      </div>`;
    phaseBlocks(g, selId).forEach(({phase,items})=>{
      const open=expanded.has(phase.id), any=tasks.some(t=>t.phase===phase.id);
      h+=`<div class="ed-shead ed-phase ${open?"open":""}" data-toggle="${phase.id}" title="Click to ${open?"collapse":"expand"} · right-click for options">
          <span class="caret">${open?"▾":"▸"}</span>
          <span class="sn">${esc(phase.name)}</span>
          <button class="mini icon" data-addto="${g.id}" data-phase="${phase.id}" data-icon="plus" title="Add task" aria-label="Add task">+</button>
          <button class="mini icon" data-addto="${g.id}" data-phase="${phase.id}" data-gate="1" data-icon="diamond" title="Add milestone" aria-label="Add milestone">◆</button>
        </div>`;
      if(open) items.forEach(t=>{ h+=item(t, true); });
    });
  });
  edListEl.innerHTML=h;
  if(setIcon) edListEl.querySelectorAll("button[data-icon]").forEach(b=>{ b.textContent=""; setIcon(b, b.dataset.icon); });
}

function edForm(){
  const t=byId[selId];
  if(!t){
    edFormEl.innerHTML=`<div class="ed-card"><div class="ed-empty">
      Select an item on the left, or add one with <b>+ Task</b> / <b>+ Milestone</b>.
    </div></div>`;
    return;
  }
  const gate=!!t.gate;
  const blocked=successors(t.id); blocked.add(t.id);
  const deps=new Set(t.deps||[]);
  const live=(t.deps||[]).filter(p=>byId[p]);
  const minStart = live.length ? Math.max(...live.map(p=>end(byId[p]))) : null;
  const phases=(groups.find(g=>g.id===t.g)||{}).phases||[];

  const depCols = groups.map(g=>{
    const mine=tasks.filter(o=>o.g===g.id && o.id!==t.id);
    if(!mine.length) return "";
    return `<div class="dep-g"><span>${esc(g.name)}</span>`+ mine.map(o=>{
      const off=blocked.has(o.id);
      return `<label class="dep ${off?"off":""}" title="${off?"would create a loop":esc(o.short||o.id)}">
        <input type="checkbox" data-dep="${o.id}" ${deps.has(o.id)?"checked":""} ${off?"disabled":""}>
        <span>${o.gate?"◆ ":""}${esc(o.short||o.id)}</span></label>`;
    }).join("") + `</div>`;
  }).join("");

  edFormEl.innerHTML=`
    <div class="ed-card">
      <div class="ed-head">
        <h2>${esc(t.short||"Untitled")}</h2>
        <span class="tag">${esc(t.id)}</span>
        <span class="spacer"></span>
        <button class="danger" data-act="del">Delete</button>
      </div>
      <div class="ed-grid">
        <label>Kind
          <select data-f="kind">
            <option value="task" ${gate?"":"selected"}>Task</option>
            <option value="gate" ${gate?"selected":""}>Milestone</option>
          </select></label>
        <label>Section
          <select data-f="g">${groups.map(g=>`<option value="${g.id}" ${g.id===t.g?"selected":""}>${esc(g.name)}</option>`).join("")}</select></label>
        <label>Phase
          <select data-f="phase">
            ${phases.map(ph=>`<option value="${ph.id}" ${ph.id===t.phase?"selected":""}>${esc(ph.name)}</option>`).join("")}
          </select></label>

        <label class="wide">Short label<input data-f="short" value="${esc(t.short||"")}" placeholder="what shows on the bar"></label>

        <label>Start<input type="date" data-f="start" value="${iso(t.start)}"></label>
        ${gate ? `<label>Duration<input value="milestone — 0 days" disabled></label>`
               : `<label>Duration (days)<input type="number" min="1" step="1" data-f="dur" value="${t.dur}"></label>`}
        <label>Status
          <select data-f="state">
            <option value="" ${!t.state?"selected":""}>Not started</option>
            <option value="progress" ${t.state==="progress"?"selected":""}>In progress</option>
            <option value="done" ${t.state==="done"?"selected":""}>Complete</option>
          </select></label>
        <label>Priority
          <select data-f="tag">
            <option value="" ${!t.tag?"selected":""}>Normal</option>
            <option value="low" ${t.tag==="low"?"selected":""}>Low</option>
            <option value="high" ${t.tag==="high"?"selected":""}>High</option>
          </select></label>
        <label>Owner<input data-f="owner" value="${esc(t.owner||"")}" placeholder="name"></label>
        <label>Deadline<input type="date" data-f="deadline" value="${t.deadline!=null?iso(t.deadline):""}" title="Optional. Saved with the task; doesn't move anything on the timeline."></label>
        <label class="wide">Notes<textarea data-f="notes" rows="2" placeholder="anything worth remembering — shows in the hover panel">${esc(t.notes||"")}</textarea></label>
        <label class="wide">Obsidian note<input data-f="link" value="${esc(t.link||"")}" placeholder="Start typing a note name" autocomplete="off"></label>
        <div class="gp-notehint" id="notehint"></div>
      </div>
    </div>

    <div class="ed-card">
      <div class="ed-sub">Depends on
        <span class="spacer"></span>
        ${minStart!=null?`<button data-act="snap">Snap to earliest</button>`:""}
      </div>
      <div class="readout" style="margin-bottom:14px">
        ${minStart!=null
          ? `Earliest possible start ${fmt(minStart)}${t.start>minStart?` — currently ${Math.round((t.start-minStart)/DAY)} days later`:" — sitting there now"}`
          : "No dependencies, so this can sit wherever you put it."}
      </div>
      <div class="dep-cols">${depCols||`<div class="ed-empty">Nothing else to depend on yet.</div>`}</div>
    </div>`;
  attachNoteSuggest(t);
  paintNoteHint(t);
}

// ---- note suggestions ---------------------------------------------------
const fileLink=f=>f.path.replace(/\.md$/i,"");
// notes ranked for a query: fuzzy match on the path, tasks folder first, notes other tasks use last
function rankNotes(query, t, limit){
  const used=new Map();
  tasks.forEach(o=>{ if(o!==t){ const f=noteFile(o); if(f) used.set(f.path, o); } });
  const q=query.trim(), ql=q.toLowerCase();
  const fuzzy=q && prepareFuzzySearch ? prepareFuzzySearch(q) : null;
  const out=[];
  for(const f of app.vault.getMarkdownFiles()){
    let score=0;
    if(q){
      const m=fuzzy ? fuzzy(fileLink(f)) : (fileLink(f).toLowerCase().includes(ql) ? {score:0} : null);
      if(!m) continue;
      score=m.score;
    }
    if(inTaskDir(f)) score+=1;
    if(used.has(f.path)) score-=2;
    out.push({ file:f, score, usedBy:used.get(f.path) });
  }
  out.sort((a,b)=>b.score-a.score || ((b.file.stat||{}).mtime||0)-((a.file.stat||{}).mtime||0));
  return out.slice(0, limit);
}
const NoteSuggest = AbstractInputSuggest ? class extends AbstractInputSuggest {
  constructor(inputEl, t){ super(app, inputEl); this.inputEl=inputEl; this.t=t; }
  getSuggestions(q){ return rankNotes(q, this.t, 30); }
  renderSuggestion(r, el){
    el.createDiv({ text:fileLink(r.file), cls:"suggestion-content" });
    if(r.usedBy) el.createDiv({ text:"linked to "+(r.usedBy.short||r.usedBy.id), cls:"suggestion-note" });
  }
  selectSuggestion(r){
    this.inputEl.value=fileLink(r.file);
    this.inputEl.dispatchEvent(new Event("input", { bubbles:true }));
    this.close();
  }
} : null;
function attachNoteSuggest(t){
  const input=edFormEl.querySelector('[data-f="link"]'); if(!input) return;
  if(NoteSuggest){ new NoteSuggest(input, t); return; }
  // older Obsidian: fall back to the browser's own list
  const dl=document.createElement("datalist"); dl.id="gp-notes";
  rankNotes("", t, 500).forEach(r=>{ const o=document.createElement("option"); o.value=fileLink(r.file); dl.appendChild(o); });
  input.setAttribute("list","gp-notes"); input.after(dl);
}
// a note whose name contains every word of the task's label, offered while the task has no note
function bestNote(t){
  const words=(t.short||"").toLowerCase().split(/[^a-z0-9]+/).filter(w=>w.length>2);
  if(!words.length) return null;
  const hit=rankNotes("", t, Infinity).find(r=>!r.usedBy && words.every(w=>r.file.basename.toLowerCase().includes(w)));
  return hit ? hit.file : null;
}
function paintNoteHint(t){
  const el=edFormEl.querySelector("#notehint"); if(!el) return;
  const f=!t.link && bestNote(t);
  el.innerHTML = f ? `Matching note <b>${esc(fileLink(f))}</b> <button class="mini" data-act="uselink" data-path="${esc(fileLink(f))}">Link</button>` : "";
}

function select(id){ selId=id; if(byId[id]) expanded.add(byId[id].phase); edList(); edForm(); }
function refreshViews(){
  if(view==="timeline"){ buildHead(); buildRows(); paint(); }
  else if(view==="tree") buildTree();
  else if(view==="pretty") buildPretty();
}

// typing edits the model in place; the field being typed in is never re-rendered
edFormEl.addEventListener("input", e=>{
  const t=byId[selId]; if(!t) return;
  const f=e.target.dataset.f;
  if(f==="short"||f==="owner"||f==="notes"||f==="link"){
    t[f]=e.target.value; edList(); refreshViews(); persist();
    if(f==="short"||f==="link") paintNoteHint(t);
  } else if(f==="dur"){
    const v=parseInt(e.target.value,10);
    if(!isNaN(v)&&v>0){ t.dur=v; settle(); computeRange(); refreshViews(); persist(); }
  } else if(f==="start"){
    const v=Date.parse(e.target.value+"T00:00:00Z");
    if(!isNaN(v)){ t.start=v; settle(t.id); settle(); computeRange(); refreshViews(); persist(); }
  } else if(f==="deadline"){                     // empty clears it
    const v=Date.parse(e.target.value+"T00:00:00Z");
    t.deadline = e.target.value && !isNaN(v) ? v : null;
    persist();
  }
});
edFormEl.addEventListener("change", e=>{
  const t=byId[selId]; if(!t) return;
  const f=e.target.dataset.f;
  if(f==="kind"){
    t.gate = e.target.value==="gate";
    t.dur  = t.gate?0:30;
    if(t.gate) t.state="";
    settle(); edForm(); edList();
  } else if(f==="g"){ t.g=e.target.value; t.phase=defaultPhase(t.g); expanded.add(t.phase); edList(); edForm(); }
  else if(f==="phase"){ t.phase=e.target.value; expanded.add(t.phase); edList(); }
  else if(f==="state"||f==="tag"){ t[f]=e.target.value; edList(); }
  else if(e.target.dataset.dep!==undefined){
    const id=e.target.dataset.dep;
    t.deps=t.deps||[];
    if(e.target.checked){ if(!t.deps.includes(id)) t.deps.push(id); }
    else t.deps=t.deps.filter(p=>p!==id);
    order=topo(); settle(); edForm();
  } else return;
  computeRange(); refreshViews(); persist();
});
edFormEl.addEventListener("click", async e=>{
  const act=e.target.dataset.act; if(!act) return;
  const t=byId[selId]; if(!t) return;
  if(act==="uselink"){
    t.link=e.target.dataset.path; metaSeen.delete(t.id);
    edForm(); edList(); refreshViews(); persist(); return;
  }
  if(act==="del"){
    const nf=noteFile(t), trash=!!nf && inTaskDir(nf);
    if(!await confirmBox("Delete “"+(t.short||t.id)+"”?\nAny dependency on it is dropped as well."
        +(trash?"\nIts note "+nf.path+" is moved to the trash too.":""), "Delete", "Cancel", true)) return;
    tasks=tasks.filter(o=>o.id!==t.id);
    tasks.forEach(o=>o.deps=(o.deps||[]).filter(p=>p!==t.id));
    reindex(); settle(); select(null);
    computeRange(); buildLegend(); refreshViews(); persist();
    if(trash){
      try{ await (app.fileManager.trashFile ? app.fileManager.trashFile(nf) : app.vault.trash(nf, true)); }
      catch(e){ setStatus("Couldn't move "+nf.path+" to the trash — "+e.message, true); }
    }
  }
  if(act==="snap"){
    const live=(t.deps||[]).filter(p=>byId[p]);
    if(!live.length) return;
    t.start=Math.max(...live.map(p=>end(byId[p])));
    settle(); edForm(); computeRange(); refreshViews(); persist();
  }
});
edListEl.addEventListener("click", async e=>{
  const ds=e.target.dataset;
  if(ds.done){                                  // checkbox sits inside the clickable row
    const t=byId[ds.done]; if(!t) return;
    t.state = e.target.checked ? "done" : "";
    edList(); if(t.id===selId) edForm();
    persist(); return;
  }
  const btn=e.target.closest("button");
  if(btn){ listAction({...btn.dataset}); return; }
  const pick=e.target.closest("[data-pick]");
  if(pick){ select(pick.dataset.pick); return; }
  const tog=e.target.closest("[data-toggle]");
  if(tog){ const id=tog.dataset.toggle; expanded.has(id)?expanded.delete(id):expanded.add(id); edList(); return; }
});
const findPhase=id=>{ for(const g of groups){ const ph=(g.phases||[]).find(z=>z.id===id); if(ph) return {g,ph}; } return null; };
// section and phase actions, run from their right-click menus
async function listAction(ds){
  if(ds.grpren){
    const g=groups.find(z=>z.id===ds.grpren); if(!g) return;
    const name=(await askText("Rename section:", g.name)||"").trim();
    if(!name || name===g.name) return;
    // note import finds sections by name, so names must stay unique
    if(groups.some(z=>z!==g && z.name.toLowerCase()===name.toLowerCase())){ new Notice("There is already a section called “"+name+"”."); return; }
    g.name=name; metaSeen.clear();              // task notes carry the section name
    edList(); edForm(); buildLegend(); refreshViews(); persist(); return;
  }
  if(ds.addphase){
    const name=(await askText("Name for the new phase:")||"").trim();
    if(!name) return;
    const g=groups.find(z=>z.id===ds.addphase);
    g.phases=g.phases||[];
    const ph={ id:nextPhaseId(groups), name }; g.phases.push(ph); expanded.add(ph.id);
    edList(); edForm(); refreshViews(); persist(); return;
  }
  if(ds.phren){
    const hit=findPhase(ds.phren); if(!hit) return;
    const name=(await askText("Rename phase:", hit.ph.name)||"").trim();
    if(!name) return;
    hit.ph.name=name; metaSeen.clear();          // task notes carry the phase name
    edList(); edForm(); refreshViews(); persist(); return;
  }
  if(ds.phdel){
    const hit=findPhase(ds.phdel); if(!hit || tasks.some(t=>t.phase===hit.ph.id)) return;
    hit.g.phases=hit.g.phases.filter(z=>z!==hit.ph);
    edList(); edForm(); refreshViews(); persist(); return;
  }
  if(ds.addto){ newItem(!!ds.gate, ds.addto, ds.phase); return; }
  if(ds.delgroup){
    if(tasks.some(t=>t.g===ds.delgroup)) return;
    groups=groups.filter(g=>g.id!==ds.delgroup);
    edList(); buildLegend(); refreshViews(); persist();
  }
}
edListEl.addEventListener("contextmenu", e=>{
  const ph=e.target.closest("[data-toggle]"), sec=e.target.closest("[data-group]");
  if(!ph && !sec) return;
  e.preventDefault();
  const menu=new Menu();
  const item=(title, icon, ds, warn)=>menu.addItem(i=>{
    i.setTitle(title).setIcon(icon).onClick(()=>listAction(ds));
    if(warn && i.setWarning) i.setWarning(true);
  });
  if(ph){
    const hit=findPhase(ph.dataset.toggle); if(!hit) return;
    item("Add task", "plus", { addto:hit.g.id, phase:hit.ph.id });
    item("Add milestone", "diamond", { addto:hit.g.id, phase:hit.ph.id, gate:"1" });
    item("Rename phase", "pencil", { phren:hit.ph.id });
    if(!tasks.some(t=>t.phase===hit.ph.id)) item("Delete phase", "trash-2", { phdel:hit.ph.id }, true);
  } else {
    const gid=sec.dataset.group;
    item("Add phase", "plus", { addphase:gid });
    item("Rename section", "pencil", { grpren:gid });
    if(!tasks.some(t=>t.g===gid)) item("Delete section", "trash-2", { delgroup:gid }, true);
  }
  menu.showAtMouseEvent(e);
});

function newItem(gate, groupId, phaseId){
  let g, phase;
  if(groupId){ g=groupId; phase=phaseId||defaultPhase(g); }
  else if(byId[selId]){ g=byId[selId].g; phase=byId[selId].phase; }
  else { g=(groups[0]||ensureGroup("General")).id; phase=defaultPhase(g); }
  expanded.add(phase);
  const t={ id:nextId(gate?"ms":"t"), g, phase, gate:!!gate,
    short: gate?"New milestone":"New task",
    owner:"", start:TODAY, dur:gate?0:30, deps:[], state:"", tag:"", notes:"" };
  tasks.push(t); reindex(); settle();
  select(t.id);
  computeRange(); refreshViews(); persist();
  const el=edFormEl.querySelector('[data-f="short"]');
  if(el){ el.focus(); el.select(); }
}
root.querySelector(".ed-top").addEventListener("click", async e=>{
  const a=e.target.dataset.act;
  if(a==="newtask") newItem(false);
  if(a==="newgate") newItem(true);
  if(a==="newgroup"){
    const name=await askText("Name for the new section:");
    if(!name) return;
    let id=name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || "section";
    const base=id; let n=2;
    while(groups.some(g=>g.id===id)) id=base+"-"+(n++);
    const used=groups.map(g=>g.c);
    const c = PALETTE.find(p=>!used.includes(p)) || EXTRA[groups.length%EXTRA.length];
    groups.push({id,name,c,phases:[]});
    edList(); buildLegend(); persist();
  }
});

// ---- gantt export -----------------------------------------------------
// Fixed light document, independent of the app theme. The stylesheet and markup
// deliberately mirror gantt_chart.html; it lives in an iframe so neither page's
// CSS leaks into the other and the same string can be saved as a standalone file.
const PRETTY_CSS=`
  :root {
    --row-h: 22px;
    --label-w: 34%;
  }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", Helvetica, Arial, sans-serif;
    color: #262a30;
    margin: 0;
    padding: 20px 24px;
    background: #fff;
  }
  .eyebrow { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #8A8F98; margin: 0 0 2px; }
  h1 { font-size: 18px; margin: 0 0 2px; color: #1c2733; }
  .subtitle { font-size: 12px; color: #6b7280; margin: 0 0 14px; }

  .chart { display: flex; border-top: 1px solid #dfe3e8; }
  .col-labels { width: var(--label-w); flex: 0 0 var(--label-w); border-right: 1px solid #dfe3e8; }
  .col-timeline { flex: 1 1 auto; position: relative; }

  .header-row { display: flex; height: 26px; border-bottom: 1px solid #dfe3e8; }
  .header-row .col-labels { display:flex; align-items:center; font-size:11px; font-weight:700; color:#6b7280; padding-left: 4px; border-right: 1px solid #dfe3e8;}
  .header-row .col-timeline { position: relative; }
  .tick-label { position: absolute; top: 6px; transform: translateX(-2px); font-size: 10px; font-weight: 600; color: #6b7280; white-space: nowrap; }
  .tick-label.year { color: #262a30; font-weight: 700; }

  .body { position: relative; }
  .grid-overlay { position: absolute; inset: 0; pointer-events: none; }
  .gl { position: absolute; top: 0; bottom: 0; width: 1px; }
  .gl-month { background: #eef0f2; }
  .gl-quarter { background: #dfe3e8; }
  .gl-year { background: #c3c9d1; }
  .gl-today { background: #c94a4a; width: 1.5px; }

  .lbl-row { height: var(--row-h); display: flex; align-items: center; font-size: 11px; padding-right: 6px; border-bottom: 1px solid #f2f3f5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tl-row { height: var(--row-h); position: relative; border-bottom: 1px solid #f2f3f5; }

  .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; flex: 0 0 auto; }

  .bar-track { position: absolute; border-radius: 3px; overflow: hidden; }
  .bar-task { top: 4px; height: 14px; }
  .bar-phase { top: 8px; height: 6px; }
  .bar-fill { height: 100%; }

  .milestone { position: absolute; top: 4px; width: 12px; height: 12px; transform: translateX(-6px) rotate(45deg); border: 1.5px solid #fff; }

  .legend { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 4px 16px; }
  .legend-item { font-size: 10.5px; color: #4b5157; display: flex; align-items: center; }

  .footnote { margin-top: 8px; font-size: 9.5px; color: #9aa0a8; }
  @media print { body { padding: 0; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
`;
// first three are the reference chart's section colours; the rest are matched to them
const PRETTY_COLORS=["#3B6E8F","#3E8F79","#C08A3E","#7A64A6","#B0587F","#6F8F3E","#B8654A","#4A8FA3","#8F6A4E","#5F6B8F"];
const prettyTint = hex => "rgb("+[1,3,5].map(i=>Math.round(parseInt(hex.substr(i,2),16)*.2+204)).join(",")+")";
const fmtLong = t => { const x=new Date(t);
  return x.toISOString().slice(8,10)+" "+MON[x.getUTCMonth()]+" "+x.getUTCFullYear(); };
const pctOf = t => t.state==="done" ? 100
  : t.state==="progress" ? Math.min(100, Math.max(0, (TODAY-t.start)/(t.dur*DAY)*100)) : 0;

function prettyDoc(){
  const vis=tasks.filter(visible);
  const shown=groups.filter(g=>vis.some(t=>t.g===g.id));
  const heading=pretty.heading||"Project Timeline", subtitle=pretty.subtitle||planTitle;
  const eyebrow=pretty.eyebrow?`<p class="eyebrow">${esc(pretty.eyebrow)}</p>`:"";
  const color=g=>PRETTY_COLORS[groups.indexOf(g)%PRETTY_COLORS.length];

  const lo=vis.length?monFloor(Math.min(...vis.map(t=>t.start))):monFloor(TODAY);
  const hi=vis.length?monCeil(Math.max(...vis.map(end))):monCeil(TODAY);
  const pos=t=>((t-lo)/(hi-lo)*100).toFixed(3)+"%";
  const span=(a,b)=>((b-a)/(hi-lo)*100).toFixed(3)+"%";

  const months=[]; for(let t=lo;t<=hi;){ months.push(t); const z=new Date(t); t=Date.UTC(z.getUTCFullYear(),z.getUTCMonth()+1,1); }
  const yy=t=>"&#x27;"+String(new Date(t).getUTCFullYear()).slice(2);
  const short=months.length<=10;                  // too few quarters to read: label every month
  const ticks=months.slice(0,-1).filter((t,i)=>short||i%3===0).map(t=>{
    const m=new Date(t).getUTCMonth();
    return `<span class="tick-label" style="left:${pos(t)}">${short?MON[m]:"Q"+(Math.floor(m/3)+1)} ${yy(t)}</span>`;
  }).join("");
  const showToday=TODAY>=lo&&TODAY<=hi;
  const gl=months.map(t=>{ const m=new Date(t).getUTCMonth();
    return `<div class="gl ${m===0?"gl-year":m%3===0?"gl-quarter":"gl-month"}" style="left:${pos(t)}"></div>`; }).join("")
    +(showToday?`<div class="gl gl-today" style="left:${pos(TODAY)}"></div>`:"");

  let labels="", lanes="";
  const row=(text,tip,col,indent,weight,italic,lane)=>{
    labels+=`<div class="lbl-row" style="padding-left:${indent}px;font-weight:${weight};font-style:${italic?"italic":"normal"}" title="${esc(tip)}"><span class="swatch" style="background:${col}"></span>${esc(text)}</div>`;
    lanes+=`<div class="tl-row">${lane}</div>`;
  };
  const bar=(kind,a,b,pct,col,tip)=>`<div class="bar-track ${kind}" style="left:${pos(a)};width:${span(a,b)};background:${prettyTint(col)}" title="${esc(tip)}"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${col}"></div></div>`;

  shown.forEach(g=>{
    const col=color(g), mine=vis.filter(t=>t.g===g.id), work=mine.filter(t=>!t.gate);
    const a=Math.min(...mine.map(t=>t.start)), b=Math.max(...mine.map(end));
    const days=work.reduce((s,t)=>s+t.dur,0);
    const pct=days?work.reduce((s,t)=>s+pctOf(t)*t.dur,0)/days:0;
    const tip=`${g.name} | ${fmtLong(a)} – ${fmtLong(b)} | ${Math.round(pct)}% complete`;
    row(g.name,tip,col,0,700,false,bar("bar-phase",a,b,pct,col,tip));
    phaseBlocks(g).forEach(({phase,items})=>{
      const sp=phaseSpan(items); if(!sp) return;
      const pw=items.filter(t=>!t.gate), pd=pw.reduce((s,t)=>s+t.dur,0);
      const pp=pd?pw.reduce((s,t)=>s+pctOf(t)*t.dur,0)/pd:0;
      const ptip=`${phase.name} | ${fmtLong(sp.a)} – ${fmtLong(sp.b)} | ${Math.round(pp)}% complete`;
      row(phase.name,ptip,col,16,700,false,bar("bar-phase",sp.a,sp.b,pp,col,ptip));
      const indent=30;
      if(!phasesOnly) items.forEach(t=>{
        const label=t.short||t.id;
        if(t.gate){
          const tip=`${label} | ${fmtLong(t.start)} – ${fmtLong(t.start)}`;
          row(label,tip,col,indent,600,true,`<div class="milestone" style="left:${pos(t.start)};background:${col}" title="${esc(tip)}"></div>`);
        } else {
          const p=pctOf(t), tip=`${label} |${fmtLong(t.start)} – ${fmtLong(end(t))} | ${Math.round(p)}% complete`;
          row(label,tip,col,indent,400,false,bar("bar-task",t.start,end(t),p,col,tip));
        }
      });
    });
  });

  const legend=shown.map(g=>`<span class="legend-item"><span class="swatch" style="background:${color(g)}"></span>${esc(g.name)}</span>`).join("");
  const note=(showToday?`Red line marks today (${fmtLong(TODAY)}). `:"")
    +"Bar shade shows % complete; in-progress tasks are shaded up to today."
    +(ownerFilter.size?" Showing only: "+[...ownerFilter].map(o=>esc(o||"Unassigned")).join(", ")+".":"");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(subtitle)} — ${esc(heading)}</title>
<style>${PRETTY_CSS}</style></head>
<body>
  ${eyebrow}
  <h1>${esc(heading)}</h1>
  <p class="subtitle">${esc(subtitle)}</p>

  <div class="header-row">
    <div class="col-labels">Task</div>
    <div class="col-timeline">${ticks}</div>
  </div>

  <div class="chart body">
    <div class="grid-overlay" style="left:var(--label-w)">${gl}</div>
    <div class="col-labels">${labels}</div>
    <div class="col-timeline">${lanes}</div>
  </div>

  <div class="legend">${legend}</div>
  <p class="footnote">${note}</p>
</body></html>`;
}
const prettyFrame=$("prettyframe"), prettyWrap=$("prettywrap");
function buildPretty(){
  prettyWrap.querySelectorAll("[data-p]").forEach(el=>{
    if(el!==document.activeElement) el.value=pretty[el.dataset.p]||"";
    if(el.dataset.p==="subtitle") el.placeholder=planTitle;
  });
  prettyFrame.srcdoc=prettyDoc();
}
prettyWrap.addEventListener("input", e=>{
  const k=e.target.dataset.p; if(!k) return;
  pretty[k]=e.target.value; buildPretty(); persist();
});
$("prettyhtml").addEventListener("click", ()=>{
  download(slug()+"-gantt.html", prettyDoc());
});
$("prettyprint").addEventListener("click", ()=>prettyFrame.contentWindow.print());

// ---- responsible filter -----------------------------------------------
const ownerBar=$("ownerbar");
function drawOwnerBar(){
  const counts=new Map();
  tasks.forEach(t=>counts.set(ownerKey(t),(counts.get(ownerKey(t))||0)+1));
  const named=[...counts.keys()].filter(Boolean).sort((a,b)=>a.localeCompare(b));
  ownerBar.hidden=!named.length;                // nothing to filter by
  const chip=o=>`<button data-owner="${esc(o)}" class="${ownerFilter.has(o)?"on":""}" aria-pressed="${ownerFilter.has(o)}">${esc(o||"Unassigned")}<span class="n">${counts.get(o)}</span></button>`;
  ownerBar.innerHTML=`<span class="lbl">Responsible</span>
    <button data-allowners class="${ownerFilter.size?"":"on"}" aria-pressed="${!ownerFilter.size}">All<span class="n">${tasks.length}</span></button>`
    +named.map(chip).join("")+(counts.has("")?chip(""):"");
}
function rerenderFiltered(){
  tip.classList.remove("on");
  refreshViews();
  if(view==="editor") edList();
}
// drop selections whose owner no longer exists, or the views would go blank
function syncOwners(){
  const live=new Set(tasks.map(ownerKey));
  const before=ownerFilter.size;
  [...ownerFilter].forEach(o=>{ if(!live.has(o)) ownerFilter.delete(o); });
  drawOwnerBar();
  if(ownerFilter.size!==before) rerenderFiltered();
}
ownerBar.addEventListener("click", e=>{
  const b=e.target.closest("button"); if(!b) return;
  if(b.dataset.owner===undefined) ownerFilter.clear();
  else if(!ownerFilter.delete(b.dataset.owner)) ownerFilter.add(b.dataset.owner);
  drawOwnerBar(); rerenderFiltered();
});

// ---- plan file in the vault --------------------------------------------
// The plan is a JSON file in the vault, so git syncs it with everything else.
const planPath=()=>normalizePath(plugin.settings.planPath||"gantt-plan.json");
const planDir=()=>{ const p=planPath(); return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""; };
let loaded=false, lastText=null, diskTimer=null, diskQ=Promise.resolve();
const clock=()=>{ const n=new Date(); return String(n.getHours()).padStart(2,"0")+":"+String(n.getMinutes()).padStart(2,"0"); };
// stable output: no timestamp, so git only sees real changes
const planText=()=>JSON.stringify({...snapshot(), savedAt:undefined},null,2)+"\n";
const validPlan=txt=>{ try{ return Array.isArray(JSON.parse(txt).tasks); }catch(e){ return false; } };
const conflictMsg=()=>setStatus(planPath()+" isn't valid (merge conflict?) — fix it; nothing is being saved", true);
const fileAt=p=>{ const f=app.vault.getAbstractFileByPath(normalizePath(p)); return f instanceof TFile ? f : null; };
async function readDisk(){ const f=fileAt(planPath()); return f ? app.vault.read(f) : null; }
async function ensureFolder(dir){
  if(!dir || app.vault.getAbstractFileByPath(dir)) return;
  try{ await app.vault.createFolder(dir); }
  catch(e){ if(!app.vault.getAbstractFileByPath(dir)) throw e; }
}
async function writeVault(path, text){
  path=normalizePath(path);
  const f=fileAt(path);
  if(f){ await app.vault.modify(f, text); return; }
  await ensureFolder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  await app.vault.create(path, text);
}
function afterLoad(){
  if(!byId[selId]) selId=null;
  computeRange(); buildLegend(); syncOwners(); refreshViews();
  if(view==="editor"){ edList(); edForm(); }
}
function applyDisk(txt){
  hydrate(JSON.parse(txt));
  lastText=txt;
  afterLoad();
  syncNotes();
  importNotes(taskNotes());
}
async function writeDisk(){
  if(!loaded) return;
  const text=planText(), disk=await readDisk();
  if(disk!==null && !validPlan(disk)){ conflictMsg(); return; }      // never overwrite a conflicted file
  if(disk===text){ lastText=text; setStatus("Saved "+clock()); syncNotes(); return; }
  if(disk!==null && disk!==lastText){              // something else (a git pull) changed it
    if(await confirmBox(planPath()+" changed on disk while you were editing — probably a git pull.",
                        "Load the version on disk", "Keep mine and overwrite")){
      applyDisk(disk); setStatus("Loaded the version on disk", false, true); return;
    }
  }
  lastText=text;                                   // set first, so our own modify event is ignored
  await writeVault(planPath(), text);
  setStatus("Saved "+clock());
  syncNotes();
}
const diskFail=e=>{ console.warn("gantt save failed:", e); setStatus("Couldn't save "+planPath()+" — "+e.message, true); };
function queueDiskSave(){
  clearTimeout(diskTimer);
  diskTimer=setTimeout(()=>{ diskTimer=null; diskQ=diskQ.then(writeDisk).catch(diskFail); }, 300);
}
// the plan file changed in the vault (git pull, sync, another device)
function checkDisk(){
  if(!loaded || diskTimer) return;
  diskQ=diskQ.then(async ()=>{
    if(!loaded || diskTimer) return;
    const disk=await readDisk();
    if(disk===null) return;
    if(disk===lastText){                         // unchanged; flush edits held back by a conflict
      if(planText()!==disk) queueDiskSave();
      return;
    }
    if(!validPlan(disk)){ conflictMsg(); return; }
    applyDisk(disk); setStatus("Reloaded — "+planPath()+" changed on disk", false, true);
  }).catch(diskFail);
}
async function loadPlan(){
  loaded=false; lastText=null; metaSeen.clear();
  let disk=null;
  try{ disk=await readDisk(); }catch(e){ diskFail(e); }
  if(disk===null){
    loadEmpty(); loaded=true; afterLoad();
    setStatus("New plan");
    importNotes(taskNotes());
    return;
  }
  lastText=disk;
  if(!validPlan(disk)){ loadEmpty(); loaded=true; afterLoad(); conflictMsg(); return; }
  hydrate(JSON.parse(disk)); loaded=true; afterLoad();
  setStatus("Loaded");
  syncNotes();
  importNotes(taskNotes());
  if(JSON.parse(disk).tasks.some(t=>"name" in t)) queueDiskSave();   // migrate old full names
}
obsView.registerEvent(app.vault.on("modify", f=>{ if(f.path===planPath()) checkDisk(); }));
obsView.registerEvent(app.vault.on("create", f=>{ if(f.path===planPath() && loaded) checkDisk(); }));
// keep links pointing at notes (and the plan) when they're renamed or moved in Obsidian
obsView.registerEvent(app.vault.on("rename", (file, oldPath)=>{
  if(oldPath===planPath()){ plugin.settings.planPath=file.path; plugin.saveSettings(); return; }
  let n=0;
  tasks.forEach(t=>{
    const lp=linkpath(t.link); if(!lp) return;
    const p=/\.md$/i.test(lp) ? lp : lp+".md";
    if(p===oldPath){ t.link=file.path.replace(/\.md$/i,""); n++; }
    else if(!(file instanceof TFile) && p.startsWith(oldPath+"/")){
      t.link=(file.path+p.slice(oldPath.length)).replace(/\.md$/i,""); n++;
    }
  });
  if(n){ metaSeen.clear(); refreshViews(); if(view==="editor") edForm(); persist();
         setStatus("Updated "+n+" link"+(n>1?"s":"")+" after a rename", false, true); }
  if(file instanceof TFile) importNotes([file]);
}));

// ---- task notes folder → tasks ------------------------------------------
// A note in the tasks folder whose frontmatter is in the planner's format becomes a task.
// Notes in any other shape are ignored. Already-linked notes are left to the normal sync.
const NOTE_STATE={"to do":"", doing:"progress", done:"done"};
const NOTE_PRIO={low:"low", normal:"", high:"high"};
const pendingNotes=new Set();                  // notes being created right now; not new tasks
const inTaskDir=f=>f instanceof TFile && f.extension==="md" && f.path.startsWith(taskDir()+"/");
const taskNotes=()=>app.vault.getMarkdownFiles().filter(inTaskDir);
const fmStr=v=>(typeof v==="string"||typeof v==="number") ? String(v).trim() : "";
const fmDate=v=>{
  if(v instanceof Date && !isNaN(v)) return Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  const s=fmStr(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(d(s)) ? d(s) : null;
};
// task fields from a note's frontmatter, or null if it isn't in the planner's format
function noteTask(fm){
  if(!fm) return null;
  const type=fmStr(fm.type).toLowerCase(), title=fmStr(fm.title), parent=fmStr(fm.parent), section=fmStr(fm.section);
  const status=fmStr(fm.status).toLowerCase(), prio=(fmStr(fm.priority)||"Normal").toLowerCase();
  if(!["task","milestone"].includes(type) || !title || !parent || !section) return null;
  if(!(status in NOTE_STATE) || !(prio in NOTE_PRIO)) return null;
  const due=fmDate(fm.deadline); if(due==null) return null;
  const gate=type==="milestone", start=gate ? due : fmDate(fm.start);
  if(start==null || start>due) return null;
  return { id:fmStr(fm.gantt_id), short:title, phase:parent, section, owner:fmStr(fm.owner),
           gate, start, dur:gate?0:Math.max(1, Math.round((due-start)/DAY)),
           state:NOTE_STATE[status], tag:NOTE_PRIO[prio] };
}
function ensureGroup(name){
  let g=groups.find(z=>z.name.toLowerCase()===name.toLowerCase());
  if(g) return g;
  let id=name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"section";
  const base=id; let n=2;
  while(groups.some(z=>z.id===id)) id=base+"-"+(n++);
  const used=groups.map(z=>z.c);
  g={ id, name, c:PALETTE.find(p=>!used.includes(p)) || EXTRA[groups.length%EXTRA.length], phases:[] };
  groups.push(g);
  return g;
}
function importNotes(files){
  if(!loaded) return;
  const known=new Set(tasks.map(t=>noteFile(t)).filter(Boolean).map(f=>f.path));
  let added=0, relinked=0;
  for(const f of files){
    if(!inTaskDir(f) || known.has(f.path) || pendingNotes.has(f.path)) continue;
    const nt=noteTask((app.metadataCache.getFileCache(f)||{}).frontmatter);
    if(!nt) continue;
    const link=f.path.replace(/\.md$/i,"");
    const prev=nt.id && byId[nt.id];
    if(prev && !noteFile(prev)){ prev.link=link; known.add(f.path); relinked++; continue; }   // task lost its link
    const g=ensureGroup(nt.section);
    tasks.push({ id:(nt.id && !byId[nt.id]) ? nt.id : nextId("t"), g:g.id, phase:ensurePhase(g, nt.phase).id,
      gate:nt.gate, short:nt.short, owner:nt.owner, start:nt.start, dur:nt.dur, deps:[],
      state:nt.state, tag:nt.tag, notes:"", link });
    reindex(); known.add(f.path); added++;
  }
  if(!added && !relinked) return;
  settle(); afterLoad(); persist();
  setStatus("Added "+added+" task"+(added===1?"":"s")+" from "+taskDir()+(relinked?", relinked "+relinked:""), false, true);
}
obsView.registerEvent(app.metadataCache.on("changed", f=>importNotes([f])));
obsView.registerEvent(app.metadataCache.on("resolved", ()=>importNotes(taskNotes())));

// tech tree: order within each column (columns themselves are dependency depth)
const PRIO_RANK={high:0, "":1, low:2};
const bySection=(a,b)=>groups.findIndex(g=>g.id===a.g)-groups.findIndex(g=>g.id===b.g);
const byPriority=(a,b)=>(PRIO_RANK[a.tag||""]??1)-(PRIO_RANK[b.tag||""]??1);
const byDate=(a,b)=>end(a)-end(b);                 // deadline: end date (a milestone's date)
let treeSort="section";
try{ const v=localStorage.getItem("gantt-planner.treesort"); if(["section","priority","date"].includes(v)) treeSort=v; }catch(e){}
function treeOrder(a,b){
  if(treeSort==="priority") return byPriority(a,b) || byDate(a,b) || bySection(a,b);
  if(treeSort==="date")     return byDate(a,b) || byPriority(a,b) || bySection(a,b);
  return bySection(a,b);
}
let showDone=false;
try{ showDone=localStorage.getItem("gantt-planner.showdone")==="1"; }catch(e){}
new DropdownComponent($("treesortbox"))
  .addOptions({ section:"Sort by section", priority:"Sort by priority", date:"Sort by end date" })
  .setValue(treeSort)
  .onChange(v=>{ treeSort=v; try{ localStorage.setItem("gantt-planner.treesort", v); }catch(e){} if(view==="tree") buildTree(); });
new ToggleComponent($("donebox")).setValue(showDone)
  .onChange(v=>{ showDone=v; try{ localStorage.setItem("gantt-planner.showdone", v?"1":"0"); }catch(e){} tip.classList.remove("on"); if(view==="tree") buildTree(); });
new ToggleComponent($("phasesbox")).setValue(phasesOnly)
  .onChange(v=>{ phasesOnly=v; tip.classList.remove("on"); refreshViews(); });

// ---- views ------------------------------------------------------------
function setView(v){
  view=v;
  root.querySelectorAll(".tabs button").forEach(b=>b.classList.toggle("on", b.dataset.view===v));
  scroller.hidden = v!=="timeline";
  treewrap.hidden = v!=="tree";
  $("editwrap").hidden = v!=="editor";
  prettyWrap.hidden = v!=="pretty";
  $("phasesbox").hidden = v!=="timeline" && v!=="pretty";
  $("treesortbox").hidden = v!=="tree";
  $("donebox").hidden = v!=="tree";
  tip.classList.remove("on");
  computeRange();
  if(v==="timeline"){ buildHead(); buildRows(); paint(); }
  if(v==="tree") buildTree();
  if(v==="editor"){ edList(); edForm(); }
  if(v==="pretty") buildPretty();
}
root.querySelector(".tabs").addEventListener("click", e=>{
  const v=e.target.dataset.view; if(v) setView(v);
});

// ---- CSV --------------------------------------------------------------
const COLS=["id","group","name","owner","start","duration_days","depends_on","state","priority","kind","notes","plan_title","phase","obsidian_link","deadline"];
const phaseName = t => (phaseOf(t)||{}).name||"";
const csvq = v => /[",\n]/.test(String(v)) ? '"'+String(v).replace(/"/g,'""')+'"' : String(v);

// exports are written into the vault, next to the plan file
async function download(name, text){
  const p=normalizePath((planDir() ? planDir()+"/" : "")+name);
  try{ await writeVault(p, text); new Notice("Saved "+p); setStatus("Written to "+p, false, true); }
  catch(e){ setStatus("Couldn't write "+p+" — "+e.message, true); }
}
$("export").addEventListener("click", ()=>{
  const lines=[COLS.join(",")];
  tasks.forEach((t,i)=>lines.push([t.id, t.g, t.short||"", t.owner||"", iso(t.start),
    t.gate?0:t.dur, (t.deps||[]).join(" "), t.state||"", t.tag||"", t.gate?"gate":"task", t.notes||"",
    i===0?planTitle:"", phaseName(t), t.link||"", t.deadline!=null?iso(t.deadline):""].map(csvq).join(",")));
  download(slug()+".csv", lines.join("\n"), "text/csv;charset=utf-8");
});
$("exportop").addEventListener("click", ()=>{
  // sections become summary tasks, phases become phases, tasks sit in their phase
  const num={}; let n=1;
  groups.forEach(g=>{ num["sec:"+g.id]=n++; (g.phases||[]).forEach(ph=>num["ph:"+ph.id]=n++); });
  order.forEach(id=>{ if(!num[id]) num[id]=n++; });
  const h=["ID","Type","Subject","Start date","Finish date","Duration","Assignee","Priority","Status","Parent","Relations"];
  const out=[h.join(",")];
  groups.forEach(g=>{
    out.push([num["sec:"+g.id],"Summary task",g.name,"","","","","","New","",""].map(csvq).join(","));
    (g.phases||[]).forEach(ph=>{
      const sp=phaseSpan(tasks.filter(t=>t.phase===ph.id));
      out.push([num["ph:"+ph.id],"Phase",ph.name,sp?iso(sp.a):"",sp?iso(sp.b):"","","","","New",num["sec:"+g.id],""].map(csvq).join(","));
    });
  });
  tasks.forEach(t=>{
    const rel=(t.deps||[]).filter(p=>num[p]).map(p=>"follows "+num[p]).join(", ");
    out.push([num[t.id], t.gate?"Milestone":"Task", t.short||t.id, iso(t.start), iso(end(t)),
      t.gate?"":t.dur, t.owner||"", t.tag==="low"?"Low":t.tag==="high"?"High":"Normal",
      t.state==="done"?"Closed":t.state==="progress"?"In progress":"New",
      num["ph:"+t.phase], rel].map(csvq).join(","));
  });
  download(slug()+"-openproject.csv", "﻿"+out.join("\n"), "text/csv;charset=utf-8");
});



// ---- zoom -------------------------------------------------------------
const ZMIN=0.22, ZMAX=26;
function rememberZoom(){ try{ localStorage.setItem("gantt-planner.zoom", String(PXD)); }catch(e){} }
function setZoom(next, clientX){
  next=Math.min(ZMAX, Math.max(ZMIN, next));
  if(Math.abs(next-PXD)<1e-6) return;
  const rect=scroller.getBoundingClientRect();
  const atX = (clientX==null) ? rect.width/2 + rect.left : clientX;     // viewport anchor
  const offs = atX - rect.left;                                         // px from the pane's left edge
  const held = T0 + ((scroller.scrollLeft + offs - LANE)/PXD)*DAY;      // date under the cursor
  PXD=next;
  buildHead(); buildRows(); paint();
  scroller.scrollLeft = Math.max(0, LANE + x(held) - offs);
  rememberZoom();
}
function fitZoom(){
  const days=(T1-T0)/DAY;
  if(days>0) setZoom((scroller.clientWidth - LANE - 24)/days, null);
}
scroller.addEventListener("wheel", e=>{
  if(view!=="timeline") return;
  if(e.ctrlKey && !e.shiftKey){                       // pinch / ctrl-wheel also zooms
    e.preventDefault(); setZoom(PXD*Math.exp(-e.deltaY*0.01), e.clientX); return;
  }
  if(e.shiftKey) return;                              // shift+wheel keeps normal scrolling
  const overLane = (e.clientX - scroller.getBoundingClientRect().left) > LANE;
  if(!overLane) return;                               // label column scrolls as usual
  if(Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // trackpad sideways pan passes through
  e.preventDefault();
  const step = e.deltaY * (e.deltaMode===1 ? 16 : e.deltaMode===2 ? 400 : 1);
  setZoom(PXD*Math.exp(-step*0.0016), e.clientX);
}, {passive:false});
obsView.registerDomEvent(document, "keydown", e=>{
  if(app.workspace.getActiveViewOfType(GanttView)!==obsView) return;   // only the focused planner
  if(view!=="timeline") return;
  const el=e.target;
  if(el && el.closest && el.closest("input, textarea, select, [contenteditable]")) return;
  if(e.key==="+"||e.key==="="){ e.preventDefault(); setZoom(PXD*1.3, null); }
  if(e.key==="-"||e.key==="_"){ e.preventDefault(); setZoom(PXD/1.3, null); }
  if(e.key==="0"){ e.preventDefault(); fitZoom(); }
});

// ---- start ----------------------------------------------------------------
return {
  async start(){
    await loadPlan();
    scroller.scrollLeft=Math.max(0, x(TODAY)-300);
  },
  reload: loadPlan,
};
}

class GanttView extends ItemView {
  constructor(leaf, plugin){ super(leaf); this.plugin=plugin; this.planner=null; }
  getViewType(){ return VIEW_TYPE; }
  getDisplayText(){ return "Gantt planner"; }
  getIcon(){ return "calendar-range"; }
  async onOpen(){
    this.contentEl.empty();
    this.contentEl.addClass("gantt-planner");
    this.planner=mountPlanner(this.contentEl, this, this.plugin);
    await this.planner.start();
  }
  async onClose(){ this.planner=null; this.contentEl.empty(); }
}

class GanttSettingTab extends PluginSettingTab {
  constructor(app, plugin){ super(app, plugin); this.plugin=plugin; }
  display(){
    const el=this.containerEl; el.empty();
    const field=(name, desc, key, placeholder)=>new Setting(el).setName(name).setDesc(desc).addText(t=>{
      t.setPlaceholder(placeholder).setValue(this.plugin.settings[key]);
      t.onChange(async v=>{ this.plugin.settings[key]=v.trim()||DEFAULT_SETTINGS[key]; await this.plugin.saveSettings(); });
      t.inputEl.addEventListener("blur", ()=>this.plugin.reloadViews());
    });
    field("Plan file", "Vault path of the JSON file the plan is saved in. Commit it to git to share the plan.", "planPath", DEFAULT_SETTINGS.planPath);
    field("Tasks folder", "Notes here with the planner's frontmatter (see the README) become tasks. Double-clicking a task creates its note here.", "taskDir", DEFAULT_SETTINGS.taskDir);
  }
}

module.exports = class GanttPlugin extends Plugin {
  async onload(){
    this.settings=Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.registerView(VIEW_TYPE, leaf=>new GanttView(leaf, this));
    this.addRibbonIcon("calendar-range", "Open Gantt planner", ()=>this.activateView());
    this.addCommand({ id:"open-gantt-planner", name:"Open Gantt planner", callback:()=>this.activateView() });
    this.addSettingTab(new GanttSettingTab(this.app, this));
  }
  async saveSettings(){ await this.saveData(this.settings); }
  reloadViews(){
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(l=>{ if(l.view.planner) l.view.planner.reload(); });
  }
  async activateView(){
    const ws=this.app.workspace;
    let leaf=ws.getLeavesOfType(VIEW_TYPE)[0];
    if(!leaf){ leaf=ws.getLeaf(true); await leaf.setViewState({ type:VIEW_TYPE, active:true }); }
    ws.revealLeaf(leaf);
  }
};
