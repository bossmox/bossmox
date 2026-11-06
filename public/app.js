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
  monitor: { title: "Servers", color: "#7A5AC8", w: 900, h: 620 },
  storage: { title: "Storage", color: "#B9680A", w: 520, h: 420 },
  network: { title: "Network", color: "#2F7A7E", w: 460, h: 250 },
  backups: { title: "Backups", color: "#C43838", w: 460, h: 250 },
  terminal: { title: "Install updates", color: "#20262A", w: 860, h: 560, noIcon: true },
};

const S = { watching: false, data: null, sel: null, tab: "overview", filter: "all", q: "", z: 100, failed: false, server: null, serverTab: "overview", detail: null, detailError: "", ticks: 0 };
const wins = {};

/* Desktop */
$("#icons").innerHTML = Object.entries(APPS).filter(([, a]) => !a.noIcon).map(([k, a]) => `
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
      return `<button class="ru" data-server="${esc(n.name)}"><span>${esc(n.name)}</span>
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
  if (app === "monitor") renderServers();
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
  return `<div class="vms"><aside><div id="srvlist"></div></aside><div id="srvdetail"></div></div>`;
}
const signal = (url) => fetch(url).then(async (res) => {
  const body = await res.json();
  if (res.status === 401) {
    showLogin(savedReboot() ? "BossMox restarted too. Sign in to finish checking the server." : "You've been signed out. Sign in again to continue.");
    throw new Error("signed out");
  }
  if (!res.ok) throw new Error(body.error);
  return body;
});
async function loadServer() {
  const name = S.server;
  if (!name) return;
  try {
    const body = await signal(`api/server?name=${encodeURIComponent(name)}`);
    if (name !== S.server) return;
    const changed = JSON.stringify(body) !== JSON.stringify(S.detail);
    S.detail = body;
    S.detailError = "";
    if (changed) renderServerDetail();
  } catch (err) {
    S.detailError = err.message || "BossMox couldn't get this server's details.";
    if (!S.detail) renderServerDetail();
  }
}
function pickServer(name) {
  if (name !== S.server) {
    S.server = name;
    S.detail = null;
    S.detailError = "";
  }
  S.serverTab = "overview";
  renderServers();
  renderServerDetail();
  loadServer();
}
function renderServers() {
  const list = $("#srvlist");
  if (!list) return;
  if (!S.data) {
    list.innerHTML = `<p class="empty">Waiting for Proxmox.</p>`;
    return;
  }
  if (!S.server && S.data.nodes[0]) {
    pickServer(S.data.nodes[0].name);
    return;
  }
  list.innerHTML = S.data.nodes.map((n) => `<button class="row ${n.name === S.server ? "on" : ""}" data-server="${esc(n.name)}">
    <span class="dot ${n.online ? "running" : "warn"}"></span><b>${esc(n.name)}</b><small>${n.online ? `${n.cpuPct}% busy, ${n.memPct}% memory` : "Offline"}</small></button>`).join("");
  if (S.serverTab === "overview") renderServerDetail();
}
const noAccess = (what, perm) => `<p class="empty">Your Proxmox account can't see ${what}. It needs ${perm} on this server.</p>`;
const SERVER_TAB = {
  overview: (d, node) => {
    const on = S.data?.vms.filter((v) => v.node === d.name) ?? [];
    const a = d.summary;
    return `
    ${d.channel && !d.channel.ok ? `<div class="advice"><div><b>Updates can't download</b>${esc(d.channel.note)}</div></div>` : ""}
    ${d.updates?.total ? `<div class="advice"><div><b>${d.updates.total} ${d.updates.total === 1 ? "update is" : "updates are"} waiting</b>${d.updates.rebootNeeded ? "This includes a new kernel, so the server will need a restart." : "No restart should be needed."}</div><button class="btn" data-servertab="updates">See updates</button></div>` : ""}
    ${a ? `<div class="facts">
      <div class="fact"><label>Processor</label><b>${node?.cpuPct ?? 0}% busy</b><div class="meter"><i style="width:${Math.min(node?.cpuPct ?? 0, 100)}%"></i></div></div>
      <div class="fact"><label>Memory</label><b>${a.memUsedGb} of ${a.memTotalGb} GB</b><div class="meter"><i style="width:${a.memTotalGb ? (a.memUsedGb / a.memTotalGb) * 100 : 0}%"></i></div></div>
      <div class="fact"><label>System disk</label><b>${a.diskUsedGb} of ${a.diskTotalGb} GB</b><div class="meter"><i style="width:${a.diskTotalGb ? (a.diskUsedGb / a.diskTotalGb) * 100 : 0}%"></i></div></div>
    </div>
    <dl class="plain">
      <dt>Proxmox version</dt><dd>${esc(a.proxmoxVersion)}</dd>
      <dt>Kernel</dt><dd>${esc(a.kernel)}</dd>
      <dt>Running for</dt><dd>${esc(a.uptime)}</dd>
      <dt>Processor</dt><dd>${esc(a.processor)}, ${a.cpus} threads</dd>
      ${d.channel ? `<dt>Update channel</dt><dd>${esc(d.channel.name)}</dd>` : ""}
    </dl>` : noAccess("this server's status", "Sys.Audit")}
    <article class="server" style="margin-top:20px"><header><span>Running here</span><small>${on.filter((v) => v.running).length} of ${on.length}</small></header>
      <div class="bays">${on.map((v) => `<button class="bay ${v.running ? "" : "stopped"} ${v.issues.length ? "warn" : ""}" data-vm="${v.id}"><i></i>${esc(v.name)}</button>`).join("")}<span class="spare"></span></div></article>`;
  },
  updates: (d) => {
    if (!d.updates) return noAccess("waiting updates", "Sys.Modify");
    const group = (title, items, open) => items.length ? `<details class="upgroup" ${open ? "open" : ""}><summary>${title} (${items.length})</summary>
      ${items.map((u) => `<div class="snap"><div>${esc(u.name)}<small>${esc(u.title)}</small></div><code class="ver">${esc(u.from)} to ${esc(u.to)}</code></div>`).join("")}</details>` : "";
    return `
    <div class="head"><div>${d.channel ? `<p class="meta" style="margin-top:0">Update channel: ${esc(d.channel.name)}. ${esc(d.channel.note)}</p>` : ""}</div>
      <div class="actions"><button class="btn" data-check="${esc(d.name)}">Check for updates</button>${d.updates.total ? `<button class="btn primary" data-install="${esc(d.name)}">Install updates</button>` : ""}</div></div>
    ${d.updates.total ? `<p style="margin-top:10px"><b>${d.updates.total} waiting.</b> ${d.updates.rebootNeeded ? "The new kernel means a restart afterward." : "No restart should be needed."}</p>
      ${group("Kernel", d.updates.kernel, true)}${group("Proxmox", d.updates.proxmox, true)}${group("Everything else", d.updates.other, false)}
      <p class="meta">This list is from the server's last check for updates.</p>` : `<p class="empty">This server is up to date as of its last check for updates.</p>`}`;
  },
  services: (d) => {
    if (!d.services) return noAccess("services", "Sys.Audit");
    const off = d.services.filter((v) => v.enabled && !v.running);
    return `${off.length ? `<div class="advice"><div><b>${off.length} ${off.length === 1 ? "service should be running but isn't" : "services should be running but aren't"}</b>${off.map((v) => esc(v.name)).join(", ")}</div></div>` : ""}
    ${d.services.map((v) => `<div class="snap"><div>${esc(v.name)}</div><span class="state"><span class="dot ${v.running ? "running" : v.enabled ? "warn" : ""}"></span>${v.running ? "Running" : v.enabled ? "Stopped" : "Off"}</span></div>`).join("")}`;
  },
  activity: (d) => {
    if (!d.tasks) return noAccess("recent activity", "Sys.Audit");
    if (!d.tasks.length) return `<p class="empty">No recent activity on this server.</p>`;
    const words = { running: "Running", ok: "Finished", warning: "Finished with warnings", failed: "Failed" };
    const dots = { running: "busy", ok: "running", warning: "warn", failed: "warn" };
    return d.tasks.map((t) => `<div class="snap"><div>${esc(t.what)}${t.target ? ` on ${esc(t.target)}` : ""}<small>${esc(when(t.startedAt))}, by ${esc(t.who)}</small></div><span class="state"><span class="dot ${dots[t.result]}"></span>${words[t.result]}</span></div>`).join("");
  },
};
function renderServerDetail() {
  const box = $("#srvdetail");
  if (!box) return;
  if (!S.server) {
    box.innerHTML = `<p class="empty">Pick a server to see its details.</p>`;
    return;
  }
  const node = S.data?.nodes.find((n) => n.name === S.server);
  const d = S.detail;
  const body = d ? SERVER_TAB[S.serverTab](d, node) : S.detailError ? `<p class="empty">${esc(S.detailError)}</p>` : `<p class="empty">Loading this server's details.</p>`;
  const top = box.scrollTop;
  box.innerHTML = `
    <div class="head"><div><h2>${esc(S.server)}</h2>
      <div class="state"><span class="dot ${node?.online ? "running" : "warn"}"></span>${node?.online ? "Online" : "Offline"}${d?.summary ? `, running for ${esc(d.summary.uptime)}` : ""}</div></div>
      <div class="actions"><button class="btn danger" data-restartserver="${esc(S.server)}">Restart</button></div></div>
    <div class="tabs" role="tablist">${[["overview", "Overview"], ["updates", d?.updates?.total ? `Updates (${d.updates.total})` : "Updates"], ["services", "Services"], ["activity", "Activity"]].map(([k, l]) => `<button role="tab" aria-selected="${S.serverTab === k}" class="${S.serverTab === k ? "on" : ""}" data-servertab="${k}">${l}</button>`).join("")}</div>
    <div class="tabpane">${body}</div>`;
  box.scrollTop = top;
}
function storeView() {
  if (!S.data) return `<p class="empty">Waiting for Proxmox.</p>`;
  return `<div class="store">${S.data.storage.map((s) => `<div><b>${esc(s.name)}</b><small>${s.freeGb} GB free of ${s.totalGb} GB, on ${esc(s.node)}${s.online ? "" : ", not available"}</small><div class="meter"><i style="width:${s.usedPct}%"></i></div></div>`).join("")}</div>`;
}
/* Confirmations and following a task */
const dialog = (html) => {
  $("#dialog").innerHTML = html;
  $("#scrim").classList.add("on");
  const last = [...document.querySelectorAll("#dialog button")].pop();
  last?.focus();
};
const closeDialog = () => {
  if (S.taskRunning) return;
  $("#scrim").classList.remove("on");
};
function confirmAction(title, line, label, run) {
  S.pending = run;
  dialog(`<h3>${esc(title)}</h3><p>${esc(line)}</p><div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-dlg="ok">${esc(label)}</button></div>`);
}
function drawTask(title, view, error) {
  const running = !error && !view?.finished;
  const words = error || (running ? "Working on it." : { ok: "Finished.", warning: "Finished with warnings.", failed: `It failed. ${view.message}` }[view.result]);
  dialog(`<h3>${esc(title)}</h3><p class="${error || view?.result === "failed" ? "loginerr" : ""}">${esc(words)}</p>
    ${view?.lines?.length ? `<pre class="tasklog">${esc(view.lines.join("\n"))}</pre>` : ""}
    <div class="row-end"><button class="btn" data-dlg="cancel" ${running ? "disabled" : ""}>Close</button></div>`);
  const log = $("#dialog .tasklog");
  if (log) log.scrollTop = log.scrollHeight;
}
async function runAction(action, server, title, extra = {}, after = null) {
  S.taskRunning = true;
  S.afterTask = after;
  drawTask(title);
  try {
    const res = await post(`api/action/${action}`, { server, ...extra });
    const body = await res.json();
    if (res.status === 401) {
      S.taskRunning = false;
      closeDialog();
      return showLogin("You've been signed out. Sign in again to continue.");
    }
    if (!res.ok) throw new Error(body.error);
    const url = `api/task?server=${encodeURIComponent(server)}&task=${encodeURIComponent(body.task)}`;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const view = await signal(url);
      drawTask(title, view);
      if (view.finished) break;
    }
    S.taskRunning = false;
    loadServer();
  } catch (err) {
    S.taskRunning = false;
    drawTask(title, null, err.message || "BossMox lost contact with Proxmox.");
  }
}

/* Update terminal */
let term = null;
/* Guided restart */
const REBOOT_KEY = "bossmox-restart";
let rebootMemory = null;
function savedReboot() {
  try {
    const raw = localStorage.getItem(REBOOT_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* fall back to memory */ }
  return rebootMemory;
}
function saveReboot(value) {
  rebootMemory = value;
  try {
    if (value) localStorage.setItem(REBOOT_KEY, JSON.stringify(value));
    else localStorage.removeItem(REBOOT_KEY);
  } catch { /* memory copy still works */ }
}
async function startRestart(server) {
  let plan;
  try {
    plan = await signal(`api/reboot-plan?server=${encodeURIComponent(server)}`);
  } catch (err) {
    return dialog(`<h3>Couldn't prepare the restart</h3><p class="loginerr">${esc(err.message)}</p><div class="row-end"><button class="btn" data-dlg="cancel">Close</button></div>`);
  }
  const guests = (S.data?.vms ?? []).filter((v) => v.node === server && v.running);
  const blocked = plan.busy.length > 0;
  S.restart = { server, guests };
  dialog(`<h3>Restart ${esc(server)}?</h3>
    <p>${guests.length ? "Everything below goes down until the server is back, usually a few minutes." : "Nothing is running on this server."} If BossMox runs on this server, it goes down too and this page will wait for it.</p>
    ${blocked ? `<p class="loginerr" style="margin-top:12px">Wait for this to finish first: ${esc(plan.busy.join(", "))}.</p>` : ""}
    ${plan.busyKnown ? "" : `<p class="loginerr" style="margin-top:12px">BossMox can't tell whether jobs are running on this server.</p>`}
    ${guests.length ? `<div class="restartlist">${guests.map((v) => `<div class="snap"><div>${esc(v.name)}</div><span class="state">${v.startsAtBoot ? "Starts again by itself" : "Stays off until started"}</span></div>`).join("")}</div>` : ""}
    ${guests.length && plan.backupStorages.length ? `<div class="restartbackup"><select id="rstore" aria-label="Backup storage">${plan.backupStorages.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}, ${s.freeGb} GB free</option>`).join("")}</select><button class="btn" data-backup="${esc(server)}">Back up first</button></div>` : ""}
    <label class="field restartname"><span>Type ${esc(server)} to confirm</span><input id="rname" autocomplete="off" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="rgo" data-restart="${esc(server)}" disabled>Restart ${esc(server)}</button></div>`);
  $("#rname").focus();
}
async function doRestart(server) {
  const guests = S.restart?.guests ?? [];
  S.restart = null;
  saveReboot({ server, startedAt: Date.now(), guests: guests.map((v) => ({ id: v.id, name: v.name, auto: v.startsAtBoot })) });
  try {
    const res = await post("api/action/restart-server", { server, confirm: server });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
  } catch (err) {
    saveReboot(null);
    return dialog(`<h3>The restart didn't start</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p><div class="row-end"><button class="btn" data-dlg="cancel">Close</button></div>`);
  }
  watchRestart();
}
function drawRestart(plan, state, title, note, done) {
  const row = (name, ok, word) => `<div class="snap"><div>${esc(name)}</div><span class="state"><span class="dot ${ok === null ? "busy" : ok ? "running" : "warn"}"></span>${esc(word)}</span></div>`;
  dialog(`<h3>${esc(title)}</h3><p>${esc(note)}</p><div class="restartlist">
    ${row(plan.server, state.back ? true : null, state.back ? "Back" : state.down ? "Restarting" : "Going down")}
    ${plan.guests.map((g) => state.running.has(g.id) ? row(g.name, true, "Running") : g.auto ? row(g.name, done ? false : null, done ? "Not running" : "Waiting") : row(g.name, false, "Off, needs starting")).join("")}
    </div><div class="row-end"><button class="btn" data-restartclose="1">${done ? "Close" : "Stop watching"}</button></div>`);
}
async function watchRestart() {
  const plan = savedReboot();
  if (!plan || S.watching) return;
  S.watching = true;
  const deadline = plan.startedAt + 15 * 60 * 1000;
  const state = { back: false, down: false, running: new Set() };
  let backAt = 0;
  for (;;) {
    if (!savedReboot()) break;
    try {
      const d = await signal(`api/server?name=${encodeURIComponent(plan.server)}`);
      const o = await signal("api/overview");
      const up = d.summary?.uptimeSeconds;
      const restarted = up !== undefined && up * 1000 < Date.now() - plan.startedAt + 5000;
      state.back = restarted && o.nodes.some((n) => n.name === plan.server && n.online);
      state.down ||= restarted;
      state.running = new Set(o.vms.filter((v) => v.running).map((v) => v.id));
      S.data = o;
    } catch (err) {
      if (err.message === "signed out") {
        S.watching = false;
        return;
      }
      state.down = true;
      state.back = false;
    }
    const waiting = plan.guests.filter((g) => g.auto && !state.running.has(g.id));
    if (state.back && !backAt) backAt = Date.now();
    const allBack = state.back && waiting.length === 0;
    const gaveUp = backAt && Date.now() - backAt > 5 * 60 * 1000;
    if (allBack || gaveUp || Date.now() > deadline) {
      const off = plan.guests.filter((g) => !g.auto && !state.running.has(g.id));
      const title = allBack ? `${plan.server} is back` : state.back ? `${plan.server} is back, but something's missing` : `${plan.server} hasn't come back`;
      const note = allBack
        ? off.length ? "Everything set to start by itself is running. The items marked off need starting by hand." : "Everything is running again."
        : state.back ? "These haven't started yet. Check them before relying on this server." : "It's been 15 minutes. Someone may need to look at the server itself.";
      drawRestart(plan, state, title, note, true);
      saveReboot(null);
      S.watching = false;
      renderHealth();
      loadServer();
      return;
    }
    drawRestart(plan, state, `Restarting ${plan.server}`, state.back ? "It's back. Waiting for everything to start." : "Keep this page open. This usually takes a few minutes.", false);
    await new Promise((r) => setTimeout(r, 3000));
  }
  S.watching = false;
}

function closeTerminal() {
  term?.socket?.close();
  term?.xterm?.dispose();
  term?.observer?.disconnect();
  term = null;
  if (wins.terminal) {
    wins.terminal.remove();
    delete wins.terminal;
  }
  renderTasks();
  loadServer();
}
async function openTerminal(server) {
  if (term) return openWin("terminal");
  try {
    const res = await post("api/action/install-updates", { server });
    const body = await res.json();
    if (res.status === 401) return showLogin("You've been signed out. Sign in again to continue.");
    if (!res.ok) throw new Error(body.error);
    openWin("terminal");
    $(".wbody", wins.terminal).innerHTML = `<div class="termwrap"><p class="termhelp">Updating ${esc(server)}. Check the list, then type <b>Y</b> and press Enter to install.</p><div id="termbox"></div></div>`;
    const dark = { background: "#07161C", foreground: "#CFE6DF" };
    const xterm = new Terminal({ cursorBlink: true, fontFamily: "ui-monospace,Consolas,monospace", fontSize: 14, theme: dark, scrollback: 10000 });
    const fit = new FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.open($("#termbox"));
    fit.fit();
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal?id=${encodeURIComponent(body.terminal)}`, "binary");
    socket.binaryType = "arraybuffer";
    const utf8 = new TextEncoder();
    const resize = () => {
      fit.fit();
      if (socket.readyState === 1) socket.send(`1:${xterm.cols}:${xterm.rows}:`);
    };
    socket.onopen = () => {
      resize();
      xterm.focus();
    };
    const decoder = new TextDecoder();
    let recent = "";
    socket.onmessage = (e) => {
      const bytes = new Uint8Array(e.data);
      xterm.write(bytes);
      if (term?.done) return;
      // Proxmox prints this when the updater finishes, then leaves a root shell open.
      recent = (recent + decoder.decode(bytes)).slice(-200);
      if (recent.includes("starting shell") && term) {
        term.done = true;
        $(".termhelp").textContent = `The updater has finished on ${server}. Check the output, then close this window.`;
      }
    };
    socket.onclose = () => {
      if (term?.socket === socket) {
        term.done = true;
        xterm.write("\r\n\r\nThe session has ended. You can close this window.\r\n");
      }
    };
    xterm.onData((d) => {
      if (socket.readyState === 1) socket.send(`0:${utf8.encode(d).length}:${d}`);
    });
    const observer = new ResizeObserver(resize);
    observer.observe($("#termbox"));
    const ping = setInterval(() => socket.readyState === 1 ? socket.send("2") : clearInterval(ping), 30000);
    term = { socket, xterm, observer, server, done: false };
  } catch (err) {
    dialog(`<h3>Couldn't start the install</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p><div class="row-end"><button class="btn" data-dlg="cancel">Close</button></div>`);
  }
}

const soon = (t, line) => () => `<div class="soon"><h2>${t}</h2><p>${line}</p></div>`;
const RENDER = {
  terminal: () => "",
  vms: vmsShell, monitor: monView, storage: storeView,
  create: soon("Create a VM", "Not built yet."),
  network: soon("Network", "Not built yet."),
  backups: soon("Backups", "Not built yet."),
};

/* Events */
document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.open) return openWin(d.open);
  if (d.close === "terminal") {
    if (term && !term.done) {
      return confirmAction("Close this window?", "If updates are installing, closing may interrupt them. Close it only if the install has finished.", "Close anyway", closeTerminal);
    }
    return closeTerminal();
  }
  if (d.close) {
    wins[d.close].remove();
    delete wins[d.close];
    return renderTasks();
  }
  if (d.min) {
    wins[d.min].classList.add("hidden");
    return renderTasks();
  }
  if (d.server) {
    openWin("monitor");
    return pickServer(d.server);
  }
  if (d.dlg) {
    const run = d.dlg === "ok" ? S.pending : null;
    const after = S.taskRunning ? null : S.afterTask;
    S.pending = null;
    S.afterTask = null;
    closeDialog();
    if (run) run();
    else if (after) after();
    return;
  }
  if (d.restartserver) return startRestart(d.restartserver);
  if (d.restart) {
    t.disabled = true;
    return doRestart(d.restart);
  }
  if (d.restartclose) {
    saveReboot(null);
    S.watching = false;
    return closeDialog();
  }
  if (d.backup) {
    const server = d.backup;
    const ids = (S.restart?.guests ?? []).map((v) => v.id).join(",");
    const storage = $("#rstore").value;
    return confirmAction(`Back up ${S.restart.guests.length} on ${server}?`, `This saves a copy to ${storage}. They stay running, though they may feel slower while it runs.`, `Back up to ${storage}`, () => runAction("back-up-guests", server, `Backing up ${server}`, { guests: ids, storage }, () => startRestart(server)));
  }
  if (d.check) {
    const server = d.check;
    return confirmAction(`Check ${server} for updates?`, "This only looks for new updates. It doesn't install anything.", `Check ${server}`, () => runAction("check-updates", server, `Checking ${server} for updates`));
  }
  if (d.install) {
    const server = d.install;
    const n = S.detail?.updates?.total ?? 0;
    return confirmAction(`Install ${n} updates on ${server}?`, S.detail?.updates?.rebootNeeded ? "This opens a terminal on the server and installs in the foreground. A restart will be needed afterward. You'll get one more chance to review the list." : "This opens a terminal on the server and installs in the foreground. You'll get one more chance to review the list.", `Open installer for ${server}`, () => openTerminal(server));
  }
  if (d.servertab) {
    S.serverTab = d.servertab;
    return renderServerDetail();
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
  if (e.target.id === "rname") {
    $("#rgo").disabled = e.target.value !== S.restart?.server;
  }
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
  S.server = null;
  S.detail = null;
  S.detailError = "";
  term?.socket?.close();
  term?.xterm?.dispose();
  term?.observer?.disconnect();
  term = null;
  S.taskRunning = false;
  S.watching = false;
  $("#scrim").classList.remove("on");
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
  $("#lgo").disabled = true;
  loadRealms(message);
}
async function loadRealms(message) {
  try {
    const res = await fetch("api/login-info");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    const rank = (r) => (r.default ? 2 : r.realm === "pam" ? 1 : 0);
    const realms = [...body.realms].sort((a, b) => rank(b) - rank(a));
    $("#lrealm").innerHTML = realms.map((r) => `<option value="${esc(r.realm)}">${esc(r.comment || r.realm)}</option>`).join("");
    $("#lgo").disabled = false;
    showError(message);
  } catch {
    // Proxmox may be restarting, so keep trying while the sign-in screen is up.
    showError("Waiting for Proxmox. Sign-in will be ready when it answers.");
    setTimeout(() => {
      if (!$("#login").hidden) loadRealms(message);
    }, 3000);
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
    if (savedReboot() && !S.watching) watchRestart();
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
  renderServers();
  if (wins.monitor && ++S.ticks % 3 === 0) loadServer();
  render("storage");
}

const q = new URLSearchParams(location.search);
let saved = null;
try { saved = localStorage.getItem("bossmox-look"); } catch { /* use the default */ }
setLook(q.get("look") || saved || "daylight");
tick();
setInterval(tick, 20000);
refresh();
