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
  create: { title: "Create a VM", color: "#178A5F", w: 560, h: 640 },
  monitor: { title: "Nodes", color: "#7A5AC8", w: 900, h: 620 },
  storage: { title: "Storage", color: "#B9680A", w: 520, h: 420 },
  network: { title: "Network", color: "#2F7A7E", w: 860, h: 580 },
  backups: { title: "Backups", color: "#C43838", w: 860, h: 610 },
  terminal: { title: "Install updates", color: "#20262A", w: 860, h: 560, noIcon: true },
  console: { title: "Console", color: "#20262A", w: 980, h: 680, noIcon: true },
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
    <p class="sub">${up} of ${nodes.length} ${nodes.length === 1 ? "node" : "nodes"} online. ${run} of ${vms.length} ${vms.length === 1 ? "VM" : "VMs"} running, and ${freeText} free.</p>
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
  if (app === "backups") loadBackups();
  if (app === "create") startCreate();
  if (app === "network") loadNetwork();
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
    box.innerHTML = `<p class="empty">${S.data?.vms.length ? "Pick a VM to see its details." : "There are no VMs on this node yet."}</p>`;
    return;
  }
  box.innerHTML = `
    <div class="head"><div><h2>${esc(v.name)}</h2>
      <div class="state"><span class="dot ${dotClass(v)}"></span>${esc(stateWord(v))}</div></div>
      <div class="actions">${v.running
        ? `<button class="btn" data-console="${v.id}">Console</button><button class="btn" data-power="shutdown">Shut down</button><button class="btn" data-power="reboot">Restart</button><button class="btn" data-power="stop">Force off</button>`
        : `<button class="btn primary" data-power="start">Start</button>`}${(S.data?.nodes.length ?? 0) > 1 ? `<button class="btn" data-move="${v.id}">Move</button>` : ""}${v.running ? "" : `<button class="btn" data-guestdelete="${v.id}">Delete</button>`}</div></div>
    <div class="tabs" role="tablist">${[["overview", "Overview"], ["snapshots", "Snapshots"], ["settings", "Settings"]].map(([k, l]) => `<button role="tab" aria-selected="${S.tab === k}" class="${S.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
    <div class="tabpane">${TAB[S.tab](v)}</div>`;
  if (S.tab === "snapshots") checkSnapshots(v);
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
  snapshots: (v) => `<div class="head"><p class="meta" style="margin-top:0">A snapshot saves ${esc(v.name)} as it is now, so you can go back to it later. It isn't a backup: it lives on the same disk.</p>
      ${S.snapSupport?.[v.id] === false ? "" : `<div class="actions"><button class="btn primary" data-snaptake="1">Take a snapshot</button></div>`}</div>
    ${S.snapSupport?.[v.id] === false ? `<div class="advice"><div><b>Snapshots aren't available for ${esc(v.name)}</b>The storage holding its disk can't take them. Backups still work.</div></div>` : ""}
    ${v.snapshots.length
      ? v.snapshots.map((s) => `<div class="snap"><div>${esc(s.name)}<small>${esc(s.description ? `${s.description}, ${when(s.takenAt)}` : when(s.takenAt))}</small></div><div class="actions"><button class="btn" data-snaprestore="${esc(s.name)}">Go back to this</button><button class="btn" data-snapdelete="${esc(s.name)}">Delete</button></div></div>`).join("")
      : S.snapSupport?.[v.id] === false ? "" : `<p class="empty">This VM has no snapshots yet.</p>`}`,
  settings: (v) => `<div class="row-end" style="margin:0 0 12px"><button class="btn" data-guestedit="${v.id}">Change settings</button></div><div class="raw">${Object.entries(v.tech).map(([k, val]) => `<span>${esc(k)}</span><code>${esc(val)}</code>`).join("")}</div>
    ${v.configLoaded ? "" : `<p class="meta">Proxmox didn't return this VM's settings.</p>`}`,
};

/* Servers and Storage */
function monView() {
  return `<div class="vms"><aside><div id="srvlist"></div></aside><div id="srvdetail"></div></div>`;
}
const signal = (url) => fetch(url).then(async (res) => {
  const body = await res.json();
  if (res.status === 401) {
    showLogin(savedReboot() ? "BossMox restarted too. Sign in to finish checking the node." : "You've been signed out. Sign in again to continue.");
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
    S.detailError = err.message || "BossMox couldn't get this node's details.";
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
    <span class="dot ${n.online ? "running" : "warn"}"></span><b>${esc(n.name)}</b><small>${n.online ? `${n.cpuPct}% busy, ${n.memPct}% memory` : "Offline"}</small></button>`).join("") + (S.data.nodes.length > 1 ? `<button class="btn rollbtn" data-rolling="1">Update all nodes</button>` : "");
  if (S.serverTab === "overview") renderServerDetail();
}
const noAccess = (what, perm) => `<p class="empty">Your Proxmox account can't see ${what}. It needs ${perm} on this node.</p>`;
const SERVER_TAB = {
  overview: (d, node) => {
    const on = S.data?.vms.filter((v) => v.node === d.name) ?? [];
    const a = d.summary;
    return `
    ${(() => {
      const m = movedGuests(d.name);
      return m ? `<div class="advice"><div><b>${m.guests.length} moved to ${esc(m.target)} for a restart</b>${esc(m.guests.map((g) => g.name).join(", "))}</div><button class="btn" data-moveback="${esc(d.name)}">Move everything back</button></div>` : "";
    })()}
    ${d.channel && !d.channel.ok ? `<div class="advice"><div><b>Updates can't download</b>${esc(d.channel.note)}</div></div>` : ""}
    ${d.updates?.total ? `<div class="advice"><div><b>${d.updates.total} ${d.updates.total === 1 ? "update is" : "updates are"} waiting</b>${d.updates.rebootNeeded ? "This includes a new kernel, so the node will need a restart." : "No restart should be needed."}</div><button class="btn" data-servertab="updates">See updates</button></div>` : ""}
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
    </dl>` : noAccess("this node's status", "Sys.Audit")}
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
      <p class="meta">This list is from the node's last check for updates.</p>` : `<p class="empty">This node is up to date as of its last check for updates.</p>`}`;
  },
  services: (d) => {
    if (!d.services) return noAccess("services", "Sys.Audit");
    const off = d.services.filter((v) => v.enabled && !v.running);
    return `${off.length ? `<div class="advice"><div><b>${off.length} ${off.length === 1 ? "service should be running but isn't" : "services should be running but aren't"}</b>${off.map((v) => esc(v.name)).join(", ")}</div></div>` : ""}
    ${d.services.map((v) => `<div class="snap"><div>${esc(v.name)}</div><span class="state"><span class="dot ${v.running ? "running" : v.enabled ? "warn" : ""}"></span>${v.running ? "Running" : v.enabled ? "Stopped" : "Off"}</span></div>`).join("")}`;
  },
  activity: (d) => {
    if (!d.tasks) return noAccess("recent activity", "Sys.Audit");
    if (!d.tasks.length) return `<p class="empty">No recent activity on this node.</p>`;
    const words = { running: "Running", ok: "Finished", warning: "Finished with warnings", failed: "Failed" };
    const dots = { running: "busy", ok: "running", warning: "warn", failed: "warn" };
    return d.tasks.map((t) => `<div class="snap"><div>${esc(t.what)}${t.target ? ` on ${esc(t.target)}` : ""}<small>${esc(when(t.startedAt))}, by ${esc(t.who)}</small></div><span class="state"><span class="dot ${dots[t.result]}"></span>${words[t.result]}</span></div>`).join("");
  },
};
function renderServerDetail() {
  const box = $("#srvdetail");
  if (!box) return;
  if (!S.server) {
    box.innerHTML = `<p class="empty">Pick a node to see its details.</p>`;
    return;
  }
  const node = S.data?.nodes.find((n) => n.name === S.server);
  const d = S.detail;
  const body = d ? SERVER_TAB[S.serverTab](d, node) : S.detailError ? `<p class="empty">${esc(S.detailError)}</p>` : `<p class="empty">Loading this node's details.</p>`;
  const top = box.scrollTop;
  box.innerHTML = `
    <div class="head"><div><h2>${esc(S.server)}</h2>
      <div class="state"><span class="dot ${node?.online ? "running" : "warn"}"></span>${node?.online ? "Online" : "Offline"}${d?.summary ? `, running for ${esc(d.summary.uptime)}` : ""}</div></div>
      <div class="actions"><button class="btn" data-nodeconsole="${esc(S.server)}" ${node?.online ? "" : "disabled"}>Console</button><button class="btn danger" data-restartserver="${esc(S.server)}">Restart</button></div></div>
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
function confirmAction(title, line, label, run, danger = false) {
  S.pending = run;
  dialog(`<h3>${esc(title)}</h3><p>${esc(line)}</p><div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-dlg="ok">${esc(label)}</button></div>`);
}
function drawTask(title, view, error) {
  const running = !error && !view?.finished;
  const slow = running && Date.now() - S.taskStarted > 10000;
  const help = S.taskHelp;
  const noAnswer = help && view?.result === "failed" && /timeout/i.test(view.message ?? "");
  const words = error || (noAnswer ? help.failed : slow ? help?.waiting ?? "This is taking a while. It carries on in Proxmox even if you stop watching." : running ? "Working on it." : { ok: "Finished.", warning: "Finished with warnings.", failed: `It failed. ${view.message}` }[view.result]);
  const force = help && (slow || noAnswer) ? `<button class="btn danger" data-forceoff="${help.guest}">Force off</button>` : "";
  dialog(`<h3>${esc(title)}</h3><p class="${error || view?.result === "failed" ? "loginerr" : ""}">${esc(words)}</p>
    ${view?.lines?.length ? `<pre class="tasklog">${esc(view.lines.join("\n"))}</pre>` : ""}
    <div class="row-end">${slow ? `<button class="btn" data-taskleave="1">Stop watching</button>` : `<button class="btn" data-dlg="cancel" ${running ? "disabled" : ""}>Close</button>`}${force}</div>`);
  const log = $("#dialog .tasklog");
  if (log) log.scrollTop = log.scrollHeight;
}
async function runAction(action, server, title, extra = {}, after = null, help = null) {
  S.taskRunning = true;
  S.afterTask = after;
  S.taskStarted = Date.now();
  S.taskHelp = help;
  const me = S.taskToken = (S.taskToken ?? 0) + 1;
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
    if (!body.task) {
      S.taskRunning = false;
      return drawTask(title, { finished: true, result: "ok", lines: [] });
    }
    const url = `api/task?server=${encodeURIComponent(server)}&task=${encodeURIComponent(body.task)}`;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const view = await signal(url);
      if (me !== S.taskToken) return;
      drawTask(title, view);
      if (view.finished) break;
    }
    S.taskRunning = false;
    loadServer();
  } catch (err) {
    if (me !== S.taskToken) return;
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
const MOVE_WORDS = "Everything below moves to the node you pick. If anything can't move, the restart is cancelled. If BossMox is one of them, it reconnects after the move and you'll sign in again.";
const STOP_WORDS = "Proxmox shuts down everything below first, waits for it all to stop, then restarts the node. This usually takes a few minutes. If BossMox runs on this node, it goes down too and this page will wait for it.";
/* Guests moved off for a restart, remembered in this browser so they can be sent home. */
const MOVED_KEY = "bossmox-moved";
let movedMemory = {};
function allMoved() {
  try {
    return JSON.parse(localStorage.getItem(MOVED_KEY) ?? "{}");
  } catch {
    return movedMemory;
  }
}
function saveMoved(value) {
  movedMemory = value;
  try {
    localStorage.setItem(MOVED_KEY, JSON.stringify(value));
  } catch { /* memory copy still works */ }
}
function setMoved(server, entry) {
  const all = allMoved();
  if (entry) all[server] = entry;
  else delete all[server];
  saveMoved(all);
}
/** Only guests still sitting on the server they were moved to can go back. */
function movedGuests(server) {
  const entry = allMoved()[server];
  if (!entry || !S.data) return null;
  const here = new Map(S.data.vms.map((v) => [v.id, v]));
  const guests = entry.guests.filter((g) => here.get(g.id)?.node === entry.target);
  return guests.length ? { target: entry.target, guests } : null;
}
function askMoveBack(server) {
  const m = movedGuests(server);
  if (!m) return;
  const names = m.guests.map((g) => g.name).join(", ");
  confirmAction(`Move ${m.guests.length} back to ${server}?`, `${names} will move from ${m.target} back to ${server}.`, `Move back to ${server}`, () => {
    const ids = m.guests.map((g) => g.id).join(",");
    runAction("move-all", m.target, `Moving back to ${server}`, { target: server, guests: ids }, async () => {
      await refresh();
      if (!movedGuests(server)) setMoved(server, null);
      renderServerDetail();
    });
  });
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
  const others = (S.data?.nodes ?? []).filter((n) => n.online && n.name !== server).map((n) => n.name);
  if (allMoved()[server] && !movedGuests(server)) setMoved(server, null);
  const canMove = guests.length > 0 && others.length > 0;
  S.restart = { server, guests };
  dialog(`<h3>Restart ${esc(server)}?</h3>
    <p id="rwords">${guests.length ? (canMove ? MOVE_WORDS : STOP_WORDS) : "Nothing is running on this node."}</p>
    ${blocked ? `<p class="loginerr" style="margin-top:12px">Wait for this to finish first: ${esc(plan.busy.join(", "))}.</p>` : ""}
    ${plan.busyKnown ? "" : `<p class="loginerr" style="margin-top:12px">BossMox can't tell whether jobs are running on this node.</p>`}
    ${canMove ? plan.cantMove.map((m) => `<p class="loginerr" style="margin-top:12px">${esc(m)}</p>`).join("") : ""}
    ${guests.length ? `<div class="restartlist">${guests.map((v) => `<div class="snap"><div>${esc(v.name)}</div><span class="state">${v.startsAtBoot ? "Starts again by itself" : "Stays off until started"}</span></div>`).join("")}</div>` : ""}
    ${canMove ? `<label class="field restartname"><span>Before restarting</span><select id="rmove"><option value="">Shut them down, don't move them</option>${others.map((n) => `<option value="${esc(n)}" selected>Move everything to ${esc(n)}</option>`).join("")}</select></label>` : ""}
    ${guests.length && plan.backupStorages.length ? `<div class="restartbackup"><select id="rstore" aria-label="Backup storage">${plan.backupStorages.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}, ${s.freeGb} GB free</option>`).join("")}</select><button class="btn" data-backup="${esc(server)}">Back up first</button></div>` : ""}
    <label class="field restartname"><span>Type reboot to confirm</span><input id="rname" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="rgo" data-restart="${esc(server)}" disabled>Restart ${esc(server)}</button></div>`);
  $("#rname").focus();
}
async function sendRestart(plan) {
  const res = await post("api/action/restart-server", { server: plan.server, confirm: "reboot" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
}
async function doRestart(server) {
  const guests = S.restart?.guests ?? [];
  const target = $("#rmove")?.value || "";
  S.restart = null;
  const plan = { server, target, phase: target ? "moving" : "restarting", startedAt: Date.now(), guests: guests.map((v) => ({ id: v.id, name: v.name, auto: v.startsAtBoot })) };
  saveReboot(plan);
  try {
    if (target) {
      const res = await post("api/action/move-all", { server, target, guests: guests.map((v) => v.id).join(",") });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      plan.task = body.task;
      plan.movedAt = Date.now();
      saveReboot(plan);
    } else {
      await sendRestart(plan);
    }
  } catch (err) {
    saveReboot(null);
    return dialog(`<h3>The restart didn't start</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p><div class="row-end"><button class="btn" data-dlg="cancel">Close</button></div>`);
  }
  watchRestart();
}
function restartStage(plan, state) {
  if (plan.phase === "moving") return "moving";
  if (state.back) return "starting";
  if (plan.target) return "rebooting";
  if (state.lost || state.down) return "rebooting";
  return plan.guests.some((g) => state.running.has(g.id)) ? "stopping" : "rebooting";
}
const STAGE_NOTE = {
  moving: "Moving everything off this node. It restarts only after all of it has moved. Keep this page open.",
  stopping: "Shutting down what's running. Proxmox waits for all of it to stop before it restarts the node.",
  rebooting: "The node is restarting. If BossMox can't reach it for a while, that's expected. Keep this page open.",
  starting: "The node is back. Waiting for everything to start.",
};
function drawRestart(plan, state, title, note, done) {
  const stage = restartStage(plan, state);
  const row = (name, ok, word) => `<div class="snap"><div>${esc(name)}</div><span class="state"><span class="dot ${ok === null ? "busy" : ok ? "running" : "warn"}"></span>${esc(word)}</span></div>`;
  const serverWord = { moving: done ? "Not restarted" : "Waiting for moves to finish", stopping: "Waiting for VMs to stop", rebooting: "Restarting", starting: "Back" }[stage];
  const guestRow = (g) => {
    const on = state.running.has(g.id);
    if (stage === "moving") return state.where.get(g.id) === plan.target ? row(g.name, true, `Moved to ${plan.target}`) : done ? row(g.name, false, "Didn't move") : row(g.name, null, "Moving");
    if (plan.target) return on ? row(g.name, true, `Running on ${state.where.get(g.id) ?? plan.target}`) : row(g.name, null, "Waiting");
    if (stage === "stopping") return on ? row(g.name, null, "Shutting down") : row(g.name, true, "Stopped");
    if (stage === "rebooting") return row(g.name, null, "Shutting down or waiting");
    if (on) return row(g.name, true, "Running");
    if (!g.auto) return row(g.name, false, "Off, needs starting");
    return done ? row(g.name, false, "Not running") : row(g.name, null, "Starting");
  };
  dialog(`<h3>${esc(title)}</h3><p>${esc(note || STAGE_NOTE[stage])}</p><div class="restartlist">
    ${row(plan.server, state.back ? true : done ? false : null, serverWord)}
    ${plan.guests.map(guestRow).join("")}
    </div><div class="row-end"><button class="btn" data-restartclose="1">${done ? "Close" : plan.rolling ? "Stop the update" : "Stop watching"}</button>${done && movedGuests(plan.server) ? `<button class="btn primary" data-moveback="${esc(plan.server)}">Move everything back</button>` : ""}</div>`);
}
async function watchRestart() {
  const plan = savedReboot();
  if (!plan || S.watching) return;
  if (plan.phase === "next") return rollingStep(plan.rolling);
  if (plan.phase === "installing") return rollingInstall(plan);
  if (plan.phase === "returning") return rollingReturn(plan);
  S.watching = true;
  const state = { back: false, down: false, lost: false, running: new Set(plan.guests.map((g) => g.id)), where: new Map() };
  let backAt = 0;
  for (;;) {
    if (!savedReboot()) break;
    try {
      const o = await signal("api/overview");
      const d = await signal(`api/server?name=${encodeURIComponent(plan.server)}`).catch((err) => {
        if (err.message === "signed out") throw err;
        return {};
      });
      const up = d.summary?.uptimeSeconds;
      const restarted = plan.phase === "restarting" && up !== undefined && up * 1000 < Date.now() - plan.startedAt + 5000;
      state.back = restarted && o.nodes.some((n) => n.name === plan.server && n.online);
      state.down ||= restarted;
      state.running = new Set(o.vms.filter((v) => v.running).map((v) => v.id));
      state.where = new Map(o.vms.map((v) => [v.id, v.node]));
      state.lost = false;
      S.data = o;
      if (plan.phase === "moving") {
        const left = plan.guests.filter((g) => state.where.get(g.id) !== plan.target);
        const task = plan.task ? await signal(`api/task?server=${encodeURIComponent(plan.server)}&task=${encodeURIComponent(plan.task)}`).catch(() => null) : null;
        if (left.length === 0 && plan.rolling) {
          plan.phase = "installing";
          saveReboot(plan);
          return rollingInstall(plan);
        }
        if (left.length === 0) {
          await sendRestart(plan);
          plan.phase = "restarting";
          plan.startedAt = Date.now();
          saveReboot(plan);
        } else if (task?.finished || Date.now() - plan.startedAt > 30 * 60 * 1000) {
          keepMoved(plan);
          drawRestart(plan, state, `${plan.server} was not restarted`, `These didn't move, so the restart was cancelled: ${left.map((g) => g.name).join(", ")}. Anything already moved stays where it is.${plan.rolling ? ` ${notTouched(plan)}` : ""}`, true);
          saveReboot(null);
          S.watching = false;
          return;
        }
      }
    } catch (err) {
      if (err.message === "signed out") {
        S.watching = false;
        return;
      }
      state.lost = true;
      state.back = false;
    }
    const waiting = plan.target ? plan.guests.filter((g) => !state.running.has(g.id)) : plan.guests.filter((g) => g.auto && !state.running.has(g.id));
    if (state.back && !backAt) backAt = Date.now();
    const allBack = state.back && waiting.length === 0;
    const gaveUp = backAt && Date.now() - backAt > 5 * 60 * 1000;
    if (plan.phase === "restarting" && (allBack || gaveUp || Date.now() > plan.startedAt + 15 * 60 * 1000)) {
      if (allBack && plan.rolling) return rollingReturn(plan);
      const off = plan.guests.filter((g) => !g.auto && !state.running.has(g.id));
      const title = allBack ? `${plan.server} is back` : state.back ? `${plan.server} is back, but something's missing` : `${plan.server} hasn't come back`;
      let note = allBack
        ? plan.target ? `Everything is running. The moved items stay on ${plan.target}. Use Move to bring them back.` : off.length ? "Everything set to start by itself is running. The items marked off need starting by hand." : "Everything is running again."
        : state.back ? "These haven't started yet. Check them before relying on this node." : "It's been 15 minutes. Someone may need to look at the node itself.";
      if (plan.rolling) note += ` ${notTouched(plan)}`;
      if (plan.target) setMoved(plan.server, { target: plan.target, guests: plan.guests.map((g) => ({ id: g.id, name: g.name })) });
      drawRestart(plan, state, title, note, true);
      saveReboot(null);
      S.watching = false;
      renderHealth();
      loadServer();
      return;
    }
    drawRestart(plan, state, plan.rolling ? rollingTitle(plan) : `Restarting ${plan.server}`, "", false);
    await new Promise((r) => setTimeout(r, 3000));
  }
  S.watching = false;
}

/*
 * Updating a whole cluster, one server at a time. This is the guided restart with two extra phases, so a run
 * lives in the same saved plan and carries on after a reload: installing (a person approves the updater) and
 * returning (guests go home before the next server starts).
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rollingTitle = (plan) => `Updating ${plan.server}, server ${plan.rolling.index + 1} of ${plan.rolling.servers.length}`;
const closeRow = `<div class="row-end"><button class="btn" data-dlg="cancel">Close</button></div>`;
const notTouched = (plan) => {
  const rest = plan.rolling.servers.slice(plan.rolling.index + 1);
  return rest.length ? `The update stopped here, so these weren't touched: ${rest.join(", ")}.` : "The update stopped here.";
};
function keepMoved(plan) {
  if (plan.target && plan.guests.length) setMoved(plan.server, { target: plan.target, guests: plan.guests.map((g) => ({ id: g.id, name: g.name })) });
}
function rollingStop(plan, title, line) {
  keepMoved(plan);
  saveReboot(null);
  S.watching = false;
  S.taskRunning = false;
  const back = movedGuests(plan.server) ? `<button class="btn primary" data-moveback="${esc(plan.server)}">Move everything back</button>` : "";
  dialog(`<h3>${esc(title)}</h3><p>${esc(line)} ${esc(notTouched(plan))}</p><div class="row-end"><button class="btn" data-dlg="cancel">Close</button>${back}</div>`);
  renderHealth();
  loadServer();
}
async function followTask(server, task) {
  for (;;) {
    await wait(1000);
    const view = await signal(`api/task?server=${encodeURIComponent(server)}&task=${encodeURIComponent(task)}`);
    if (view.finished) return view;
  }
}
async function startRolling() {
  const names = (S.data?.nodes ?? []).filter((n) => n.online).map((n) => n.name);
  S.taskRunning = true;
  dialog(`<h3>Checking every node for updates</h3><p>This looks for new updates. It doesn't install anything.</p>`);
  let plan;
  try {
    await Promise.all(names.map(async (server) => {
      const res = await post("api/action/check-updates", { server });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      await followTask(server, body.task);
    }));
    plan = await signal("api/rolling-plan");
  } catch (err) {
    S.taskRunning = false;
    if (err.message === "signed out") return closeDialog();
    return dialog(`<h3>Couldn't prepare the update</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p>${closeRow}`);
  }
  S.taskRunning = false;
  if (plan.blocked.length) return dialog(`<h3>Not ready to update</h3>${plan.blocked.map((b) => `<p class="loginerr">${esc(b)}</p>`).join("")}${closeRow}`);
  if (!plan.servers.length) return dialog(`<h3>Every node is up to date</h3><p>Nothing is waiting to install.</p>${closeRow}`);
  S.rollingPlan = plan;
  const restarts = plan.servers.filter((v) => v.rebootNeeded).length;
  const how = !restarts
    ? "BossMox opens the updater on one node at a time, in this order, for you to approve. Nothing here needs a restart, so everything stays where it is and keeps running."
    : restarts === plan.servers.length
      ? "BossMox updates one node at a time, in this order. It moves everything off, opens the updater for you to approve, restarts the node, then moves everything back."
      : "BossMox updates one node at a time, in this order, and opens the updater for you to approve. A node that needs a restart has everything moved off first and moved back after. The others just update.";
  dialog(`<h3>Update ${plan.servers.length === 1 ? esc(plan.servers[0].name) : `all ${plan.servers.length} nodes`}?</h3>
    <p>${how} If any step fails, it stops there.</p>
    <div class="restartlist">${plan.servers.map((v) => `<div class="snap"><div>${esc(v.name)}<small>Version ${esc(v.version ?? "unknown")}</small></div><span class="state">${v.updates} ${v.updates === 1 ? "update" : "updates"}, ${v.rebootNeeded ? "restarts" : "no restart"}</span></div>`).join("")}</div>
    ${plan.keepsMajority || !restarts ? "" : `<div class="advice" style="margin-top:12px"><div><b>This cluster has only ${plan.votes} votes</b>Everything keeps running, but nothing can be started, stopped or changed while a node restarts.</div></div>`}
    <label class="field restartname"><span>Type confirm to start</span><input id="rname" data-word="confirm" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="rgo" data-rollinggo="1" disabled>Start updating</button></div>`);
  $("#rname").focus();
}
async function rollingStep(rolling) {
  const server = rolling.servers[rolling.index];
  S.watching = true;
  const plan = { server, target: "", phase: "next", rolling, guests: [], startedAt: Date.now() };
  saveReboot(plan);
  dialog(`<h3>${esc(rollingTitle(plan))}</h3><p>Checking that the cluster is healthy before starting.</p><div class="row-end"><button class="btn" data-restartclose="1">Stop the update</button></div>`);
  let check;
  try {
    // A server that just came back can look busy or absent for a moment.
    for (const until = Date.now() + 3 * 60 * 1000; ; await wait(5000)) {
      check = await signal("api/rolling-plan");
      if (!savedReboot()) return;
      if (!check.blocked.length || Date.now() > until) break;
    }
    S.data = await signal("api/overview");
  } catch (err) {
    S.watching = false;
    if (err.message === "signed out") return;
    return rollingStop(plan, `${server} wasn't updated`, err.message || "BossMox lost contact with Proxmox.");
  }
  if (check.blocked.length) return rollingStop(plan, `${server} wasn't updated`, check.blocked.join(" "));
  const entry = check.servers.find((v) => v.name === server);
  if (!entry) return rollingNext(plan);
  plan.restart = entry.rebootNeeded;
  if (plan.restart) rolling.restarted = (rolling.restarted ?? 0) + 1;
  // Only a restart takes guests down, so without one they stay where they are.
  const guests = plan.restart ? S.data.vms.filter((v) => v.node === server && v.running) : [];
  plan.guests = guests.map((v) => ({ id: v.id, name: v.name, auto: v.startsAtBoot }));
  if (guests.length) {
    const others = S.data.nodes.filter((n) => n.online && n.name !== server).map((n) => n.name);
    // Finished servers are the newest, and guests should only move to the same version or newer.
    plan.target = rolling.servers.slice(0, rolling.index).reverse().find((n) => others.includes(n)) ?? others[0] ?? "";
    if (!plan.target) return rollingStop(plan, `${server} wasn't updated`, "There's no other online node to move its guests to.");
    plan.phase = "moving";
    try {
      const res = await post("api/action/move-all", { server, target: plan.target, guests: guests.map((v) => v.id).join(",") });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      plan.task = body.task;
      plan.startedAt = Date.now();
      saveReboot(plan);
    } catch (err) {
      return rollingStop({ ...plan, target: "" }, `${server} wasn't updated`, err.message || "BossMox lost contact with Proxmox.");
    }
    S.watching = false;
    return watchRestart();
  }
  plan.phase = "installing";
  saveReboot(plan);
  rollingInstall(plan);
}
function rollingInstall(plan, problem = "") {
  S.watching = true;
  dialog(`<h3>${esc(rollingTitle(plan))}</h3>
    ${problem ? `<p class="loginerr">${esc(problem)}</p>` : ""}
    <p>${plan.guests.length ? `Everything has moved to ${esc(plan.target)}. ` : ""}Open the updater, check the list, then type Y and press Enter. When it finishes, close its window${plan.restart ? ` and BossMox restarts ${esc(plan.server)}` : ""}.</p>
    <div class="row-end"><button class="btn" data-rollingstop="1">Stop here</button><button class="btn primary" data-rollinginstall="1">Open the updater</button></div>`);
}
async function rollingAfterInstall(plan) {
  dialog(`<h3>${esc(rollingTitle(plan))}</h3><p>Checking that the updates installed.</p>`);
  let left;
  try {
    left = (await signal(`api/server?name=${encodeURIComponent(plan.server)}`)).updates?.total;
  } catch (err) {
    if (err.message === "signed out") return;
  }
  if (left === undefined) return rollingInstall(plan, `BossMox couldn't confirm the updates installed on ${plan.server}, so it hasn't restarted it.`);
  if (left > 0) return rollingInstall(plan, `${left} ${left === 1 ? "update is" : "updates are"} still waiting on ${plan.server}${plan.restart ? ", so it hasn't been restarted" : ""}.`);
  if (!plan.restart) return rollingNext(plan);
  try {
    await sendRestart(plan);
  } catch (err) {
    return rollingStop(plan, `${plan.server} wasn't restarted`, err.message || "BossMox lost contact with Proxmox.");
  }
  plan.phase = "restarting";
  plan.startedAt = Date.now();
  saveReboot(plan);
  S.watching = false;
  watchRestart();
}
async function rollingReturn(plan) {
  S.watching = true;
  plan.phase = "returning";
  saveReboot(plan);
  if (!plan.target || !plan.guests.length) return rollingNext(plan);
  const row = (g, home) => `<div class="snap"><div>${esc(g.name)}</div><span class="state"><span class="dot ${home ? "running" : "busy"}"></span>${home ? `Back on ${esc(plan.server)}` : "Moving back"}</span></div>`;
  const draw = (where) => dialog(`<h3>${esc(rollingTitle(plan))}</h3><p>${esc(plan.server)} is back. Moving everything home before the next step.</p><div class="restartlist">${plan.guests.map((g) => row(g, where.get(g.id) === plan.server)).join("")}</div>`);
  const started = Date.now();
  let finishedAt = 0;
  for (;;) {
    try {
      const o = await signal("api/overview");
      S.data = o;
      const where = new Map(o.vms.map((v) => [v.id, v.node]));
      const left = plan.guests.filter((g) => where.get(g.id) !== plan.server);
      draw(where);
      if (!left.length) return rollingNext(plan);
      if (!plan.returnTask) {
        const res = await post("api/action/move-all", { server: plan.target, target: plan.server, guests: left.map((g) => g.id).join(",") });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        plan.returnTask = body.task;
        saveReboot(plan);
      } else {
        const task = await signal(`api/task?server=${encodeURIComponent(plan.target)}&task=${encodeURIComponent(plan.returnTask)}`).catch(() => null);
        if (task?.finished && !finishedAt) finishedAt = Date.now();
      }
      if ((finishedAt && Date.now() - finishedAt > 20000) || Date.now() - started > 30 * 60 * 1000) {
        return rollingStop(plan, `${plan.server} is updated, but guests didn't get home`, `These are still on ${plan.target}: ${left.map((g) => g.name).join(", ")}.`);
      }
    } catch (err) {
      if (err.message === "signed out") {
        S.watching = false;
        return;
      }
      // A server that has just come back can refuse a move for a few seconds, so keep trying for a minute.
      if (!plan.returnTask && Date.now() - started > 60 * 1000) return rollingStop(plan, `${plan.server} is updated, but guests didn't get home`, err.message || "BossMox lost contact with Proxmox.");
    }
    await wait(3000);
  }
}
function rollingNext(plan) {
  const rolling = { ...plan.rolling, index: plan.rolling.index + 1 };
  if (rolling.index < rolling.servers.length) return rollingStep(rolling);
  saveReboot(null);
  S.watching = false;
  const done = !rolling.restarted ? "Nothing needed a restart, so everything kept running." : rolling.restarted === rolling.servers.length ? "Each one restarted, and everything that moved is back where it started." : "The ones that needed it restarted, and everything that moved is back where it started.";
  dialog(`<h3>${rolling.servers.length === 1 ? `${esc(plan.server)} is updated` : `All ${rolling.servers.length} nodes are updated`}</h3><p>${done}</p>${closeRow}`);
  renderHealth();
  loadServer();
}

/* Network, read only for now: a wrong change here can cut off the server, so editing needs its own design. */
async function loadNetwork() {
  const list = $("#netlist");
  if (!list) return;
  const nodes = S.data?.nodes ?? [];
  S.netServer ??= nodes.find((n) => n.online)?.name;
  list.innerHTML = nodes.map((n) => `<button class="row ${n.name === S.netServer ? "on" : ""}" data-netserver="${esc(n.name)}"><span class="dot ${n.online ? "running" : "warn"}"></span><b>${esc(n.name)}</b><small>${n.online ? "Online" : "Offline"}</small></button>`).join("");
  const box = $("#netdetail");
  const asked = S.netServer;
  if (!asked) {
    box.innerHTML = `<p class="empty">Waiting for a node to come online.</p>`;
    return;
  }
  try {
    const n = await signal(`api/network?server=${encodeURIComponent(asked)}`);
    if (asked !== S.netServer || !$("#netdetail")) return;
    const fact = (label, value) => (value ? `<dt>${label}</dt><dd>${esc(value)}</dd>` : "");
    const card = (i) => `<article class="netcard"><header><span class="dot ${i.active ? "running" : ""}"></span><b>${esc(i.name)}</b><small>${esc(i.kind)}${i.active ? "" : ", not connected"}</small></header>
      ${i.note ? `<p class="meta">${esc(i.note)}</p>` : ""}
      <dl class="plain">${fact("Address", i.address)}${fact("Gateway", i.gateway)}${fact("Uses", i.ports.join(", "))}${fact("Part of", i.partOf)}${i.kind === "Virtual switch" ? `<dt>Guests</dt><dd>${esc(i.guests.join(", ") || "None")}</dd>` : ""}</dl></article>`;
    $("#netdetail").innerHTML = `<div class="head"><div><h2>${esc(n.server)}</h2><div class="state">${n.dnsServers.length ? `Looks up names with ${esc(n.dnsServers.join(", "))}` : "No name server set"}${n.searchDomain ? `, in ${esc(n.searchDomain)}` : ""}</div></div></div>
      ${n.interfaces.map(card).join("") || `<p class="empty">This node didn't report any network connections.</p>`}
      <p class="meta">BossMox shows the network but can't change it yet. A wrong change here can cut off the node, so that's coming with a safety net.</p>`;
  } catch (err) {
    if (err.message !== "signed out" && $("#netdetail")) $("#netdetail").innerHTML = `<p class="empty">${esc(err.message || "BossMox lost contact with Proxmox.")}</p>`;
  }
}

/* Creating and deleting VMs and containers */
function startCreate() {
  const server = S.data?.nodes.find((n) => n.online)?.name;
  if (!server) {
    $("#newbox").innerHTML = `<p class="empty">Waiting for a node to come online.</p>`;
    return;
  }
  loadCreate(server, "qemu");
}
async function loadCreate(server, kind) {
  const box = $("#newbox");
  if (!box) return;
  const kept = { name: $("#cname")?.value ?? "", cores: $("#ccores")?.value ?? "2", memory: $("#cmemory")?.value ?? "2", disk: $("#cdisk")?.value ?? "32" };
  try {
    S.createPlan = await signal(`api/create-plan?server=${encodeURIComponent(server)}&kind=${kind}`);
  } catch (err) {
    if (err.message !== "signed out") box.innerHTML = `<p class="empty">${esc(err.message || "BossMox lost contact with Proxmox.")}</p>`;
    return;
  }
  const p = S.createPlan;
  const vm = kind === "qemu";
  const field = (label, html) => `<label class="field"><span>${label}</span>${html}</label>`;
  const nodes = S.data.nodes.filter((n) => n.online);
  box.innerHTML = `<p class="meta" style="margin-top:0">${vm ? "A virtual machine is a full computer with its own operating system." : "A container shares this node's Linux, so it's lighter and starts in seconds."}</p>
    <p class="loginerr" id="cerr" hidden></p>
    ${field("What to create", `<select id="ckind"><option value="qemu" ${vm ? "selected" : ""}>Virtual machine</option><option value="lxc" ${vm ? "" : "selected"}>Container</option></select>`)}
    ${nodes.length > 1 ? field("Node", `<select id="cserver">${nodes.map((n) => `<option ${n.name === server ? "selected" : ""}>${esc(n.name)}</option>`).join("")}</select>`) : `<input type="hidden" id="cserver" value="${esc(server)}">`}
    ${field("Name", `<input id="cname" maxlength="63" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(kept.name)}">`)}
    ${vm ? field("Operating system", `<select id="cos"><option value="linux">Linux</option><option value="windows">Windows</option><option value="other">Something else</option></select>`) : ""}
    ${field(vm ? "Install from" : "Template", `<select id="cinstaller">${vm ? `<option value="">Nothing yet, I'll add a disc later</option>` : ""}${p.installers.map((i) => `<option value="${esc(i.volid)}">${esc(i.label)}</option>`).join("")}</select>`)}
    ${!vm && !p.installers.length ? `<p class="meta">This node has no templates yet, so a container can't be made here.</p>` : ""}
    ${vm ? `<p class="meta" style="margin:-8px 0 14px">${p.installers.length ? "" : "This node has no installer discs yet. "}<button class="linkbtn" data-discadd="1">Add a disc from a web address</button></p>` : ""}
    ${vm ? "" : field("Password for root", `<input id="cpassword" type="password" autocomplete="new-password">`)}
    <div class="createrow">
      ${field(`Processor cores (${p.cores} here)`, `<input id="ccores" type="number" min="1" max="128" value="${esc(kept.cores)}">`)}
      ${field(`Memory in GB (${p.memoryGb} here)`, `<input id="cmemory" type="number" min="0.25" step="0.25" value="${esc(kept.memory)}">`)}
      ${field("Disk in GB", `<input id="cdisk" type="number" min="1" value="${esc(kept.disk)}">`)}
    </div>
    ${field("Keep its disk on", `<select id="cstorage">${p.storages.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}, ${s.freeGb} GB free</option>`).join("")}</select>`)}
    ${field("Network", `<select id="cbridge">${p.bridges.map((b) => `<option>${esc(b)}</option>`).join("")}</select>`)}
    <label class="createcheck"><input id="cstart" type="checkbox"> Start it right away</label>
    <div class="row-end"><button class="btn primary" data-createnew="1">Create</button></div>`;
}
function createGuest() {
  const fail = (m) => {
    const e = $("#cerr");
    e.textContent = m;
    e.hidden = false;
    e.scrollIntoView({ block: "center" });
  };
  const kind = $("#ckind").value;
  const server = $("#cserver").value;
  const name = $("#cname").value.trim();
  const memoryMb = Math.round(Number($("#cmemory").value) * 1024);
  const taken = S.data.vms.find((v) => v.name.toLowerCase() === name.toLowerCase());
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(name)) return fail("A name uses letters, numbers, dots and dashes, and starts and ends with a letter or number.");
  if (taken) return fail(`${taken.name} already exists. Pick another name.`);
  if (!$("#cstorage").value || !$("#cbridge").value) return fail("This node needs a storage and a network first.");
  if (kind === "lxc" && !$("#cinstaller").value) return fail("Pick a template.");
  if (kind === "lxc" && $("#cpassword").value.length < 8) return fail("Give it a password of at least 8 characters.");
  const body = {
    kind, id: S.createPlan.nextId, name, cores: Number($("#ccores").value), memoryMb, diskGb: Number($("#cdisk").value),
    storage: $("#cstorage").value, bridge: $("#cbridge").value, installer: $("#cinstaller").value, os: $("#cos")?.value ?? "linux",
    start: $("#cstart").checked, password: $("#cpassword")?.value ?? "",
  };
  const id = Number(body.id);
  runAction("guest-create", server, `Creating ${name}`, body, async () => {
    await refresh();
    if (S.data?.vms.some((v) => v.id === id)) {
      S.sel = id;
      S.tab = "overview";
      S.filter = "all";
      S.q = "";
      wins.create?.remove();
      delete wins.create;
      openWin("vms");
      render("vms");
    } else if (wins.create) loadCreate(server, kind);
  });
}
function askGuestDelete(id) {
  const v = S.data?.vms.find((g) => g.id === id);
  if (!v) return;
  dialog(`<h3>Delete ${esc(v.name)}?</h3><p>${esc(v.name)} and its disks are erased for good, and its snapshots go too. Backups stay, so it can be restored from one.</p>
    <label class="field restartname"><span>Type ${esc(v.name)} to confirm</span><input id="rname" data-word="${esc(v.name.toLowerCase())}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="rgo" data-guestdeletego="${v.id}" disabled>Delete ${esc(v.name)}</button></div>`);
  $("#rname").focus();
}
function guestDelete(id) {
  const v = S.data.vms.find((g) => g.id === id);
  runAction("guest-delete", v.node, `Deleting ${v.name}`, { ...guestBody(v), confirm: String(v.id) }, async () => {
    S.sel = null;
    await refresh();
  });
}

/* Backups */
async function loadBackups() {
  try {
    S.backups = await signal("api/backups");
    S.backupsError = "";
  } catch (err) {
    if (err.message === "signed out") return;
    S.backupsError = err.message || "BossMox lost contact with Proxmox.";
  }
  drawBackups();
}
const findBackup = (volid) => S.backups?.groups.flatMap((g) => g.backups.map((b) => ({ ...b, group: g }))).find((b) => b.volid === volid);
function backupsPane() {
  const b = S.backups;
  const live = S.data?.vms ?? [];
  const known = new Set(b.groups.map((g) => g.id));
  const missing = live.filter((v) => !known.has(v.id));
  const row = (x) => `<div class="snap"><div>${esc(when(x.takenAt))}<small>${esc(x.size)} on ${esc(x.storage)}, ${esc(x.node)}${x.notes ? `, ${esc(x.notes)}` : ""}</small></div><div class="actions"><button class="btn" data-bkrestore="${esc(x.volid)}">Restore</button><button class="btn" data-bkdelete="${esc(x.volid)}" ${x.locked ? "disabled title=\"This backup is protected\"" : ""}>Delete</button></div></div>`;
  const group = (g) => `<details class="upgroup"><summary>${esc(g.name)} (${g.backups.length}), latest ${esc(when(g.backups[0]?.takenAt))}</summary>
    ${g.exists ? `<div class="actions bknow"><button class="btn" data-bknow="${g.id}">Back up now</button></div>` : ""}${g.backups.map(row).join("")}</details>`;
  return `${b.unscheduled.length ? `<div class="advice"><div><b>${b.unscheduled.length} ${b.unscheduled.length === 1 ? "isn't" : "aren't"} on a backup schedule</b>${esc(b.unscheduled.join(", "))}</div><button class="btn" data-jobadd="1">Add a schedule</button></div>` : ""}
    ${b.groups.map(group).join("")}
    ${missing.length ? `<h3 class="bkhead">No backups yet</h3>${missing.map((v) => `<div class="snap"><div>${esc(v.name)}<small>On ${esc(v.node)}</small></div><button class="btn" data-bknow="${v.id}">Back up now</button></div>`).join("")}` : ""}
    ${!b.groups.length && !missing.length ? `<p class="empty">There's nothing to back up yet.</p>` : ""}`;
}
function schedulesPane() {
  const list = S.backups.schedules;
  return `<div class="row-end" style="margin:0 0 10px"><button class="btn primary" data-jobadd="1">Add a schedule</button></div>
    ${list.length ? list.map((j) => `<div class="snap"><div>${esc(j.when)}<small>${esc(j.what)} to ${esc(j.storage)}${j.keep ? `, keeps the last ${j.keep}` : ""}${j.on && j.nextRun ? `. Next run ${esc(when(j.nextRun))}` : j.on ? "" : ". Paused"}</small></div><div class="actions"><button class="btn" data-jobtoggle="${esc(j.id)}">${j.on ? "Pause" : "Resume"}</button><button class="btn" data-jobdelete="${esc(j.id)}">Delete</button></div></div>`).join("") : `<p class="empty">No schedules yet. Backups only happen when someone remembers to run them.</p>`}`;
}
function drawBackups() {
  const box = $("#bkbox");
  if (!box) return;
  if (!S.backups) {
    box.innerHTML = `<p class="empty">${esc(S.backupsError || "Looking for backups on every node.")}</p>`;
    return;
  }
  S.bkTab ??= "backups";
  const open = new Set([...box.querySelectorAll("details[open] summary")].map((e) => e.textContent));
  box.innerHTML = `<div class="tabs" role="tablist">${[["backups", "Backups"], ["schedules", "Schedules"]].map(([k, l]) => `<button role="tab" aria-selected="${S.bkTab === k}" class="${S.bkTab === k ? "on" : ""}" data-bktab="${k}">${l}</button>`).join("")}</div>
    <div class="tabpane">${S.backupsError ? `<p class="loginerr">${esc(S.backupsError)}</p>` : ""}${S.bkTab === "backups" ? backupsPane() : schedulesPane()}</div>`;
  box.querySelectorAll("details").forEach((e) => {
    if (open.has($("summary", e).textContent)) e.open = true;
  });
}
const failDialog = (title, err) => dialog(`<h3>${esc(title)}</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p>${closeRow}`);
async function askBackupNow(id) {
  const v = S.data?.vms.find((g) => g.id === id);
  if (!v) return;
  try {
    const plan = await signal(`api/reboot-plan?server=${encodeURIComponent(v.node)}`);
    if (!plan.backupStorages.length) return dialog(`<h3>Nowhere to save a backup</h3><p>${esc(v.node)} has no storage set up for backups.</p>${closeRow}`);
    dialog(`<h3>Back up ${esc(v.name)} now?</h3><p>${v.running ? `${esc(v.name)} keeps running, though it may feel slower until this finishes.` : `${esc(v.name)} is off, so this is quick.`}</p>
      <label class="field restartname"><span>Save to</span><select id="bkstore">${plan.backupStorages.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}, ${s.freeGb} GB free</option>`).join("")}</select></label>
      <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-bkgo="${v.id}">Back up ${esc(v.name)}</button></div>`);
  } catch (err) {
    if (err.message !== "signed out") failDialog("Couldn't prepare the backup", err);
  }
}
function backupNow(id) {
  const v = S.data.vms.find((g) => g.id === id);
  runAction("back-up-guests", v.node, `Backing up ${v.name}`, { guests: String(id), storage: $("#bkstore").value }, loadBackups);
}
async function askBackupRestore(volid) {
  const x = findBackup(volid);
  if (!x) return;
  try {
    const plan = await signal(`api/restore-plan?server=${encodeURIComponent(x.node)}&type=${x.type}`);
    if (!plan.storages.length) return dialog(`<h3>Nowhere to restore to</h3><p>${esc(x.node)} has no storage that can hold this.</p>${closeRow}`);
    S.bkPlan = { x, plan };
    dialog(`<h3>Restore ${esc(x.group.name)}?</h3><p>From ${esc(when(x.takenAt))}, on ${esc(x.node)}. A copy sits alongside the original, switched off, and nothing is lost.</p>
      <label class="field restartname"><span>Put its disks on</span><select id="bkdisk">${plan.storages.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>
      <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button>${x.group.exists ? `<button class="btn" data-bkreplace="1">Replace the original</button>` : ""}<button class="btn primary" data-bkcopy="1">${x.group.exists ? "Restore as a copy" : "Restore"}</button></div>`);
  } catch (err) {
    if (err.message !== "signed out") failDialog("Couldn't prepare the restore", err);
  }
}
function restoreCopy() {
  const { x, plan } = S.bkPlan;
  const name = x.group.exists ? `${x.group.name}-copy` : "";
  runAction("backup-restore", x.node, `Restoring ${x.group.name}`, { volid: x.volid, type: x.type, storage: $("#bkdisk").value, guest: String(plan.nextId), name }, async () => {
    await refresh();
    loadBackups();
  });
}
function askBackupReplace() {
  const { x } = S.bkPlan;
  const v = S.data?.vms.find((g) => g.id === x.group.id);
  const storage = $("#bkdisk").value;
  if (v?.running) return dialog(`<h3>Shut down ${esc(v.name)} first</h3><p>BossMox won't replace a guest while it's running. Shut it down in Virtual Machines, then come back to this backup.</p>${closeRow}`);
  S.bkPlan.storage = storage;
  S.bkPlan.node = v?.node ?? x.node;
  if (v && v.node !== x.node) return dialog(`<h3>This backup is on a different node</h3><p>${esc(v.name)} is on ${esc(v.node)}, and this backup is on ${esc(x.node)}. Move ${esc(v.name)} to ${esc(x.node)} first, or restore as a copy.</p>${closeRow}`);
  dialog(`<h3>Replace ${esc(x.group.name)}?</h3><p>${esc(x.group.name)} is erased and rebuilt from ${esc(when(x.takenAt))}. Anything newer on it is gone for good, and its snapshots go too.</p>
    <label class="field restartname"><span>Type replace to confirm</span><input id="rname" data-word="replace" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="rgo" data-bkreplacego="1" disabled>Replace ${esc(x.group.name)}</button></div>`);
  $("#rname").focus();
}
function restoreReplace() {
  const { x, storage } = S.bkPlan;
  runAction("backup-restore", x.node, `Replacing ${x.group.name}`, { volid: x.volid, type: x.type, storage, guest: String(x.group.id), replace: true, confirm: "replace" }, async () => {
    await refresh();
    loadBackups();
  });
}
function askBackupDelete(volid) {
  const x = findBackup(volid);
  if (!x) return;
  confirmAction(`Delete this backup of ${x.group.name}?`, `The backup from ${when(x.takenAt)} on ${x.storage} is gone for good.`, "Delete backup", () => runAction("backup-delete", x.node, `Deleting backup of ${x.group.name}`, { volid, storage: x.storage, confirm: volid }, loadBackups), true);
}
async function askSchedule() {
  const server = S.data?.nodes.find((n) => n.online)?.name;
  if (!server) return;
  try {
    const plan = await signal(`api/reboot-plan?server=${encodeURIComponent(server)}`);
    if (!plan.backupStorages.length) return dialog(`<h3>Nowhere to save backups</h3><p>Set up a storage for backups first.</p>${closeRow}`);
    const days = [["", "Every day"], ["mon", "Mondays"], ["tue", "Tuesdays"], ["wed", "Wednesdays"], ["thu", "Thursdays"], ["fri", "Fridays"], ["sat", "Saturdays"], ["sun", "Sundays"]];
    dialog(`<h3>Add a backup schedule</h3>
      <p class="loginerr" id="joberr" hidden></p>
      <label class="field restartname"><span>What to back up</span><select id="jobwhat"><option value="all">Everything</option>${S.data.vms.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join("")}</select></label>
      <label class="field restartname"><span>Which days</span><select id="jobday">${days.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
      <label class="field restartname"><span>What time, on the node's clock</span><input id="jobtime" type="time" value="02:00"></label>
      <label class="field restartname"><span>Save to</span><select id="jobstore">${plan.backupStorages.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}, ${s.freeGb} GB free</option>`).join("")}</select></label>
      <label class="field restartname"><span>How many backups to keep of each</span><input id="jobkeep" type="number" min="1" max="99" value="3"></label>
      <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-jobsave="${esc(server)}">Add schedule</button></div>`);
  } catch (err) {
    if (err.message !== "signed out") failDialog("Couldn't prepare the schedule", err);
  }
}
function saveSchedule() {
  const time = $("#jobtime").value;
  const keep = Number($("#jobkeep").value);
  if (!time || !Number.isInteger(keep) || keep < 1 || keep > 99) {
    const err = $("#joberr");
    err.textContent = "Pick a time, and keep between 1 and 99 backups.";
    err.hidden = false;
    return;
  }
  const day = $("#jobday").value;
  const server = S.data.nodes.find((n) => n.online).name;
  runAction("schedule-add", server, "Adding the schedule", { schedule: day ? `${day} ${time}` : time, guests: $("#jobwhat").value, storage: $("#jobstore").value, keep }, () => {
    S.bkTab = "schedules";
    loadBackups();
  });
}
function toggleSchedule(id) {
  const j = S.backups.schedules.find((x) => x.id === id);
  const server = S.data?.nodes.find((n) => n.online)?.name;
  if (!j || !server) return;
  const word = j.on ? "Pause" : "Resume";
  confirmAction(`${word} this schedule?`, `${j.when}, ${j.what} to ${j.storage}.`, `${word} schedule`, () => runAction("schedule-toggle", server, `${word} schedule`, { job: id, on: !j.on }, loadBackups));
}
function askScheduleDelete(id) {
  const j = S.backups.schedules.find((x) => x.id === id);
  const server = S.data?.nodes.find((n) => n.online)?.name;
  if (!j || !server) return;
  confirmAction("Delete this schedule?", `${j.when}, ${j.what} to ${j.storage}. Backups it already made stay.`, "Delete schedule", () => runAction("schedule-delete", server, "Deleting the schedule", { job: id, confirm: id }, loadBackups), true);
}

/* Turning a VM or container on and off */
const POWER_WORDS = {
  start: { title: "Start", line: (v) => `${v.name} starts on ${v.node}.` },
  shutdown: { title: "Shut down", line: (v) => `This asks ${v.name} to shut down properly, which can take a minute. If it won't respond, use Force off.` },
  reboot: { title: "Restart", line: (v) => `This asks ${v.name} to restart properly. It's offline until it comes back.` },
  stop: { title: "Force off", line: (v) => `This cuts the power to ${v.name}, like pulling the plug. Anything it hasn't saved is lost. Use it only if Shut down doesn't work.` },
};
const guestBody = (v) => ({ guest: String(v.id), type: v.type });
function askPower(power, id = S.sel) {
  const v = S.data?.vms.find((g) => g.id === id);
  if (!v) return;
  const w = POWER_WORDS[power];
  const help = power === "shutdown" || power === "reboot" ? {
    guest: v.id,
    waiting: `Waiting for ${v.name} to respond. Some systems ignore this request. If it doesn't answer, Proxmox gives up, or you can force it off now.`,
    failed: `${v.name} didn't respond, so it's still running. Some systems ignore this request. Force off cuts the power, and anything unsaved is lost.`,
  } : null;
  confirmAction(`${w.title} ${v.name}?`, w.line(v), `${w.title} ${v.name}`, () => runAction("guest-power", v.node, `${w.title} ${v.name}`, { ...guestBody(v), power, confirm: String(v.id) }, () => refresh(), help), power === "stop");
}

/* Snapshots */
/** Asked when the tab opens, so a person learns this before typing a name. */
async function checkSnapshots(v) {
  if (S.snapSupport?.[v.id] !== undefined) return;
  try {
    const { supported } = await signal(`api/snapshot-support?server=${encodeURIComponent(v.node)}&guest=${v.id}&type=${v.type}`);
    S.snapSupport = { ...S.snapSupport, [v.id]: supported };
    if (S.tab === "snapshots") renderDetail();
  } catch { /* Proxmox still refuses in plain view if this check couldn't run. */ }
}
function askSnapshot() {
  const v = selected();
  if (!v) return;
  dialog(`<h3>Take a snapshot of ${esc(v.name)}?</h3><p>${v.running ? `${esc(v.name)} keeps running.` : ""} Disks are saved, but not what's in memory.</p>
    <p class="loginerr" id="snaperr" hidden></p>
    <label class="field restartname"><span>Name, such as before-update</span><input id="snapname" maxlength="40" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <label class="field restartname"><span>Note, if you want one</span><input id="snapnote" maxlength="200" autocomplete="off"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-snapsave="1">Take snapshot</button></div>`);
  $("#snapname").focus();
}
function saveSnapshot() {
  const v = selected();
  const name = $("#snapname").value.trim();
  if (!/^[A-Za-z][\w-]{1,39}$/.test(name)) {
    const err = $("#snaperr");
    err.textContent = "Start with a letter, then use letters, numbers, dashes or underscores. At least two characters.";
    err.hidden = false;
    return;
  }
  if (v.snapshots.some((s) => s.name === name)) {
    const err = $("#snaperr");
    err.textContent = `${v.name} already has a snapshot called ${name}.`;
    err.hidden = false;
    return;
  }
  runAction("snapshot-take", v.node, `Taking snapshot ${name}`, { ...guestBody(v), snapshot: name, description: $("#snapnote").value.trim() }, () => refresh());
}
function askRestore(name) {
  const v = selected();
  if (!v) return;
  const s = v.snapshots.find((x) => x.name === name);
  dialog(`<h3>Go back to ${esc(name)}?</h3>
    <p>${esc(v.name)} changes back to how it was at ${esc(when(s?.takenAt))}. Anything that changed on it since then is lost.${v.running ? " It stops while this happens, then starts again." : ""}</p>
    <label class="field restartname"><span>Type restore to confirm</span><input id="rname" data-word="restore" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="rgo" data-snapback="${esc(name)}" disabled>Go back to ${esc(name)}</button></div>`);
  $("#rname").focus();
}
function doRestore(name) {
  const v = selected();
  runAction("snapshot-restore", v.node, `Going back to ${name}`, { ...guestBody(v), snapshot: name, confirm: "restore", start: v.running }, () => refresh());
}
function askDeleteSnapshot(name) {
  const v = selected();
  if (!v) return;
  confirmAction(`Delete snapshot ${name}?`, `You won't be able to go back to it. ${v.name} itself doesn't change.`, `Delete ${name}`, () => runAction("snapshot-delete", v.node, `Deleting snapshot ${name}`, { ...guestBody(v), snapshot: name, confirm: name }, () => refresh()), true);
}

/* Moving a VM or container */
async function startMove(id) {
  const v = S.data?.vms.find((g) => g.id === id);
  if (!v) return;
  const fail = (m) => dialog(`<h3>Can't move ${esc(v.name)}</h3><p class="loginerr">${esc(m)}</p><div class="row-end"><button class="btn" data-dlg="cancel">Close</button></div>`);
  let plan;
  try {
    plan = await signal(`api/move-plan?server=${encodeURIComponent(v.node)}&guest=${v.id}&type=${v.type}`);
  } catch (err) {
    return fail(err.message);
  }
  if (plan.localResources) return fail("It uses hardware attached to this node, such as a USB device, so it has to stay here.");
  if (!plan.targets.length) return fail(plan.blocked.length ? `No other node can take it. ${plan.blocked.map((b) => `${b.name} is missing ${b.storages.join(", ")}`).join(". ")}.` : "There's no other online node to move it to.");
  S.move = { v };
  const words = plan.interrupts
    ? `${v.name} will shut down, move, and start again on the new node, so it will be offline for a short time.`
    : v.running ? `${v.name} keeps running while it moves.` : `${v.name} is off, so it will just be moved.`;
  dialog(`<h3>Move ${esc(v.name)}?</h3><p>${esc(words)} It's on ${esc(v.node)} now.${plan.localDisks ? " Its disks are copied too, which can take a while." : ""}</p>
    <label class="field restartname"><span>Move to</span><select id="mtarget">${plan.targets.map((n) => `<option>${esc(n)}</option>`).join("")}</select></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-movego="1">Move ${esc(v.name)}</button></div>`);
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
  const plan = savedReboot();
  if (plan?.rolling && plan.phase === "installing") rollingAfterInstall(plan);
}
async function openTerminal(server) {
  if (term) return openWin("terminal");
  try {
    const res = await post("api/action/install-updates", { server });
    const body = await res.json();
    if (res.status === 401) return showLogin("You've been signed out. Sign in again to continue.");
    if (!res.ok) throw new Error(body.error);
    showTerminal(server, body.terminal, "Install updates", `Updating ${esc(server)}. Check the list, then type <b>Y</b> and press Enter to install.`);
  } catch (err) {
    const plan = savedReboot();
    if (plan?.rolling && plan.phase === "installing") return rollingInstall(plan, err.message || "BossMox lost contact with Proxmox.");
    dialog(`<h3>Couldn't start the install</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p><div class="row-end"><button class="btn" data-dlg="cancel">Close</button></div>`);
  }
}
function showTerminal(server, id, title, help, guest = null) {
  const isConsole = guest !== null;
  const buttons = typeof guest === "number" ? `<div class="actions conacts" data-guest="${guest}"></div>` : "";
  APPS.terminal.title = title;
  {
    openWin("terminal");
    $(".wbody", wins.terminal).innerHTML = `<div class="termwrap">${isConsole ? `<div class="vnctools"><span>${help}</span>${buttons}</div>` : `<p class="termhelp">${help}</p>`}<div id="termbox"></div></div>`;
    const dark = { background: "#07161C", foreground: "#CFE6DF" };
    const xterm = new Terminal({ cursorBlink: true, fontFamily: "ui-monospace,Consolas,monospace", fontSize: 14, theme: dark, scrollback: 10000 });
    const fit = new FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.open($("#termbox"));
    fit.fit();
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal?id=${encodeURIComponent(id)}`, "binary");
    socket.binaryType = "arraybuffer";
    const utf8 = new TextEncoder();
    const resize = () => {
      fit.fit();
      if (socket.readyState === 1) socket.send(`1:${xterm.cols}:${xterm.rows}:`);
    };
    socket.onopen = () => {
      resize();
      xterm.focus();
      drawConsoleActions();
    };
    const decoder = new TextDecoder();
    let recent = "";
    socket.onmessage = (e) => {
      const bytes = new Uint8Array(e.data);
      xterm.write(bytes);
      if (term?.done || isConsole) return;
      // Proxmox prints this when the updater finishes, then leaves a root shell open.
      recent = (recent + decoder.decode(bytes)).slice(-200);
      if (recent.includes("starting shell") && term) {
        term.done = true;
        $(".termhelp").textContent = savedReboot()?.rolling && savedReboot().restart ? `The updater has finished on ${server}. Check the output, then close this window and BossMox restarts ${server}.` : `The updater has finished on ${server}. Check the output, then close this window.`;
      }
    };
    socket.onclose = () => {
      if (term?.socket === socket) {
        term.done = true;
        xterm.write("\r\n\r\nThe session has ended. You can close this window.\r\n");
      }
      drawConsoleActions();
    };
    xterm.onData((d) => {
      if (socket.readyState === 1) socket.send(`0:${utf8.encode(d).length}:${d}`);
    });
    const observer = new ResizeObserver(resize);
    observer.observe($("#termbox"));
    const ping = setInterval(() => socket.readyState === 1 ? socket.send("2") : clearInterval(ping), 30000);
    term = { socket, xterm, observer, server, done: isConsole, guest };
    drawConsoleActions();
  }
}

/* Console: a container gets a terminal, and a VM shows its screen */
let vnc = null;
function closeVnc() {
  const old = vnc;
  vnc = null;
  S.vncUp = null;
  old?.disconnect();
}
/** The power buttons in a console window. They follow the guest, so they stay right if it changes from elsewhere. */
function drawConsoleActions() {
  document.querySelectorAll(".conacts").forEach((el) => {
    const id = Number(el.dataset.guest);
    const v = S.data?.vms.find((g) => g.id === id);
    if (!v) return;
    const screen = el.closest(".vncwrap") !== null;
    const up = screen ? S.vncUp === id : term?.socket?.readyState === 1;
    const button = (power, label) => `<button class="btn" data-power="${power}" data-guest="${id}">${label}</button>`;
    const html = `${up || !v.running ? "" : `<button class="btn primary" data-console="${id}">Reconnect</button>`}
      ${v.running ? button("shutdown", "Shut down") + button("reboot", "Restart") + button("stop", "Force off") : button("start", "Start")}
      ${screen && up ? `<button class="btn" data-vnccad="1">Send Ctrl+Alt+Del</button>` : ""}`;
    if (el.dataset.drawn !== html) {
      el.dataset.drawn = html;
      el.innerHTML = html;
    }
  });
}
function loadNoVnc() {
  if (window.NoVNC) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/novnc.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("BossMox couldn't load the console."));
    document.head.append(s);
  });
}
async function openNodeConsole(server) {
  if (term) return dialog(`<h3>A terminal is already open</h3><p>Close it first, then open this console.</p>${closeRow}`);
  try {
    const res = await post("api/action/node-console", { server });
    const body = await res.json();
    if (res.status === 401) return showLogin("You've been signed out. Sign in again to continue.");
    if (!res.ok) throw new Error(body.error);
    showTerminal(server, body.terminal, `Console: ${server}`, `Console for ${esc(server)}. Anything you run here changes the node right away.`, "node");
  } catch (err) {
    dialog(`<h3>Couldn't open the console</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p>${closeRow}`);
  }
}
async function openConsole(id) {
  const v = S.data?.vms.find((g) => g.id === id);
  if (!v) return;
  if (v.type === "lxc" && term) {
    if (term.guest !== id) return dialog(`<h3>A terminal is already open</h3><p>Close it first, then open this console.</p>${closeRow}`);
    closeTerminal();
  }
  try {
    const res = await post("api/action/guest-console", { server: v.node, ...guestBody(v) });
    const body = await res.json();
    if (res.status === 401) return showLogin("You've been signed out. Sign in again to continue.");
    if (!res.ok) throw new Error(body.error);
    if (body.terminal) return showTerminal(v.node, body.terminal, `Console: ${v.name}`, `Console for ${esc(v.name)}. Log in with its own account.`, v.id);
    await loadNoVnc();
    closeVnc();
    if (wins.console) {
      wins.console.remove();
      delete wins.console;
    }
    APPS.console.title = `Console: ${v.name}`;
    openWin("console");
    $(".conacts", wins.console).dataset.guest = v.id;
    drawConsoleActions();
    const state = (t) => { if ($("#vncstate")) $("#vncstate").textContent = t; };
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal?id=${encodeURIComponent(body.screen)}`;
    const rfb = new NoVNC.default($("#vncbox"), url, { credentials: { password: body.password }, wsProtocols: ["binary"] });
    rfb.scaleViewport = true;
    rfb.addEventListener("connect", () => {
      if (vnc !== rfb) return;
      S.vncUp = v.id;
      state(`Connected to ${v.name}. Click the screen to type.`);
      drawConsoleActions();
      rfb.focus();
    });
    rfb.addEventListener("disconnect", () => {
      if (vnc !== rfb) return;
      S.vncUp = null;
      state(`The console for ${v.name} has closed.`);
      drawConsoleActions();
    });
    rfb.addEventListener("credentialsrequired", () => rfb.sendCredentials({ password: body.password }));
    vnc = rfb;
  } catch (err) {
    dialog(`<h3>Couldn't open the console</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p>${closeRow}`);
  }
}

/* Changing a VM or container's settings */
async function askGuestEdit(id) {
  const v = S.data?.vms.find((g) => g.id === id);
  if (!v) return;
  let discs = null;
  if (v.type === "qemu" && !v.discLocked) {
    try {
      discs = (await signal(`api/create-plan?server=${encodeURIComponent(v.node)}&kind=qemu`)).installers;
    } catch (err) {
      if (err.message === "signed out") return;
    }
  }
  S.editing = v.id;
  const known = discs?.some((d) => d.volid === v.disc);
  dialog(`<h3>Change ${esc(v.name)}</h3>${v.running ? `<p>It's running, so new cores and memory apply the next time it's shut down and started.</p>` : ""}
    <p class="loginerr" id="editerr" hidden></p>
    <label class="field restartname"><span>Name</span><input id="ename" maxlength="63" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(v.name)}"></label>
    <div class="createrow"><label class="field"><span>Processor cores</span><input id="ecores" type="number" min="1" max="128" value="${v.cores}"></label>
    <label class="field"><span>Memory in GB</span><input id="ememory" type="number" min="0.25" step="0.25" value="${v.memoryMb / 1024}"></label></div>
    ${discs ? `<label class="field"><span>Installer disc</span><select id="edisc"><option value="">No disc</option>${v.disc && !known ? `<option value="${esc(v.disc)}" selected>${esc(v.disc)}</option>` : ""}${discs.map((d) => `<option value="${esc(d.volid)}" ${d.volid === v.disc ? "selected" : ""}>${esc(d.label)}</option>`).join("")}</select></label>` : ""}
    <label class="createcheck"><input id="eboot" type="checkbox" ${v.startsAtBoot ? "checked" : ""}> Start when its node starts</label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-guestsave="1">Save</button></div>`);
}
function saveGuestEdit() {
  const v = S.data.vms.find((g) => g.id === S.editing);
  const name = $("#ename").value.trim();
  const memoryMb = Math.round(Number($("#ememory").value) * 1024);
  const taken = S.data.vms.find((g) => g.id !== v.id && g.name.toLowerCase() === name.toLowerCase());
  if (taken) {
    const e = $("#editerr");
    e.textContent = `${taken.name} already exists. Pick another name.`;
    e.hidden = false;
    return;
  }
  const disc = $("#edisc") ? $("#edisc").value : undefined;
  runAction("guest-settings", v.node, `Saving ${name}`, { ...guestBody(v), name, cores: Number($("#ecores").value), memoryMb, startsAtBoot: $("#eboot").checked, ...(disc === undefined ? {} : { disc }) }, async () => {
    await refresh();
    renderDetail();
  });
}

/* Getting an installer disc onto a server from a web address */
function askDisc() {
  const server = $("#cserver").value;
  const stores = S.createPlan?.mediaStorages ?? [];
  if (!stores.length) return dialog(`<h3>Nowhere to keep a disc</h3><p>${esc(server)} has no storage set up for installer discs.</p>${closeRow}`);
  dialog(`<h3>Add an installer disc</h3><p>${esc(server)} downloads it directly, so this doesn't use your own connection. Paste the address of an .iso file.</p>
    <p class="loginerr" id="discerr" hidden></p>
    <label class="field restartname"><span>Web address</span><input id="discurl" type="url" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <label class="field restartname"><span>Keep it on</span><select id="discstore">${stores.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-discgo="1">Download</button></div>`);
  $("#discurl").focus();
}
function downloadDisc() {
  const url = $("#discurl").value.trim();
  const server = $("#cserver").value;
  if (!/^https?:\/\/\S+\.iso$/i.test(url)) {
    const e = $("#discerr");
    e.textContent = "Use an address that starts with https and ends in .iso.";
    e.hidden = false;
    return;
  }
  const kind = $("#ckind").value;
  runAction("disc-download", server, "Downloading the disc", { url, storage: $("#discstore").value }, () => loadCreate(server, kind));
}

const RENDER = {
  terminal: () => "",
  console: () => `<div class="vncwrap"><div class="vnctools"><span id="vncstate">Connecting.</span><div class="actions conacts"></div></div><div id="vncbox"></div></div>`,
  vms: vmsShell, monitor: monView, storage: storeView,
  create: () => `<div id="newbox" class="bkbox"></div>`,
  network: () => `<div class="vms"><aside><div id="netlist"></div></aside><div id="netdetail"></div></div>`,
  backups: () => `<div id="bkbox" class="bkbox"></div>`,
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
  if (d.close === "console") closeVnc();
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
  if (d.moveback) {
    closeDialog();
    return askMoveBack(d.moveback);
  }
  if (d.taskleave || d.forceoff) {
    // Whatever is running carries on in Proxmox. BossMox just stops following it.
    S.taskToken++;
    S.taskRunning = false;
    S.afterTask = null;
    if (d.forceoff) return askPower("stop", +d.forceoff);
    closeDialog();
    return refresh();
  }
  if (d.guestdelete) return askGuestDelete(+d.guestdelete);
  if (d.guestdeletego) {
    t.disabled = true;
    return guestDelete(+d.guestdeletego);
  }
  if (d.createnew) return createGuest();
  if (d.console) return openConsole(+d.console);
  if (d.nodeconsole) return openNodeConsole(d.nodeconsole);
  if (d.vnccad) return vnc?.sendCtrlAltDel();
  if (d.guestedit) return askGuestEdit(+d.guestedit);
  if (d.guestsave) return saveGuestEdit();
  if (d.discadd) return askDisc();
  if (d.discgo) return downloadDisc();
  if (d.netserver) {
    S.netServer = d.netserver;
    return loadNetwork();
  }
  if (d.bktab) {
    S.bkTab = d.bktab;
    return drawBackups();
  }
  if (d.bknow) return askBackupNow(+d.bknow);
  if (d.bkgo) return backupNow(+d.bkgo);
  if (d.bkrestore) return askBackupRestore(d.bkrestore);
  if (d.bkcopy) return restoreCopy();
  if (d.bkreplace) return askBackupReplace();
  if (d.bkreplacego) {
    t.disabled = true;
    return restoreReplace();
  }
  if (d.bkdelete) return askBackupDelete(d.bkdelete);
  if (d.jobadd) return askSchedule();
  if (d.jobsave) return saveSchedule();
  if (d.jobtoggle) return toggleSchedule(d.jobtoggle);
  if (d.jobdelete) return askScheduleDelete(d.jobdelete);
  if (d.power) return askPower(d.power, d.guest ? +d.guest : S.sel);
  if (d.snaptake) return askSnapshot();
  if (d.snapsave) return saveSnapshot();
  if (d.snaprestore) return askRestore(d.snaprestore);
  if (d.snapback) {
    t.disabled = true;
    return doRestore(d.snapback);
  }
  if (d.snapdelete) return askDeleteSnapshot(d.snapdelete);
  if (d.move) return startMove(+d.move);
  if (d.movego) {
    const { v } = S.move;
    const target = $("#mtarget").value;
    S.move = null;
    return runAction("move-guest", v.node, `Moving ${v.name} to ${target}`, { guest: String(v.id), type: v.type, target, confirm: String(v.id) }, () => refresh());
  }
  if (d.restart) {
    t.disabled = true;
    return doRestart(d.restart);
  }
  if (d.rolling) return startRolling();
  if (d.rollinggo) {
    t.disabled = true;
    const servers = S.rollingPlan.servers.map((v) => v.name);
    S.rollingPlan = null;
    return rollingStep({ servers, index: 0 });
  }
  if (d.rollinginstall) {
    closeDialog();
    return openTerminal(savedReboot().server);
  }
  if (d.rollingstop) {
    const plan = savedReboot();
    return rollingStop(plan, `${plan.server} wasn't updated`, `Nothing was installed on ${plan.server}.`);
  }
  if (d.restartclose) {
    const plan = savedReboot();
    if (plan && (plan.rolling || plan.phase === "moving")) keepMoved(plan);
    saveReboot(null);
    S.watching = false;
    if (plan?.phase === "moving") {
      return dialog(`<h3>${esc(plan.server)} won't restart</h3><p>Anything already moving will finish moving. To send it back afterward, use Move everything back on the node's Overview.${plan.rolling ? ` ${esc(notTouched(plan))}` : ""}</p>${closeRow}`);
    }
    if (plan?.rolling && plan.phase === "restarting") {
      return dialog(`<h3>BossMox stopped following the update</h3><p>${esc(plan.server)} is still restarting. To send its guests back afterward, use Move everything back on the node's Overview. ${esc(notTouched(plan))}</p>${closeRow}`);
    }
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
    return confirmAction(`Install ${n} updates on ${server}?`, S.detail?.updates?.rebootNeeded ? "This opens a terminal on the node and installs in the foreground. A restart will be needed afterward. You'll get one more chance to review the list." : "This opens a terminal on the node and installs in the foreground. You'll get one more chance to review the list.", `Open installer for ${server}`, () => openTerminal(server));
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
document.addEventListener("change", (e) => {
  if (e.target.id === "ckind" || e.target.id === "cserver") loadCreate($("#cserver").value, $("#ckind").value);
});
document.addEventListener("input", (e) => {
  if (e.target.id === "rname") {
    $("#rgo").disabled = e.target.value.trim().toLowerCase() !== (e.target.dataset.word ?? "reboot");
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
  S.watching = false;
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
  drawConsoleActions();
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
