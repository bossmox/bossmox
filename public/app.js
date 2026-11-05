const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const GLYPHS = {
  vms: '<rect x="4" y="5" width="24" height="16" rx="2"/><path d="M11 27h10M16 21v6"/><path d="M12 13l3 3 5-6"/>',
  create: '<path d="M16 6v20M6 16h20"/>',
  monitor: '<path d="M4 17h6l3-9 5 16 3-7h7"/>',
  storage: '<ellipse cx="16" cy="8" rx="11" ry="4"/><path d="M5 8v16c0 2 5 4 11 4s11-2 11-4V8M5 16c0 2 5 4 11 4s11-2 11-4"/>',
  network: '<circle cx="16" cy="6" r="3"/><circle cx="6" cy="25" r="3"/><circle cx="26" cy="25" r="3"/><path d="M16 9v8M16 17H6v5M16 17h10v5"/>',
  backups: '<path d="M5 16a11 11 0 1 0 4-8.5L5 11V5"/><path d="M16 10v7l5 3"/>',
};
const APPS = {
  vms: { title: "Virtual Machines", color: "#0E7EA6", w: 920, h: 610 },
  create: { title: "Create a VM", color: "#178A5F", w: 460, h: 250 },
  monitor: { title: "Servers", color: "#7A5AC8", w: 720, h: 460 },
  storage: { title: "Storage", color: "#B9680A", w: 520, h: 420 },
  network: { title: "Network", color: "#2F7A7E", w: 460, h: 250 },
  backups: { title: "Backups", color: "#C43838", w: 460, h: 250 },
};

const S = { data: null, sel: null, tab: "overview", filter: "all", q: "", z: 100, failed: false };
const wins = {};

/* Desktop */
$("#icons").innerHTML = Object.entries(APPS).map(([k, a]) => `
  <button class="icon" data-open="${k}"><span class="tile" style="background:${a.color}"><svg viewBox="0 0 32 32">${GLYPHS[k]}</svg></span>${a.title}</button>`).join("");

const count = (n) => ["No things", "One thing", "Two things", "Three things"][n] ?? `${n} things`;
function renderHealth() {
  const h = $("#health");
  if (!S.data) {
    h.innerHTML = S.failed
      ? `<h1>Can't reach Proxmox</h1><p class="sub">${esc(S.failed)}</p><p class="meta">Trying again every 10 seconds.</p>`
      : `<h1>Connecting to Proxmox</h1>`;
    return;
  }
  const { nodes, vms, storage, issues } = S.data;
  const up = nodes.filter((n) => n.online).length;
  const run = vms.filter((v) => v.running).length;
  const free = storage.reduce((sum, s) => sum + s.freeGb, 0);
  const freeText = free >= 1024 ? `${(free / 1024).toFixed(1)} TB` : `${Math.round(free)} GB`;
  h.innerHTML = `
    <h1>${issues.length ? `${count(issues.length)} worth a look` : "Everything looks good"}</h1>
    <p class="sub">${up} of ${nodes.length} ${nodes.length === 1 ? "server" : "servers"} online. ${run} of ${vms.length} ${vms.length === 1 ? "VM" : "VMs"} running, and ${freeText} free.</p>
    <div class="rack">${nodes.map((n) => {
      const on = vms.filter((v) => v.node === n.name);
      return `<button class="ru" data-open="monitor"><span>${esc(n.name)}</span>
        <span class="leds">${on.map((v) => `<i class="${!v.running ? "off" : v.issues.length ? "w" : ""}"></i>`).join("")}</span>
        <small>${n.online ? `${n.cpuPct}% busy` : "Offline"}</small></button>`;
    }).join("")}</div>
    ${issues.length ? `<div class="look-items">${issues.map((i) => `<button class="look-item" ${i.vmId ? `data-vm="${i.vmId}"` : 'data-open="storage"'}><span class="dot warn"></span><span>${esc(i.title)}</span></button>`).join("")}</div>` : ""}`;
}

/* Window manager */
function openWin(app) {
  if (wins[app]) {
    wins[app].classList.remove("hidden");
    focusWin(app);
    return;
  }
  const a = APPS[app];
  const n = Object.keys(wins).length;
  const el = document.createElement("section");
  el.className = "win";
  el.setAttribute("aria-label", a.title);
  const vw = innerWidth, vh = innerHeight, w = Math.min(a.w, vw - 40), h = Math.min(a.h, vh - 90);
  el.style.cssText = `width:${w}px;height:${h}px;left:${Math.max(20, (vw - w) / 2 - 120 + n * 30)}px;top:${Math.max(58, (vh - h) / 2 - 10 + n * 26)}px`;
  el.innerHTML = `<div class="tbar"><span>${a.title}</span>
    <button class="wbtn" data-min="${app}" aria-label="Minimize ${a.title}"><svg viewBox="0 0 16 16"><path d="M3 12h10"/></svg></button>
    <button class="wbtn" data-close="${app}" aria-label="Close ${a.title}"><svg viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13"/></svg></button></div>
    <div class="wbody"></div>`;
  $("#windows").append(el);
  wins[app] = el;
  el.addEventListener("pointerdown", () => focusWin(app));
  drag(el, $(".tbar", el));
  render(app);
  focusWin(app);
}
function focusWin(app) {
  wins[app].style.zIndex = ++S.z;
  renderTasks(app);
}
function renderTasks(active) {
  const top = active || Object.keys(wins).filter((k) => !wins[k].classList.contains("hidden")).sort((a, b) => wins[b].style.zIndex - wins[a].style.zIndex)[0];
  $("#tasks").innerHTML = Object.keys(wins).map((k) => `<button class="task ${k === top ? "on" : ""}" data-open="${k}">${APPS[k].title}</button>`).join("");
}
function drag(el, handle) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || innerWidth <= 760) return;
    const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
    handle.setPointerCapture(e.pointerId);
    const move = (m) => {
      el.style.left = Math.min(innerWidth - 120, Math.max(-200, m.clientX - sx)) + "px";
      el.style.top = Math.min(innerHeight - 60, Math.max(46, m.clientY - sy)) + "px";
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}
function render(app) {
  const w = wins[app];
  if (!w) return;
  $(".wbody", w).innerHTML = RENDER[app]();
  if (app === "vms") {
    renderList();
    renderDetail();
  }
}

/* Virtual Machines */
const selected = () => S.data?.vms.find((v) => v.id === S.sel) ?? null;
const dotClass = (v) => (v.issues.length ? "warn" : v.running ? "running" : "");
const stateWord = (v) => `${v.running ? "Running" : "Shut down"} on ${v.node}`;

function vmsShell() {
  return `<div class="vms"><aside>
    <div class="tools"><input class="search" id="vmq" type="search" placeholder="Find a VM" aria-label="Find a VM" value="${esc(S.q)}">
    <div class="seg" id="seg"></div></div>
    <div id="vmlist"></div></aside><div id="vmdetail"></div></div>`;
}
function renderList() {
  if (!$("#vmlist")) return;
  $("#seg").innerHTML = [["all", "All"], ["running", "Running"], ["look", "Needs a look"]]
    .map(([k, l]) => `<button class="${S.filter === k ? "on" : ""}" data-filter="${k}">${l}</button>`).join("");
  if (!S.data) {
    $("#vmlist").innerHTML = `<p class="empty">Waiting for Proxmox.</p>`;
    return;
  }
  const q = S.q.toLowerCase();
  const list = S.data.vms.filter((v) => (S.filter === "all" || (S.filter === "running" && v.running) || (S.filter === "look" && v.issues.length)) && (v.name + v.os).toLowerCase().includes(q));
  $("#vmlist").innerHTML = list.length
    ? list.map((v) => `<button class="row ${v.id === S.sel ? "on" : ""}" data-pick="${v.id}">
      <span class="dot ${dotClass(v)}"></span><b>${esc(v.name)}</b><small>${esc(stateWord(v))}</small></button>`).join("")
    : `<p class="empty">No VMs match. Try a different word or filter.</p>`;
}
function renderDetail() {
  const box = $("#vmdetail");
  if (!box) return;
  const v = selected();
  if (!v) {
    box.innerHTML = `<p class="empty">${S.data?.vms.length ? "Pick a VM to see its details." : "There are no VMs on this server yet."}</p>`;
    return;
  }
  box.innerHTML = `
    <div class="head"><div><h2>${esc(v.name)}</h2>
      <div class="state"><span class="dot ${dotClass(v)}"></span>${esc(stateWord(v))}</div></div></div>
    <div class="tabs" role="tablist">${[["overview", "Overview"], ["snapshots", "Snapshots"], ["settings", "Settings"]].map(([k, l]) => `<button role="tab" aria-selected="${S.tab === k}" class="${S.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
    <div class="tabpane">${TAB[S.tab](v)}</div>`;
}
const when = (t) => (t ? new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Time not recorded");
const TAB = {
  overview: (v) => `
    ${v.issues.map((i) => `<div class="advice"><div><b>${esc(i.title)}</b>${esc(i.detail)}</div></div>`).join("")}
    <div class="facts">
      <div class="fact"><label>Processor</label><b>${v.cpuPct}% busy</b><div class="meter"><i style="width:${Math.min(v.cpuPct, 100)}%"></i></div></div>
      <div class="fact"><label>Memory</label><b>${v.memUsedGb} of ${v.memTotalGb} GB</b><div class="meter"><i style="width:${v.memTotalGb ? Math.min((v.memUsedGb / v.memTotalGb) * 100, 100) : 0}%"></i></div></div>
      <div class="fact"><label>Disk size</label><b>${v.diskGb} GB</b></div>
    </div>
    <dl class="plain">
      <dt>Type</dt><dd>${esc(v.kind)}</dd>
      <dt>Operating system</dt><dd>${esc(v.os)}</dd>
      <dt>Processor cores</dt><dd>${v.cores}</dd>
      <dt>Starts at boot</dt><dd>${v.startsAtBoot ? "Yes" : "No"}</dd>
      <dt>Snapshots</dt><dd>${v.snapshots.length || "None"}</dd>
    </dl>`,
  snapshots: (v) => v.snapshots.length
    ? v.snapshots.map((s) => `<div class="snap"><div>${esc(s.name)}<small>${esc(s.description || when(s.takenAt))}</small></div></div>`).join("")
    : `<p class="empty">This VM has no snapshots.</p>`,
  settings: (v) => `<div class="raw">${Object.entries(v.tech).map(([k, val]) => `<span>${esc(k)}</span><code>${esc(val)}</code>`).join("")}</div>
    ${v.configLoaded ? "" : `<p class="meta">Proxmox didn't return this VM's settings.</p>`}`,
};

/* Servers and Storage */
function monView() {
  if (!S.data) return `<p class="empty">Waiting for Proxmox.</p>`;
  return `<div class="mon">${S.data.nodes.map((n) => {
    const on = S.data.vms.filter((v) => v.node === n.name);
    return `<article class="server"><header><span>${esc(n.name)}</span><small>${n.online ? `${n.cpuPct}% busy, ${n.memUsedGb} of ${n.memTotalGb} GB memory, ${on.filter((v) => v.running).length} running` : "Offline"}</small></header>
    <div class="bays">${on.map((v) => `<button class="bay ${v.running ? "" : "stopped"} ${v.issues.length ? "warn" : ""}" data-vm="${v.id}"><i></i>${esc(v.name)}</button>`).join("")}<span class="spare"></span></div></article>`;
  }).join("")}</div>`;
}
function storeView() {
  if (!S.data) return `<p class="empty">Waiting for Proxmox.</p>`;
  return `<div class="store">${S.data.storage.map((s) => `<div><b>${esc(s.name)}</b><small>${s.freeGb} GB free of ${s.totalGb} GB, on ${esc(s.node)}${s.online ? "" : ", not available"}</small><div class="meter"><i style="width:${s.usedPct}%"></i></div></div>`).join("")}</div>`;
}
const soon = (t, line) => () => `<div class="soon"><h2>${t}</h2><p>${line}</p></div>`;
const RENDER = {
  vms: vmsShell, monitor: monView, storage: storeView,
  create: soon("Create a VM", "This version is read only. Creating VMs comes after the test server is set up."),
  network: soon("Network", "Not built yet."),
  backups: soon("Backups", "Not built yet."),
};

/* Events */
document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.open) return openWin(d.open);
  if (d.close) {
    wins[d.close].remove();
    delete wins[d.close];
    return renderTasks();
  }
  if (d.min) {
    wins[d.min].classList.add("hidden");
    return renderTasks();
  }
  if (d.vm) {
    S.sel = +d.vm;
    S.tab = "overview";
    S.filter = "all";
    S.q = "";
    openWin("vms");
    return render("vms");
  }
  if (d.pick) {
    S.sel = +d.pick;
    S.tab = "overview";
    renderList();
    return renderDetail();
  }
  if (d.filter) {
    S.filter = d.filter;
    return renderList();
  }
  if (d.tab) {
    S.tab = d.tab;
    return renderDetail();
  }
  if (d.look) setLook(d.look);
});
document.addEventListener("input", (e) => {
  if (e.target.id === "vmq") {
    S.q = e.target.value;
    renderList();
  }
});

/* Look picker: remembered per browser */
const LOOKS = [["daylight", "Daylight"], ["dusk", "Dusk"], ["workbench", "Workbench"]];
function setLook(k) {
  document.documentElement.dataset.look = k;
  try { localStorage.setItem("bossmox-look", k); } catch { /* still works, just not remembered */ }
  document.querySelectorAll("#looks button").forEach((b) => b.classList.toggle("on", b.dataset.look === k));
}
$("#looks").insertAdjacentHTML("beforeend", LOOKS.map(([k, l]) => `<button data-look="${k}">${l}</button>`).join(""));

function tick() {
  $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/* Signing in */
const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-BossMox": "1" }, body: JSON.stringify(body) });
let challenge = null;
let polling = null;

function showError(text) {
  const e = $("#loginerr");
  e.hidden = !text;
  e.textContent = text || "";
}
function setStep(two) {
  $("#stepone").hidden = two;
  $("#steptwo").hidden = !two;
  $("#lcode").required = two;
  $("#luser").required = !two;
  $("#lpass").required = !two;
  $("#lgo").textContent = two ? "Confirm" : "Sign in";
  $("#loginsub").textContent = two ? "Your account uses two-factor sign-in." : "BossMox uses your Proxmox login and permissions.";
  (two ? $("#lcode") : $("#luser")).focus();
}
async function showLogin(message) {
  clearInterval(polling);
  polling = null;
  S.data = null;
  S.sel = null;
  Object.keys(wins).forEach((k) => {
    wins[k].remove();
    delete wins[k];
  });
  renderTasks();
  challenge = null;
  $("#desk").hidden = true;
  $("#who").hidden = true;
  $("#signout").hidden = true;
  $("#stale").hidden = true;
  $("#login").hidden = false;
  $("#lpass").value = "";
  $("#lcode").value = "";
  setStep(false);
  showError(message);
  try {
    const res = await fetch("api/login-info");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    const rank = (r) => (r.default ? 2 : r.realm === "pam" ? 1 : 0);
    const realms = [...body.realms].sort((a, b) => rank(b) - rank(a));
    $("#lrealm").innerHTML = realms.map((r) => `<option value="${esc(r.realm)}">${esc(r.comment || r.realm)}</option>`).join("");
  } catch (err) {
    showError(`BossMox can't reach Proxmox right now. ${err.message || ""}`);
  }
}
function showDesk() {
  $("#login").hidden = true;
  $("#desk").hidden = false;
  $("#signout").hidden = false;
  showError("");
  refresh();
  polling ??= setInterval(refresh, 10000);
}
$("#loginform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const go = $("#lgo");
  go.disabled = true;
  showError("");
  try {
    const res = challenge
      ? await post("api/login/code", { challenge, code: $("#lcode").value })
      : await post("api/login", { username: $("#luser").value.trim(), realm: $("#lrealm").value, password: $("#lpass").value });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    $("#lpass").value = "";
    if (body.needsCode) {
      challenge = body.challenge;
      setStep(true);
    } else {
      challenge = null;
      showDesk();
    }
  } catch (err) {
    $("#lpass").value = "";
    $("#lcode").value = "";
    showError(err.message || "BossMox couldn't reach Proxmox.");
  } finally {
    go.disabled = false;
  }
});
$("#signout").addEventListener("click", async () => {
  try { await post("api/logout", {}); } finally { showLogin(); }
});

/* Live data */
async function refresh() {
  let error = "";
  try {
    const res = await fetch("api/overview");
    const body = await res.json();
    if (res.status === 401) {
      showLogin(S.data ? "You've been signed out. Sign in again to continue." : "");
      return;
    }
    if (!res.ok) throw new Error(body.error);
    S.data = body;
    $("#who").textContent = body.username;
    $("#who").hidden = false;
    $("#login").hidden = true;
    $("#desk").hidden = false;
    $("#signout").hidden = false;
    polling ??= setInterval(refresh, 10000);
    if (S.sel === null && body.vms[0]) S.sel = body.vms[0].id;
    S.failed = false;
  } catch (err) {
    error = err.message || "BossMox couldn't get an answer.";
    S.failed = error;
  }
  const stale = $("#stale");
  stale.hidden = !(error && S.data);
  stale.textContent = "Showing old data, lost contact with Proxmox";
  renderHealth();
  renderList();
  if (S.tab !== "settings") renderDetail();
  render("monitor");
  render("storage");
}

const q = new URLSearchParams(location.search);
let saved = null;
try { saved = localStorage.getItem("bossmox-look"); } catch { /* use the default */ }
setLook(q.get("look") || saved || "daylight");
tick();
setInterval(tick, 20000);
refresh();
