const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const GLYPHS = {
  vms: '<rect x="4" y="5" width="24" height="16" rx="2"/><path d="M11 27h10M16 21v6"/><path d="M12 13l3 3 5-6"/>',
  create: '<path d="M16 6v20M6 16h20"/>',
  monitor: '<path d="M4 17h6l3-9 5 16 3-7h7"/>',
  storage: '<ellipse cx="16" cy="8" rx="11" ry="4"/><path d="M5 8v16c0 2 5 4 11 4s11-2 11-4V8M5 16c0 2 5 4 11 4s11-2 11-4"/>',
  network: '<circle cx="16" cy="6" r="3"/><circle cx="6" cy="25" r="3"/><circle cx="26" cy="25" r="3"/><path d="M16 9v8M16 17H6v5M16 17h10v5"/>',
  backups: '<path d="M5 16a11 11 0 1 0 4-8.5L5 11V5"/><path d="M16 10v7l5 3"/>',
  health: '<path d="M16 27s-10-6-10-13a5.5 5.5 0 0 1 10-3 5.5 5.5 0 0 1 10 3c0 7-10 13-10 13z"/><path d="M9 16h4l2-4 3 7 2-3h3"/>',
  settings: '<path d="M5 9h4M15 9h12M5 16h12M23 16h4M5 23h2M13 23h14"/><circle cx="12" cy="9" r="3"/><circle cx="20" cy="16" r="3"/><circle cx="10" cy="23" r="3"/>',
};
const APPS = {
  vms: { title: "Virtual Machines", color: "#0E7EA6", w: 920, h: 610 },
  create: { title: "Create a VM", color: "#178A5F", w: 560, h: 640 },
  monitor: { title: "Nodes", color: "#7A5AC8", w: 900, h: 620 },
  storage: { title: "Storage", color: "#B9680A", w: 760, h: 610 },
  network: { title: "Network", color: "#2F7A7E", w: 860, h: 580 },
  tasklog: { title: "All tasks", color: "#3C6E9E", w: 860, h: 610, noIcon: true },
  backups: { title: "Backups", color: "#C43838", w: 860, h: 610 },
  health: { title: "Health check", color: "#178A5F", w: 760, h: 640 },
  settings: { title: "Settings", color: "#56636E", w: 720, h: 620 },
  terminal: { title: "Install updates", color: "#20262A", w: 860, h: 560, noIcon: true },
  console: { title: "Console", color: "#20262A", w: 980, h: 680, noIcon: true },
};

const S = { setChoice: {}, watching: false, data: null, sel: null, tab: "overview", filter: "all", q: "", z: 100, failed: false, server: null, serverTab: "overview", detail: null, detailError: "", details: {}, nets: {}, loadRun: 0, ticks: 0 };
const wins = {};

/* Desktop */
$("#icons").innerHTML = Object.entries(APPS).filter(([, a]) => !a.noIcon).map(([k, a]) => `
  <button class="icon" data-open="${k}"><span class="tile" style="background:${a.color}"><svg viewBox="0 0 32 32">${GLYPHS[k]}</svg></span>${a.title}</button>`).join("");

/*
 * Icons can be dragged to any spot on the desktop (ADR 0021). They snap to a grid, a drop on another icon swaps
 * the two, and the layout is kept per browser. Keyboard order follows reading order. Phone width keeps the fixed grid. Alt and an arrow key move the
 * focused icon; right-clicking the desktop offers Line up icons.
 */
const ICON_KEY = "bossmox.icons";
const CELL_W = 110, CELL_H = 124, EDGE = 26;
/** The fixed app order: the default layout, never the order the icons happen to sit in the page. */
const iconApps = () => Object.keys(APPS).filter((k) => !APPS[k].noIcon);
const freeIcons = () => !matchMedia("(max-width:760px)").matches;
function readIconSpots() {
  try {
    const saved = JSON.parse(localStorage.getItem(ICON_KEY) ?? "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}
function saveIconSpots(spots) {
  try {
    localStorage.setItem(ICON_KEY, JSON.stringify(spots));
  } catch {
    // Storage can be off (a private window); the layout then lasts until the page closes.
  }
}
/** How many cells fit: across up to the health panel, down to the bottom of the desktop. */
function iconRoom() {
  const desk = $("#desk").getBoundingClientRect();
  const side = $("#side").getBoundingClientRect();
  const right = side.width ? side.left - desk.left - 12 : desk.width - EDGE;
  return { cols: Math.max(1, Math.floor((right - EDGE + 6) / CELL_W)), rows: Math.max(1, Math.floor((desk.height - EDGE * 2 + 10) / CELL_H)) };
}
/** Every icon gets a cell inside the room: its saved one if free and still on screen, otherwise the first free one. */
function iconPlan(spots) {
  const { cols, rows } = iconRoom();
  const taken = new Set();
  const plan = {};
  const apps = iconApps();
  apps.forEach((app) => {
    const s = spots[app];
    if (!Array.isArray(s) || s.length !== 2) return;
    const [c, r] = s.map(Number);
    if (!Number.isInteger(c) || !Number.isInteger(r) || c < 0 || r < 0 || c >= cols || r >= rows || taken.has(`${c},${r}`)) return;
    plan[app] = [c, r];
    taken.add(`${c},${r}`);
  });
  // The default fills two columns, across then down, as the fixed grid always did.
  const free = [];
  for (let c = 0; c < Math.max(cols, 2); c++) for (let r = 0; r < rows; r++) free.push([c, r]);
  const twoUp = (i) => [i % Math.min(cols, 2), Math.floor(i / Math.min(cols, 2))];
  apps.forEach((app, i) => {
    if (plan[app]) return;
    let cell = twoUp(i);
    if (taken.has(`${cell[0]},${cell[1]}`) || cell[1] >= rows) cell = free.find(([c, r]) => !taken.has(`${c},${r}`)) ?? cell;
    plan[app] = cell;
    taken.add(`${cell[0]},${cell[1]}`);
  });
  return plan;
}
function layoutIcons() {
  const box = $("#icons");
  if (!freeIcons() || $("#desk").hidden) {
    box.classList.remove("free");
    box.querySelectorAll(".icon").forEach((b) => {
      b.style.removeProperty("left");
      b.style.removeProperty("top");
    });
    return;
  }
  box.classList.add("free");
  const plan = iconPlan(readIconSpots());
  const buttons = [...box.querySelectorAll(".icon")];
  for (const b of buttons) {
    if (b.classList.contains("dragging")) continue;
    const [c, r] = plan[b.dataset.open];
    b.style.left = `${EDGE + c * CELL_W}px`;
    b.style.top = `${EDGE + r * CELL_H}px`;
  }
  // Tab order follows reading order: across each row, then down.
  buttons.sort((a, b) => plan[a.dataset.open][1] - plan[b.dataset.open][1] || plan[a.dataset.open][0] - plan[b.dataset.open][0]).forEach((b) => {
    box.append(b);
  });
}
/** Puts an app's icon in a cell. Another icon already there swaps into the cell this one left. */
function moveIcon(app, cell) {
  const plan = iconPlan(readIconSpots());
  const from = plan[app];
  const other = Object.keys(plan).find((k) => k !== app && plan[k][0] === cell[0] && plan[k][1] === cell[1]);
  if (other) plan[other] = from;
  plan[app] = cell;
  saveIconSpots(plan);
  layoutIcons();
}
let iconDrag = null;
let swallowClick = false;
$("#icons").addEventListener("pointerdown", (e) => {
  const b = e.target.closest(".icon");
  if (!b || e.button !== 0 || !$("#icons").classList.contains("free")) return;
  iconDrag = { b, x: e.clientX, y: e.clientY, left: b.offsetLeft, top: b.offsetTop, moving: false };
});
document.addEventListener("pointermove", (e) => {
  const d = iconDrag;
  if (!d) return;
  const dx = e.clientX - d.x, dy = e.clientY - d.y;
  if (!d.moving) {
    if (Math.hypot(dx, dy) < 6) return;
    d.moving = true;
    d.b.classList.add("dragging");
    d.b.setPointerCapture?.(e.pointerId);
  }
  d.b.style.left = `${d.left + dx}px`;
  d.b.style.top = `${d.top + dy}px`;
});
document.addEventListener("pointerup", () => {
  const d = iconDrag;
  iconDrag = null;
  if (!d?.moving) return;
  d.b.classList.remove("dragging");
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 0);
  const { cols, rows } = iconRoom();
  const col = Math.min(cols - 1, Math.max(0, Math.round((d.b.offsetLeft - EDGE) / CELL_W)));
  const row = Math.min(rows - 1, Math.max(0, Math.round((d.b.offsetTop - EDGE) / CELL_H)));
  moveIcon(d.b.dataset.open, [col, row]);
});
document.addEventListener("pointercancel", () => {
  if (!iconDrag) return;
  iconDrag.b.classList.remove("dragging");
  iconDrag = null;
  layoutIcons();
});
// A drag ends with a click on the icon; that click mustn't open the app.
$("#icons").addEventListener("click", (e) => {
  if (!swallowClick) return;
  e.stopPropagation();
  e.preventDefault();
}, true);
$("#icons").addEventListener("keydown", (e) => {
  const b = e.target.closest(".icon");
  const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!b || !e.altKey || !step || !$("#icons").classList.contains("free")) return;
  e.preventDefault();
  const { cols, rows } = iconRoom();
  const [c, r] = iconPlan(readIconSpots())[b.dataset.open];
  moveIcon(b.dataset.open, [Math.min(cols - 1, Math.max(0, c + step[0])), Math.min(rows - 1, Math.max(0, r + step[1]))]);
  b.focus();
});
function closeDeskMenu() {
  $("#deskmenu")?.remove();
}
$("#desk").addEventListener("contextmenu", (e) => {
  if (!$("#icons").classList.contains("free") || e.target.closest("#side")) return;
  e.preventDefault();
  closeDeskMenu();
  const m = document.createElement("div");
  m.id = "deskmenu";
  m.setAttribute("role", "menu");
  m.innerHTML = `<button role="menuitem" data-lineup="1">Line up icons</button>`;
  m.style.left = `${Math.min(e.clientX, innerWidth - 180)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - 60)}px`;
  document.body.append(m);
  m.querySelector("button").focus();
});
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#deskmenu")) closeDeskMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDeskMenu();
});
new ResizeObserver(() => layoutIcons()).observe($("#desk"));

const count = (n) => ["No things", "One thing", "Two things", "Three things"][n] ?? `${n} things`;
function overallBars(c, nodeCount) {
  const size = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} TB` : `${Math.round(n * 10) / 10} GB`);
  const bar = (label, value, pct) => `<div><span>${label}<small>${value}</small></span><div class="meter"><i style="width:${Math.min(pct, 100)}%"></i></div></div>`;
  return `<div class="overall" aria-label="${nodeCount === 1 ? "This node" : "Whole cluster"}">
    ${bar(nodeCount === 1 ? "Processor" : "Cluster processor", `${c.cpuPct}% of ${c.cores} cores`, c.cpuPct)}
    ${bar(nodeCount === 1 ? "Memory" : "Cluster memory", `${size(c.memUsedGb)} of ${size(c.memTotalGb)}`, c.memPct)}
    ${bar(nodeCount === 1 ? "Storage" : "Cluster storage", `${size(c.diskUsedGb)} of ${size(c.diskTotalGb)}`, c.diskPct)}
  </div>`;
}
function ago(t) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - (t ?? 0)));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return when(t);
}
function renderTaskFeed() {
  const box = $("#taskfeed");
  const feed = S.data?.tasks;
  box.hidden = !feed;
  if (!feed) return;
  const dot = { running: "busy", ok: "running", warning: "warn", failed: "warn" };
  const word = { running: "Running", ok: "Finished", warning: "Finished with warnings", failed: "Failed" };
  const row = (t) => `<button class="taskrow ${t.result === "failed" ? "bad" : ""}" data-taskview="${esc(t.upid)}" data-tasknode="${esc(t.node)}"><span class="dot ${dot[t.result]}"></span><span><b>${esc(t.what)}${t.target ? `: ${esc(t.target)}` : ""}</b><small>${word[t.result]} on ${esc(t.node)}, ${esc(ago(t.result === "running" ? t.startedAt : t.endedAt ?? t.startedAt))}</small></span></button>`;
  box.innerHTML = `<h2>Tasks</h2><p class="sub">${feed.running ? `${feed.running} running now` : "Nothing running now"}</p>
    ${feed.items.length ? `<div class="taskrows">${feed.items.map(row).join("")}</div>` : `<p class="meta">Nothing has run recently.</p>`}
    <p class="seeall"><button class="linkbtn" data-tasklog="all">See all tasks</button></p>`;
}
/* Every task on every node. The list arrives whole, so choosing a node or typing in the search box is instant. */
const taskRow = (t) => {
  const dot = { running: "busy", ok: "running", warning: "warn", failed: "warn" };
  const word = { running: "Running", ok: "Finished", warning: "Finished with warnings", failed: "Failed" };
  return `<button class="taskrow ${t.result === "failed" ? "bad" : ""}" data-taskview="${esc(t.upid)}" data-tasknode="${esc(t.node)}"><span class="dot ${dot[t.result]}"></span><span><b>${esc(t.what)}${t.target ? `: ${esc(t.target)}` : ""}</b><small>${esc(word[t.result])} on ${esc(t.node)}, ${esc(when(t.startedAt))}${t.who ? `, by ${esc(t.who)}` : ""}</small></span></button>`;
};
function drawTaskLog() {
  const list = $("#tlnodes");
  const rows = $("#tlrows");
  if (!list || !rows) return;
  const nodes = S.data?.nodes ?? [];
  const on = S.tlNode ?? "all";
  const log = S.taskLog;
  const count = (name) => {
    if (!log) return "";
    const n = log.items.filter((t) => name === "all" || t.node === name).length;
    return `<small>${n}${log.more ? "+" : ""} ${n === 1 ? "task" : "tasks"}</small>`;
  };
  const dotFor = (n) => `<span class="dot ${n.online ? "running" : "warn"}"></span>`;
  list.innerHTML = [`<button class="row ${on === "all" ? "on" : ""}" data-tlnode="all"><span></span><b>All nodes</b>${count("all")}</button>`,
    ...nodes.map((n) => `<button class="row ${n.name === on ? "on" : ""}" data-tlnode="${esc(n.name)}">${dotFor(n)}<b>${esc(n.name)}</b>${count(n.name)}</button>`)].join("");
  if (!log) {
    rows.innerHTML = `<p class="empty">${esc(S.taskLogError || "Looking for tasks on every node.")}</p>`;
    return;
  }
  const q = (S.tlQ ?? "").toLowerCase();
  const shown = log.items.filter((t) => (on === "all" || t.node === on)
    && (S.tlShow !== "problems" || t.result === "failed" || t.result === "warning")
    && `${t.what} ${t.target} ${t.who}`.toLowerCase().includes(q));
  const paged = shown.slice(0, S.tlRows ?? 200);
  const missing = log.unreachable.filter((n) => on === "all" || n === on);
  rows.innerHTML = `${missing.length ? `<p class="meta">Couldn't reach ${esc(missing.join(", "))}, so its tasks aren't here.</p>` : ""}
    ${paged.map(taskRow).join("") || `<p class="empty">No tasks match.</p>`}
    ${shown.length > paged.length || log.more ? `<p class="seeall"><button class="linkbtn" data-tlmore="1">Show more</button></p>` : ""}`;
}
async function loadTaskLog() {
  const run = S.loadRun;
  try {
    const log = await signal(`api/tasks?limit=${S.tlLimit ?? 200}`);
    if (run !== S.loadRun) return;
    const changed = JSON.stringify(log) !== JSON.stringify(S.taskLog);
    S.taskLog = log;
    S.taskLogError = "";
    if (changed) drawTaskLog();
  } catch (err) {
    if (err.message === "signed out" || run !== S.loadRun) return;
    S.taskLogError = err.message || "BossMox lost contact with Proxmox.";
    if (!S.taskLog) drawTaskLog();
  }
}
function moreTasks() {
  S.tlRows = (S.tlRows ?? 200) + 200;
  const log = S.taskLog;
  if (log?.more && S.tlRows > (S.tlLimit ?? 200)) {
    S.tlLimit = Math.min((S.tlLimit ?? 200) * 2, 2000);
    return loadTaskLog();
  }
  drawTaskLog();
}
async function viewTask(node, upid) {
  const title = S.data?.tasks.items.find((t) => t.upid === upid) ?? S.taskLog?.items.find((t) => t.upid === upid);
  const heading = title ? `${title.what}${title.target ? `: ${title.target}` : ""}` : "Task";
  try {
    const view = await signal(`api/task?full=1&server=${encodeURIComponent(node)}&task=${encodeURIComponent(upid)}`);
    const words = !view.finished ? "Still running." : { ok: "Finished.", warning: "Finished with warnings.", failed: `It failed. ${view.message}` }[view.result];
    dialog(`<h3>${esc(heading)}</h3><p class="${view.result === "failed" ? "loginerr" : ""}">${esc(words)}</p>
      ${view.lines?.length ? `<pre class="tasklog whole">${esc(view.lines.join("\n"))}</pre>` : ""}${closeRow}`);
    const log = $("#dialog .tasklog");
    if (log) log.scrollTop = log.scrollHeight;
  } catch (err) {
    if (err.message !== "signed out") dialog(`<h3>${esc(heading)}</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p>${closeRow}`);
  }
}
function renderHealth() {
  renderTaskFeed();
  const h = $("#health");
  if (!S.data) {
    h.innerHTML = S.failed
      ? `<h1>Can't reach Proxmox</h1><p class="sub">${esc(S.failed)}</p><p class="meta">Trying again every 10 seconds.</p>`
      : `<h1>Connecting to Proxmox</h1>`;
    return;
  }
  const { nodes, vms, storage } = S.data;
  const avail = S.data.update?.available;
  const issues = [...(avail ? [{ kind: "bossmox-update", title: `BossMox ${avail.version} is available`, detail: "" }] : []), ...S.data.issues, ...diskIssues()];
  const up = nodes.filter((n) => n.online).length;
  const guests = vms.filter((v) => !v.template);
  const run = guests.filter((v) => v.running).length;
  const free = storage.reduce((sum, s) => sum + s.freeGb, 0);
  const freeText = free >= 1024 ? `${(free / 1024).toFixed(1)} TB` : `${Math.round(free)} GB`;
  const notes = readNotices();
  const keys = issues.map(noticeKey);
  const kept = notes.dismissed.filter((k) => keys.includes(k));
  // A problem that clears is forgotten, so it shows again if it ever comes back.
  if (kept.length !== notes.dismissed.length) saveNotices({ ...notes, dismissed: kept });
  const shown = issues.filter((i) => !kept.includes(noticeKey(i)));
  const heading = shown.length ? `${count(shown.length)} worth a look` : issues.length ? "Nothing new worth a look" : "Everything looks good";
  const controls = [
    `<button class="linkbtn" data-open="health">Open the health check</button>`,
    shown.length ? `<button class="linkbtn" data-noticetoggle="1" aria-expanded="${!notes.collapsed}">${notes.collapsed ? "Show notices" : "Hide notices"}</button>` : "",
    kept.length ? `<button class="linkbtn" data-noticerestore="1">Bring back ${kept.length} dismissed</button>` : "",
  ].filter(Boolean).join("");
  h.innerHTML = `
    <h1>${heading}</h1>
    <p class="sub">${up} of ${nodes.length} ${nodes.length === 1 ? "node" : "nodes"} online. ${run} of ${guests.length} ${guests.length === 1 ? "VM" : "VMs"} running, and ${freeText} free.</p>
    ${overallBars(S.data.cluster, nodes.length)}
    ${runLine()}
    <div class="rack">${nodes.map((n) => {
      const on = vms.filter((v) => v.node === n.name);
      return `<button class="ru" data-server="${esc(n.name)}"><span>${esc(n.name)}</span>
        <span class="leds">${on.map((v) => `<i class="${!v.running ? "off" : v.issues.length ? "w" : ""}"></i>`).join("")}</span>
        <small>${n.online ? `${n.cpuPct}% busy` : "Offline"}</small></button>`;
    }).join("")}</div>
    ${shown.length && !notes.collapsed ? `<div class="look-items">${shown.map((i) => `<div class="look-row"><button class="look-item" ${i.vmId ? `data-vm="${i.vmId}"` : i.kind === "bossmox-update" ? 'data-bmupdate="1"' : 'data-open="storage"'}><span class="dot warn"></span><span>${esc(i.title)}</span></button><button class="look-x" data-noticex="${esc(noticeKey(i))}" aria-label="Dismiss ${esc(i.title)}" title="Dismiss">&times;</button></div>`).join("")}</div>` : ""}
    ${controls ? `<div class="look-controls">${controls}</div>` : ""}`;
}

/* Health check (ADR 0017): every check, the passes included, each problem with its fix. */
const HC_ORDER = { bad: 0, warn: 1, ok: 2, off: 3 };
const HC_WORDS = { bad: "Needs attention", warn: "Worth a look", ok: "Looks good", off: "Turned off" };
function healthFix(f) {
  if (!f) return "";
  const b = (attrs) => `<button class="btn" ${attrs}>${esc(f.label)}</button>`;
  switch (f.kind) {
    case "channel": return b(`data-channel="${esc(f.channel)}" data-channelserver="${esc(f.node)}"`);
    case "updates": return b(`data-hcupdates="${esc(f.node)}"`);
    case "protect": return b(`data-protect="1"`);
    case "add-storage": return b(`data-hcadd="1"`);
    case "open-storage": return b(`data-hcstore="${esc(f.node ?? "")}"`);
    case "tasks": return b(`data-tasklog="${esc(f.node)}"`);
    case "boot-on": return b(`data-hcboot="${esc(f.vmids.join(","))}"`);
    case "open-vm": return b(`data-vm="${f.vmids[0]}"`);
    case "backups-elsewhere": return b(`data-backupselsewhere="off"`);
    case "bossmox-update": return b(`data-bmupdate="1"`);
    case "update-check": return b(`data-updatecheck="${S.data?.update?.on === false ? "on" : "off"}"`);
    case "check-now": return b(`data-checknow="1"`);
    case "settings": return b(`data-open="settings"`);
    case "move-network": return b(`data-movefix="1"`);
    case "ha-policy": return b(`data-hapolicy="1"`);
    case "leftover": return b(`data-leftover="1"`);
    default: return "";
  }
}
function drawHealthCheck() {
  const box = $("#hcbox");
  if (!box) return;
  const checks = S.healthChecks;
  if (!checks) {
    box.innerHTML = `<p class="empty">${esc(S.healthError || "Checking everything. This takes a few seconds.")}</p>`;
    return;
  }
  const bad = checks.filter((c) => c.status === "bad").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const head = bad ? `${bad === 1 ? "One thing needs" : `${bad} things need`} attention` : warn ? `${warn === 1 ? "One thing is" : `${warn} things are`} worth a look` : "Everything looks good";
  const groups = ["Nodes", "Backups", "Storage", "Guests", "BossMox"].map((g) => [g, checks.filter((c) => c.group === g).sort((a, b) => HC_ORDER[a.status] - HC_ORDER[b.status])]).filter(([, l]) => l.length);
  box.innerHTML = `<div class="sttop"><div><h2 class="hchead">${esc(head)}</h2><p class="meta" style="margin:2px 0 0">${checks.length} checks, ${checks.filter((c) => c.status === "ok").length} passed${checks.some((c) => c.status === "off") ? `, ${checks.filter((c) => c.status === "off").length} turned off` : ""}.</p></div><div class="actions"><button class="btn" data-hcagain="1">Check again</button></div></div>
    ${groups.map(([g, list]) => `<h3 class="sthd">${esc(g)}</h3><div class="stgroup hcgroup">${list.map((c) => `<div class="hcrow ${c.status}"><span class="dot ${c.status === "ok" ? "running" : c.status === "off" ? "" : "warn"}" aria-hidden="true"></span>
      <div class="hctext"><b>${esc(c.title)}</b><span class="sr">${HC_WORDS[c.status]}.</span>${c.detail ? `<small>${esc(c.detail)}</small>` : ""}</div><div class="actions">${c.status === "ok" && c.fix?.kind !== "check-now" ? "" : healthFix(c.fix)}${c.id === "scheduled" && c.status === "warn" ? `<button class="btn" data-backupselsewhere="on">We back up another way</button>` : ""}${c.id === "bossmox-version" && (c.status === "ok" || c.fix?.kind === "bossmox-update") ? `<button class="btn" data-updatecheck="off">Stop checking</button>` : ""}</div></div>`).join("")}</div>`).join("")}`;
}
async function loadHealthCheck() {
  const run = S.loadRun;
  try {
    const { checks } = await signal(`api/health${S.healthAgain ? "?again=1" : ""}`);
    S.healthAgain = false;
    if (run !== S.loadRun) return;
    S.healthChecks = checks;
    S.healthError = "";
  } catch (err) {
    if (err.message === "signed out" || run !== S.loadRun) return;
    S.healthError = err.message || "BossMox lost contact with Proxmox.";
  }
  drawHealthCheck();
}

/*
 * Settings (ADR 0029). Recommended settings are Proxmox's own cluster options, read fresh each time, each a switch
 * with what it does and why. A flip asks first and names the change.
 */
function drawSettings() {
  const box = $("#setbox");
  if (!box) return;
  const list = S.recommended;
  if (!list) {
    box.innerHTML = `<p class="empty">${esc(S.recommendedError || "Reading the cluster's settings.")}</p>`;
    return;
  }
  const leaning = list.filter((s) => s.recommend !== null);
  const matching = leaning.filter((s) => s.on === s.recommend).length;
  const advice = (s) => (s.recommend === null ? "" : s.on === s.recommend ? `<span class="rec ok">As recommended</span>` : `<span class="rec">Recommended ${s.recommend ? "on" : "off"}</span>`);
  const pick = (s) => (s.choices?.length > 1 || (s.choices?.length && !s.on) ? `<select class="setpick" data-setpick="${esc(s.id)}" aria-label="${esc(s.title)}: choice" ${s.can ? "" : "disabled"}>${s.choices.map((c) => `<option value="${esc(c.value)}" ${c.value === (S.setChoice[s.id] ?? s.choice) ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select>` : "");
  const locked = (s) => !s.can || (s.onlyOn && s.on);
  box.innerHTML = `<div class="sttop"><div><h2 class="hchead">Recommended settings</h2><p class="meta" style="margin:2px 0 0">${matching} of ${leaning.length} set the way BossMox recommends. These are Proxmox's own settings, so they apply however you manage the cluster.</p></div><div class="actions"><button class="btn" data-setagain="1">Read again</button></div></div>
    <div class="stgroup">${list.map((s) => `<div class="setrow">
      <div class="hctext"><b>${esc(s.title)}</b>${advice(s)}<small>${esc(s.detail)}</small>${s.why && !s.can ? `<small class="setwhy">${esc(s.why)}</small>` : ""}${pick(s)}</div>
      <button class="sw" role="switch" aria-checked="${s.on}" aria-label="${esc(s.title)}" data-setsw="${esc(s.id)}" ${locked(s) ? "disabled" : ""}><i></i></button></div>`).join("")}</div>`;
}
async function loadSettings() {
  const run = S.loadRun;
  try {
    const { settings } = await signal("api/recommended");
    if (run !== S.loadRun) return;
    S.recommended = settings;
    S.recommendedError = "";
  } catch (err) {
    if (err.message === "signed out" || run !== S.loadRun) return;
    S.recommendedError = err.message || "BossMox lost contact with Proxmox.";
  }
  drawSettings();
}
/** What flipping a switch (or changing its pick while on) will do, in words, before anything changes. */
function askSetting(id, on, choice) {
  const s = S.recommended?.find((x) => x.id === id);
  if (!s) return;
  const after = async () => {
    S.setChoice = {};
    S.healthChecks = null;
    await loadSettings();
    if (wins.health) loadHealthCheck();
  };
  const save = (extra) => () => runAction(id === "boot" ? "boot-on" : "recommended-set", onlineNodes()[0], "Saving", extra, after);
  if (id === "boot") {
    const names = S.data?.vms.filter((v) => s.guests.includes(v.id)).map((v) => v.name) ?? [];
    return confirmAction(`Start ${names.length === 1 ? names[0] : `${names.length} guests`} at boot?`, `${names.join(", ")} will start by themselves whenever ${names.length === 1 ? "its node" : "their nodes"} start. Nothing changes while ${names.length === 1 ? "it's" : "they're"} running now.`, "Start at boot", save({ guests: s.guests.join(",") }));
  }
  const words = {
    "move-network": on
      ? [`Move VMs over ${choice}?`, `Proxmox's Migration setting changes to ${choice} for the whole cluster. Moves started after this, from BossMox or Proxmox, use that network, and BossMox moves up to 3 at a time. Moves already running finish where they are.`, `Use ${choice}`]
      : ["Move VMs over the heartbeat's network again?", "Proxmox's Migration setting is cleared, so moves go back to the network the cluster heartbeat uses, and BossMox moves one VM at a time.", "Clear it"],
    "move-limit": on
      ? [`Limit moves to ${choice} MB/s?`, `Every move in the cluster, from BossMox or Proxmox, runs at ${choice} MB/s or less. Bigger VMs take longer to move.`, `Limit to ${choice} MB/s`]
      : ["Remove the move speed limit?", "Moves run as fast as their network allows.", "Remove the limit"],
    "ha-shutdown": on
      ? ["Have HA move its guests before a node shuts down?", "Proxmox's HA shutdown policy changes to Migrate for the whole cluster. When a node shuts down or restarts, the guests HA manages move to another node first, and come back after.", "Turn it on"]
      : ["Go back to Proxmox's default shutdown policy?", "When a node restarts, the guests HA manages stop and wait for it to come back.", "Go back"],
  }[id];
  confirmAction(words[0], words[1], words[2], save({ id, on, choice }), !on && s.recommend === true);
}

/*
 * Fix this, for moves on the heartbeat's only network (ADR 0030). One screen: which network moves should use, and a
 * speed limit when that network also carries storage. It says exactly what changes before anything does.
 */
async function moveFix() {
  S.moveFix = { loading: true };
  drawMoveFix();
  try {
    const { settings } = await signal("api/recommended");
    S.recommended = settings;
  } catch (err) {
    if (err.message === "signed out") return;
    S.moveFix = { error: err.message || "BossMox lost contact with Proxmox." };
    return drawMoveFix();
  }
  const net = S.recommended.find((x) => x.id === "move-network");
  const limit = S.recommended.find((x) => x.id === "move-limit");
  const pick = net?.choices?.[0];
  S.moveFix = {
    net: net?.on ? null : net?.choice ?? null,
    limitOn: !!(limit?.on || pick?.storage || !net?.choices?.length),
    speed: limit?.on ? limit.choice : pick?.storage ? "250" : limit?.choice ?? "50",
  };
  drawMoveFix();
}
function drawMoveFix() {
  const f = S.moveFix;
  const close = (label = "Cancel") => `<div class="row-end"><button class="btn" data-dlg="cancel">${label}</button></div>`;
  const head = "<h3>Give VM moves their own network</h3>";
  if (f.loading) return dialog(`${head}<p>Reading the cluster's networks.</p>${close()}`);
  if (f.error) return dialog(`${head}<p class="loginerr">${esc(f.error)}</p>${close("Close")}`);
  if (f.done) return dialog(`<h3>Done</h3><p>${esc(f.done)}</p>${close("Close")}`);
  const net = S.recommended.find((x) => x.id === "move-network");
  const limit = S.recommended.find((x) => x.id === "move-limit");
  if (!net || net.on) return dialog(`${head}<p>Moves already have a network of their own, so there's nothing to fix.</p>${close("Close")}`);
  if (!limit?.can && limit?.why) return dialog(`${head}<p>${esc(limit.why)}</p>${close("Close")}`);
  const speeds = (limit?.choices ?? []).map((c) => `<option value="${esc(c.value)}" ${c.value === f.speed ? "selected" : ""}>${esc(c.label)}</option>`).join("");
  const limitRow = (line) => `<label class="mfline"><input type="checkbox" id="mflimit" ${f.limitOn ? "checked" : ""}> <span>Limit moves to</span> <select id="mfspeed" aria-label="Move speed limit">${speeds}</select></label><p class="meta">${esc(line)}</p>`;
  const limitChange = f.limitOn && (!limit?.on || limit.choice !== f.speed);
  if (!net.choices?.length) {
    // No second network yet: say what it takes, and offer the limit in the meantime.
    return dialog(`${head}<p>Moves run on the only network the nodes use to check on each other. BossMox can't give moves another one yet, because the nodes don't share a second network.</p>
      <ol class="mfsteps"><li>Give each node a second network port, connected to its own switch or VLAN. A 10 Gb port is best.</li><li>In Proxmox, give every node an address on that network: the node, then System, then Network, then the port, with the same network for all of them.</li><li>Come back to Health check and use Fix this again. BossMox will offer that network.</li></ol>
      <p class="stq">Until then</p>${limitRow("A limit leaves the heartbeat room while moves share its network. 50 MB/s keeps about half of a 1 Gb port free.")}
      <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-mfgo="1" ${limitChange ? "" : "disabled"}>Set the limit</button></div>`);
  }
  const chosen = net.choices.find((c) => c.value === f.net) ?? net.choices[0];
  const changes = [`Proxmox's Migration network becomes ${chosen.value}`];
  if (limitChange) changes.push(`moves are limited to ${f.speed} MB/s`);
  if (!f.limitOn && limit?.on) changes.push("the move speed limit is removed");
  dialog(`${head}<p>Moves run on the only network the nodes use to check on each other, so heavy moves can make them lose touch. ${net.choices.length === 1 ? "This network reaches" : "These networks reach"} every node and ${net.choices.length === 1 ? "leaves" : "leave"} the heartbeat alone:</p>
    <div class="choices" role="radiogroup" aria-label="Network for moves" style="grid-template-columns:1fr">${net.choices.map((c) => `<button class="choice ${c === chosen ? "on" : ""}" role="radio" aria-checked="${c === chosen}" data-mfnet="${esc(c.value)}"><b>${esc(c.value)}</b><small>${c.storage ? `Also carries ${esc(c.storage.join(", "))}, so a speed limit keeps moves from crowding the disks.` : "Nothing else BossMox knows of uses it."}</small></button>`).join("")}</div>
    ${limitRow(chosen.storage ? "250 MB/s is about 2 Gbps: most of a 10 Gb link stays free for the disks, and a 16 GB VM still moves in about a minute." : "Not needed on a network of its own. It only makes moves slower.")}
    <p><b>What changes:</b> ${esc(changes.join(", and "))}. This is for the whole cluster, from BossMox and Proxmox alike. BossMox then moves up to 3 VMs at a time. Moves already running finish where they are.</p>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-mfgo="1">Make the change</button></div>`);
}
async function applyMoveFix() {
  const f = S.moveFix;
  const net = S.recommended.find((x) => x.id === "move-network");
  const limit = S.recommended.find((x) => x.id === "move-limit");
  const steps = [];
  if (net?.choices?.length && !net.on) steps.push({ id: "move-network", on: true, choice: f.net ?? net.choices[0].value });
  if (f.limitOn && (!limit?.on || limit.choice !== f.speed)) steps.push({ id: "move-limit", on: true, choice: f.speed });
  if (!f.limitOn && limit?.on && net?.choices?.length) steps.push({ id: "move-limit", on: false, choice: "" });
  S.moveFix = { loading: true };
  dialog(`<h3>Saving</h3><p>Changing Proxmox's settings.</p>`);
  try {
    for (const step of steps) {
      const res = await post("api/action/recommended-set", { server: onlineNodes()[0], ...step });
      const body = await res.json();
      if (res.status === 401) return showLogin("You've been signed out. Sign in again to continue.");
      if (!res.ok) throw new Error(body.error);
    }
    // Read back from Proxmox, so the result says what is set, not what was asked.
    const { settings } = await signal("api/recommended");
    S.recommended = settings;
    const n = settings.find((x) => x.id === "move-network");
    const l = settings.find((x) => x.id === "move-limit");
    S.moveFix = { done: `${n?.on ? `Moves now run on ${n.choice}, apart from the heartbeat, up to 3 at a time.` : "Moves still share the heartbeat's network."} ${l?.on ? `They're limited to ${l.choice} MB/s.` : "There's no speed limit."} Settings shows these and can change them.` };
  } catch (err) {
    S.moveFix = { error: `${err.message || "BossMox lost contact with Proxmox."} Anything before that step was saved, and Settings shows what's set now.` };
  }
  drawMoveFix();
  S.healthChecks = null;
  if (wins.health) loadHealthCheck();
  if (wins.settings) drawSettings();
}

/*
 * Leftover disks (ADR 0031): each one named with its guest and size, all ticked, and removed one by one. A removal
 * deletes the disk file for good, so the button is red and says how many.
 */
function drawLeftover() {
  const disks = S.healthChecks?.find((c) => c.id === "leftover")?.fix?.disks ?? [];
  // Removal works from this list, not the health check's latest: a disk found after the window opened is never removed unseen (#59).
  S.leftoverShown = [...disks];
  const keep = S.leftoverKeep ?? new Set();
  const picked = disks.filter((d) => !keep.has(d.volume));
  dialog(`<h3>Remove leftover disks?</h3><p>These disks are detached from their guests and nothing uses them. Removing one deletes its file from storage for good. The guests themselves aren't touched.</p>
    <div class="lolist">${disks.map((d) => `<label class="mfline"><input type="checkbox" data-lokeep="${esc(d.volume)}" ${keep.has(d.volume) ? "" : "checked"}> <span><b>${esc(d.guest)}</b>: ${esc(d.volume)}${d.sizeGb !== null ? ` (${Math.round(d.sizeGb)} GB)` : ""}</span></label>`).join("")}</div>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" data-logo="1" ${picked.length ? "" : "disabled"}>Remove ${picked.length === 1 ? "1 disk" : `${picked.length} disks`}</button></div>`);
}
async function removeLeftover() {
  const disks = (S.leftoverShown ?? []).filter((d) => !(S.leftoverKeep ?? new Set()).has(d.volume));
  const done = [];
  dialog(`<h3>Removing</h3><p>Removing ${disks.length === 1 ? "1 disk" : `${disks.length} disks`}.</p>`);
  let problem = "";
  for (const d of disks) {
    try {
      const res = await post("api/action/leftover-remove", { server: d.node, guest: String(d.vmid), type: d.type, slot: d.slot, confirm: d.volume });
      const body = await res.json();
      if (res.status === 401) return showLogin("You've been signed out. Sign in again to continue.");
      if (!res.ok) throw new Error(body.error);
      done.push(d);
    } catch (err) {
      problem = `${d.volume} wasn't removed: ${err.message || "BossMox lost contact with Proxmox."}`;
      break;
    }
  }
  const freed = Math.round(done.reduce((a, d) => a + (d.sizeGb ?? 0), 0));
  dialog(`<h3>${problem ? "Stopped" : "Done"}</h3><p>${esc(`${done.length === 1 ? "1 disk" : `${done.length} disks`} removed${freed ? `, ${freed} GB freed` : ""}.`)}</p>${problem ? `<p class="loginerr">${esc(problem)}</p>` : ""}<div class="row-end"><button class="btn" data-dlg="cancel">Close</button></div>`);
  S.leftoverKeep = new Set();
  S.healthChecks = null;
  S.healthAgain = true;
  drawHealthCheck();
  loadHealthCheck();
}

/* Notices are one person's view, so this lives in the browser. The problem itself stays on the guest's own page. */
const NOTICES_KEY = "bossmox-notices";
/** Leaves out the changing part of a title, so a disk going from 91% to 92% full doesn't undo a dismissal. */
const noticeKey = (i) => (i.vmId ? `${i.kind}:${i.vmId}` : `${i.kind}:${i.title.split(" is ")[0]}`);
function readNotices() {
  try {
    const n = JSON.parse(localStorage.getItem(NOTICES_KEY) ?? "{}");
    return { collapsed: n.collapsed === true, dismissed: Array.isArray(n.dismissed) ? n.dismissed : [] };
  } catch {
    return { collapsed: false, dismissed: [] };
  }
}
function saveNotices(value) {
  try {
    localStorage.setItem(NOTICES_KEY, JSON.stringify(value));
  } catch { /* the choice just won't be remembered */ }
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
  const title = esc(a.title);
  el.innerHTML = `<div class="tbar"><span>${title}</span>${app === "vms" ? `<button class="btn tbarbtn" data-open="create">Create a VM</button>` : ""}
    <button class="wbtn" data-min="${app}" aria-label="Minimize ${title}"><svg viewBox="0 0 16 16"><path d="M3 12h10"/></svg></button>
    <button class="wbtn" data-close="${app}" aria-label="Close ${title}"><svg viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13"/></svg></button></div>
    <div class="wbody"></div>`;
  $("#windows").append(el);
  wins[app] = el;
  el.addEventListener("pointerdown", () => focusWin(app));
  drag(el, $(".tbar", el));
  render(app);
  focusWin(app);
  if (["vms", "monitor", "network", "storage", "backups", "tasklog"].includes(app)) loadAhead();
}
function focusWin(app) {
  wins[app].style.zIndex = ++S.z;
  renderTasks(app);
}
function renderTasks(active) {
  const top = active || Object.keys(wins).filter((k) => !wins[k].classList.contains("hidden")).sort((a, b) => wins[b].style.zIndex - wins[a].style.zIndex)[0];
  $("#tasks").innerHTML = Object.keys(wins).map((k) => `<button class="task ${k === top ? "on" : ""}" data-open="${k}">${esc(APPS[k].title)}</button>`).join("");
}
function drag(el, handle) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || innerWidth <= 760) return;
    const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
    handle.setPointerCapture(e.pointerId);
    const move = (m) => {
      el.style.left = `${Math.min(innerWidth - 120, Math.max(-200, m.clientX - sx))}px`;
      el.style.top = `${Math.min(innerHeight - 60, Math.max(46, m.clientY - sy))}px`;
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
  if (app === "backups") {
    drawBackups();
    loadBackups();
  }
  if (app === "health") {
    drawHealthCheck();
    loadHealthCheck();
  }
  if (app === "settings") {
    S.recommended = null;
    drawSettings();
    loadSettings();
  }
  if (app === "storage") {
    drawStore();
    loadStorage();
  }
  if (app === "tasklog") {
    $("#tlshow").value = S.tlShow ?? "all";
    drawTaskLog();
    loadTaskLog();
  }
  if (app === "create") startCreate();
  if (app === "network") loadNetwork();
}

/* Virtual Machines */
const selected = () => S.data?.vms.find((v) => v.id === S.sel) ?? null;
const dotClass = (v) => (v.issues.length ? "warn" : v.running ? "running" : "");
const stateWord = (v) => `${v.template ? "Template" : v.paused ? "Paused" : v.running ? "Running" : "Shut down"} on ${v.node}`;

function vmsShell() {
  return `<div class="vms"><aside>
    <div class="tools"><input class="search" id="vmq" type="search" placeholder="Find a VM" aria-label="Find a VM" value="${esc(S.q)}">
    <select class="search" id="vmnode" aria-label="Show VMs on"></select>
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
  // Only nodes that exist now; one that left the cluster drops back to every node.
  const names = S.data.nodes.map((n) => n.name);
  if (S.vmNode && !names.includes(S.vmNode)) S.vmNode = "";
  $("#vmnode").innerHTML = `<option value="">Every node</option>${names.map((n) => `<option value="${esc(n)}" ${n === S.vmNode ? "selected" : ""}>On ${esc(n)}</option>`).join("")}`;
  const q = S.q.toLowerCase();
  const list = S.data.vms.filter((v) => (!S.vmNode || v.node === S.vmNode) && (S.filter === "all" || (S.filter === "running" && v.running) || (S.filter === "look" && v.issues.length)) && (v.name + v.os).toLowerCase().includes(q));
  $("#vmlist").innerHTML = list.length
    ? list.map((v) => `<button class="row ${v.id === S.sel ? "on" : ""}" data-pick="${v.id}">
      <span class="dot ${dotClass(v)}"></span><b>${esc(v.name)}</b><small>${esc(stateWord(v))}</small></button>`).join("")
    : `<p class="empty">No VMs match${S.vmNode ? ` on ${esc(S.vmNode)}` : ""}. Try a different word or filter.</p>`;
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
      <div class="actions">${v.template ? `<button class="btn primary" data-clone="${v.id}">New from template</button>` : v.running
        ? `<button class="btn" data-console="${v.id}">Console</button><button class="btn" data-power="shutdown">Shut down</button><button class="btn" data-power="reboot">Restart</button><button class="btn" data-power="stop">Force off</button>`
        : `<button class="btn primary" data-power="start">Start</button>`}${v.template ? "" : `<button class="btn" data-clone="${v.id}">Clone</button>`}${(S.data?.nodes.length ?? 0) > 1 && !v.template ? `<button class="btn" data-move="${v.id}">Move</button>` : ""}${v.type === "qemu" && !v.template ? `<span ${v.running ? 'title="The machine has to be powered off to access this menu"' : ""}><button class="btn" ${v.running ? "disabled" : `data-bootmenu="${v.id}"`}>Boot menu</button></span>` : ""}${v.template ? "" : `<button class="btn" data-maketemplate="${v.id}">Make template</button>`}<button class="btn" data-guestdelete="${v.id}">Delete</button></div></div>
    <div id="vmwaiting">${waitingWords(v)}</div>
    <div class="tabs" role="tablist">${[["overview", "Overview"], ["hardware", "Hardware"], ...(v.template ? [] : [["snapshots", "Snapshots"]]), ["settings", "Settings"]].map(([k, l]) => `<button role="tab" aria-selected="${S.tab === k}" class="${S.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
    <div class="tabpane">${TAB[S.tab](v)}</div>`;
  if (S.tab === "snapshots") checkSnapshots(v);
  if (S.tab === "overview" && v.running) loadAddress(v);
  if (S.tab === "overview") loadUsage();
  if (S.tab === "settings") {
    if (!S.cpuTypes) loadCpuTypes(v.node);
    loadWaiting(v);
  }
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
      ${v.running ? `<dt>Address</dt><dd id="vmaddr">${esc(addressWords(v))}</dd>` : ""}
      ${v.running && v.type === "qemu" ? `<dd class="agenthelp" id="vmagent">${agentHelp(v)}</dd>` : ""}
      <dt>Starts at boot</dt><dd>${v.startsAtBoot ? "Yes" : "No"}</dd>
      <dt>Snapshots</dt><dd>${v.snapshots.length || "None"}</dd>
    </dl>
    ${v.template ? "" : usagePane(`guest:${v.node}:${v.type}:${v.id}`)}`,
  hardware: (v) => {
    const lock = v.template ? "" : "1";
    const disk = (d) => `<div class="snap"><div>${d.boot ? "Boot disk" : d.mount ? esc(d.mount) : "Disk"}<small>${d.sizeGb} GB on ${esc(d.storage)}, ${esc(d.slot)}</small></div>${lock ? `<div class="actions"><button class="btn" data-diskgrow="${esc(d.slot)}">Grow</button>${d.boot ? "" : `<button class="btn" data-diskremove="${esc(d.slot)}">Remove</button>`}</div>` : ""}</div>`;
    const nic = (n) => `<div class="snap"><div>${esc(n.bridge || "Not connected")}${n.vlan ? `, VLAN ${esc(n.vlan)}` : ""}<small>${v.type === "lxc" ? `${esc(addrWords(n))}, ` : ""}${esc(n.model)}, ${esc(n.mac)}</small></div><div class="actions">${lock && v.type === "lxc" ? `<button class="btn" data-addrchange="${esc(n.slot)}">Change address</button>` : ""}${lock && v.nics.length > 1 ? `<button class="btn" data-nicremove="${esc(n.slot)}">Remove</button>` : ""}</div></div>`;
    return `${v.configLoaded ? "" : `<p class="meta">Proxmox didn't return this guest's settings.</p>`}
      <div class="hwhead"><h3>Disks</h3>${lock ? `<button class="btn" data-diskadd="1">Add a disk</button>` : ""}</div>${v.disks.map(disk).join("") || `<p class="empty">No disks.</p>`}
      ${v.type === "qemu" ? discSection(v) : ""}
      <div class="hwhead"><h3>Network</h3>${lock ? `<button class="btn" data-nicadd="1">Add a network card</button>` : ""}</div>${v.nics.map(nic).join("") || `<p class="empty">Not connected to a network.</p>`}
      ${v.running && lock ? `<p class="meta">It's running. Added disks usually appear right away, but some changes wait until it's shut down and started.</p>` : ""}`;
  },
  snapshots: (v) => `<div class="head"><p class="meta" style="margin-top:0">A snapshot saves ${esc(v.name)} as it is now, so you can go back to it later. It isn't a backup: it lives on the same disk.</p>
      ${S.snapSupport?.[v.id] === false ? "" : `<div class="actions"><button class="btn primary" data-snaptake="1">Take a snapshot</button></div>`}</div>
    ${S.snapSupport?.[v.id] === false ? snapshotAdvice(v) : ""}
    ${v.snapshots.length
      ? v.snapshots.map((s) => `<div class="snap"><div>${esc(s.name)}<small>${esc(s.description ? `${s.description}, ${when(s.takenAt)}` : when(s.takenAt))}</small></div><div class="actions"><button class="btn" data-snaprestore="${esc(s.name)}">Go back to this</button><button class="btn" data-snapdelete="${esc(s.name)}">Delete</button></div></div>`).join("")
      : S.snapSupport?.[v.id] === false ? "" : `<p class="empty">This VM has no snapshots yet.</p>`}`,
  settings: (v) => settingsPane(v),
};

/* Servers and Storage */
function monView() {
  return `<div class="vms"><aside><div id="srvlist"></div></aside><div id="srvdetail"></div></div>`;
}
const signal = (url) => fetch(url).then(async (res) => {
  const body = await res.json();
  if (res.status === 401) {
    showLogin("You've been signed out. Sign in again to continue.");
    throw new Error("signed out");
  }
  if (!res.ok) throw new Error(body.error);
  return body;
});
async function loadServer(name = S.server) {
  if (!name) return;
  const run = S.loadRun;
  try {
    const [body] = await Promise.all([signal(`api/server?name=${encodeURIComponent(name)}`), loadMoves()]);
    if (run !== S.loadRun) return;
    S.details[name] = body;
    if (name !== S.server) return;
    const changed = JSON.stringify(body) !== JSON.stringify(S.detail);
    S.detail = body;
    S.detailError = "";
    if (changed) renderServerDetail();
  } catch (err) {
    if (run !== S.loadRun || name !== S.server) return;
    S.detailError = err.message || "BossMox couldn't get this node's details.";
    if (!S.detail) renderServerDetail();
  }
}
/**
 * Keeps every node and guest loaded ahead of time, so switching between them shows the page at once.
 * One request at a time, so a big cluster doesn't get hit with all of them together, and only while
 * the window that shows them is open. The first run, at sign-in, covers windows that aren't open yet.
 */
async function loadCpuTypes(node) {
  if (S.cpuTypes || !node) return;
  try {
    S.cpuTypes = (await signal(`api/cpu-types?server=${encodeURIComponent(node)}`)).types;
  } catch { /* the common types are still offered */ }
}
async function loadAhead() {
  if (S.loadingAhead || !S.data) return;
  S.loadingAhead = true;
  const run = S.loadRun;
  const first = !S.loadedAhead;
  S.loadedAhead = true;
  S.aheadRuns = (S.aheadRuns ?? 0) + 1;
  try {
    if (first || wins.monitor) {
      for (const n of S.data.nodes.filter((x) => x.online)) {
        if (run !== S.loadRun) return;
        await loadServer(n.name);
      }
    }
    if (first || wins.network) {
      for (const n of (S.data?.nodes ?? []).filter((x) => x.online)) {
        if (run !== S.loadRun) return;
        const net = await signal(`api/network?server=${encodeURIComponent(n.name)}`).catch(() => null);
        if (!net || run !== S.loadRun) continue;
        const changed = JSON.stringify(net) !== JSON.stringify(S.nets[n.name]);
        S.nets[n.name] = net;
        if (changed && n.name === S.netServer && $("#netdetail")) drawNetwork(net);
      }
    }
    if (first) await loadCpuTypes(onlineNodes()[0]);
    if (first || wins.tasklog) await loadTaskLog();
    if (first || wins.storage) await loadStorage();
    if (first || S.aheadRuns % 10 === 0) {
      for (const node of onlineNodes()) {
        if (run !== S.loadRun) return;
        if (!wins.storage || node !== S.storeNode) await loadStorageMap(node);
      }
    }
    // Disks answer slowly and rarely change, but a failing one should still reach the desktop.
    if (first || wins.storage || S.aheadRuns % 10 === 0) {
      for (const node of onlineNodes()) {
        if (run !== S.loadRun) return;
        await loadDisks(node);
      }
    }
    // Backups mean asking every storage on every node, so this one runs a third as often.
    if (first || (wins.backups && S.aheadRuns % 3 === 0)) await loadBackups();
    if (first || wins.vms) {
      for (const v of S.data?.vms ?? []) {
        if (run !== S.loadRun) return;
        if (v.running) await loadAddress(v);
        if (!v.template) await loadWaiting(v);
        if (!v.template) await checkSnapshots(v);
      }
    }
  } finally {
    S.loadingAhead = false;
  }
}
function pickServer(name) {
  if (name !== S.server) {
    S.server = name;
    S.detail = S.details[name] ?? null;
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
const CHANNEL_WORDS = { free: "Use the free channel", enterprise: "Use the enterprise channel" };
const channelButton = (d) => (d.channel?.offer ? `<button class="btn" data-channel="${d.channel.offer}" data-channelserver="${esc(d.name)}">${CHANNEL_WORDS[d.channel.offer]}</button>` : "");
const noAccess = (what, perm) => `<p class="empty">Your Proxmox account can't see ${what}. It needs ${perm} on this node.</p>`;
const SERVER_TAB = {
  overview: (d, node) => {
    const on = S.data?.vms.filter((v) => v.node === d.name) ?? [];
    const a = d.summary;
    return `
    ${(() => {
      const m = movedGuests(d.name);
      return m ? `<div class="advice"><div><b>${m.guests.length} moved off for a restart</b>${esc(awayWords(m))}</div><button class="btn" data-moveback="${esc(d.name)}">Move everything back</button></div>` : "";
    })()}
    ${d.channel && !d.channel.ok ? `<div class="advice"><div><b>${esc(d.channel.headline)}</b>${esc(d.channel.note)}</div>${channelButton(d)}</div>` : ""}
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
    </dl>
    ${usagePane(`node:${d.name}`)}` : noAccess("this node's status", "Sys.Audit")}
    <article class="server" style="margin-top:20px"><header><span>Running here</span><small>${on.filter((v) => v.running).length} of ${on.length}</small></header>
      <div class="bays">${on.map((v) => `<button class="bay ${v.running ? "" : "stopped"} ${v.issues.length ? "warn" : ""}" data-vm="${v.id}"><i></i>${esc(v.name)}</button>`).join("")}<span class="spare"></span></div></article>`;
  },
  updates: (d) => {
    if (!d.updates) return noAccess("waiting updates", "Sys.Modify");
    const group = (title, items, open) => items.length ? `<details class="upgroup" ${open ? "open" : ""}><summary>${title} (${items.length})</summary>
      ${items.map((u) => `<div class="snap"><div>${esc(u.name)}<small>${esc(u.title)}</small></div><code class="ver">${esc(u.from)} to ${esc(u.to)}</code></div>`).join("")}</details>` : "";
    return `
    <div class="head"><div>${d.channel ? `<p class="meta" style="margin-top:0">Update channel: ${esc(d.channel.name)}. ${esc(d.channel.note)}</p>` : ""}</div>
      <div class="actions">${channelButton(d)}<button class="btn" data-check="${esc(d.name)}">Check for updates</button>${d.updates.total ? `<button class="btn primary" data-install="${esc(d.name)}">Install updates</button>` : ""}</div></div>
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
    return `<p class="seeall" style="margin:0 0 8px"><button class="linkbtn" data-tasklog="${esc(S.server)}">See all tasks on this node</button></p>${d.tasks.map((t) => `<button class="snap tasksnap" data-taskview="${esc(t.upid)}" data-tasknode="${esc(S.server)}"><div>${esc(t.what)}${t.target ? ` on ${esc(t.target)}` : ""}<small>${esc(when(t.startedAt))}, by ${esc(t.who)}</small></div><span class="state"><span class="dot ${dots[t.result]}"></span>${words[t.result]}</span></button>`).join("")}`;
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
  if (S.serverTab === "overview") loadUsage();
}
/*
 * Usage graphs (ADR 0022): Proxmox's own history for a node or guest, one small chart per measure, one scale each.
 * The screens around them redraw every 10 seconds, so the data is cached here and fetched at most once a minute.
 */
const USAGE_RANGES = [["hour", "Last hour"], ["day", "Last day"], ["week", "Last week"]];
S.usage = {};
S.usageRange = "hour";
const usageKey = (key) => `${key}|${S.usageRange}`;
function usagePane(key) {
  return `<section class="usage" data-usage="${esc(key)}">
    <div class="uhead"><h3>Usage</h3><div class="seg" role="group" aria-label="Time range">${USAGE_RANGES.map(([k, l]) => `<button class="${S.usageRange === k ? "on" : ""}" data-urange="${k}" aria-pressed="${S.usageRange === k}">${l}</button>`).join("")}</div></div>
    <div class="ubody">${usageCharts(S.usage[usageKey(key)])}</div></section>`;
}
async function loadUsage() {
  const el = document.querySelector("[data-usage]");
  if (!el) return;
  const key = el.dataset.usage;
  const k = usageKey(key);
  const hit = S.usage[k];
  if (hit && (hit.loading || Date.now() - hit.at < 60000)) return;
  S.usage[k] = { ...hit, loading: true, at: hit?.at ?? 0 };
  const [kind, node, type, id] = key.split(":");
  const q = new URLSearchParams({ server: node, range: S.usageRange, ...(kind === "guest" ? { type, vmid: id } : {}) });
  try {
    const res = await fetch(`api/usage?${q}`);
    const body = await res.json();
    if (res.status === 401) return showLogin("You've been signed out. Sign in again to continue.");
    S.usage[k] = res.ok ? { at: Date.now(), data: body } : { at: Date.now(), error: body.error || "Proxmox didn't return this history." };
  } catch {
    S.usage[k] = { at: Date.now(), error: "BossMox lost contact with Proxmox." };
  }
  const now = document.querySelector(`[data-usage="${CSS.escape(key)}"] .ubody`);
  if (now && usageKey(key) === k) now.innerHTML = usageCharts(S.usage[k]);
}
const fmt = (v, unit) => (v === null || v === undefined ? "no data" : `${v >= 100 || unit === "%" ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}${unit === "%" ? "%" : ` ${unit}`}`);
/** A round top for the scale, so gridlines land on numbers people read easily. */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}
const whenLabel = (t, range) => new Date(t * 1000).toLocaleString([], range === "week" ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { hour: "numeric", minute: "2-digit" });
function usageCharts(hit) {
  if (!hit?.data) return hit?.error ? `<p class="empty">${esc(hit.error)}</p>` : `<p class="empty">Loading usage.</p>`;
  const u = hit.data;
  if (!u.points.length) return `<p class="empty">Proxmox has no history for this yet.</p>`;
  const charts = [
    { title: "Processor", unit: "%", max: 100, series: [["cpu", "Busy"]], note: u.cores ? `of ${u.cores} ${u.cores === 1 ? "core" : "cores"}` : "" },
    { title: "Memory", unit: "GB", max: u.memTotalGb || null, series: [["memGb", "In use"]], note: u.memTotalGb ? `of ${u.memTotalGb} GB` : "" },
    { title: "Network", unit: "Mbit/s", max: null, series: [["netIn", "In"], ["netOut", "Out"]] },
    ...(u.kind === "guest" ? [{ title: "Disk activity", unit: "MB/s", max: null, series: [["diskRead", "Read"], ["diskWrite", "Write"]] }] : []),
  ];
  return `<div class="ugrid">${charts.map((c) => usageChart(u, c)).join("")}</div>`;
}
function usageChart(u, c) {
  const W = 600, H = 120, pts = u.points;
  const values = c.series.flatMap(([k]) => pts.map((p) => p[k]).filter((v) => v !== null && v !== undefined));
  const top = c.max ?? niceMax(Math.max(0, ...values));
  const x = (i) => (pts.length === 1 ? W : (i / (pts.length - 1)) * W);
  const y = (v) => H - (Math.min(v, top) / top) * H;
  const path = (k) => pts.reduce((d, p, i) => (p[k] === null || p[k] === undefined ? d : `${d}${i && pts[i - 1][k] !== null && pts[i - 1][k] !== undefined ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`), "");
  const latest = (k) => [...pts].reverse().find((p) => p[k] !== null && p[k] !== undefined)?.[k] ?? null;
  const peak = (k) => Math.max(...pts.map((p) => p[k] ?? 0));
  const summary = `${c.title}, ${USAGE_RANGES.find(([r]) => r === u.range)[1].toLowerCase()}: ${c.series.map(([k, l]) => `${c.series.length > 1 ? `${l} ` : ""}now ${fmt(latest(k), c.unit)}, peak ${fmt(peak(k), c.unit)}`).join("; ")}.`;
  const data = esc(JSON.stringify({ unit: c.unit, range: u.range, series: c.series, t: pts.map((p) => p.t), v: c.series.map(([k]) => pts.map((p) => p[k] ?? null)) }));
  return `<figure class="uchart">
    <figcaption><b>${c.title}</b>${c.series.length === 1 ? `<span>${fmt(latest(c.series[0][0]), c.unit)} ${c.note ?? ""}</span>` : `<span class="ukey">${c.series.map(([k, l], i) => `<span><i class="s${i + 1}"></i>${l} ${fmt(latest(k), c.unit)}</span>`).join("")}</span>`}</figcaption>
    <div class="uplot" data-uplot="${data}">
      <span class="uscale">${fmt(top, c.unit)}</span>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(summary)}">
        <line class="ugridline" x1="0" x2="${W}" y1="0.5" y2="0.5"/><line class="ugridline" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/><line class="ubase" x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}"/>
        ${c.series.map(([k], i) => `<path class="uline s${i + 1}" d="${path(k)}"/>`).join("")}
        <line class="ucross" x1="0" x2="0" y1="0" y2="${H}" hidden/>
      </svg>
      <div class="utip" hidden></div>
    </div>
    <div class="uaxis"><span>${esc(whenLabel(pts[0].t, u.range))}</span><span>Now</span></div>
  </figure>`;
}
/* Hovering a chart shows the time and every series' value there. */
document.addEventListener("pointermove", (e) => {
  const plot = e.target.closest?.(".uplot");
  document.querySelectorAll(".uplot").forEach((p) => {
    if (p === plot) return;
    p.querySelector(".ucross")?.setAttribute("hidden", "");
    p.querySelector(".utip")?.setAttribute("hidden", "");
  });
  if (!plot) return;
  const d = JSON.parse(plot.dataset.uplot);
  const box = plot.querySelector("svg").getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  const i = Math.round(f * (d.t.length - 1));
  const cross = plot.querySelector(".ucross");
  const cx = d.t.length === 1 ? 600 : (i / (d.t.length - 1)) * 600;
  cross.setAttribute("x1", cx);
  cross.setAttribute("x2", cx);
  cross.removeAttribute("hidden");
  const tip = plot.querySelector(".utip");
  tip.innerHTML = `<b>${esc(whenLabel(d.t[i], d.range))}</b>${d.series.map(([, l], s) => `<span>${d.series.length > 1 ? `<i class="s${s + 1}"></i>${esc(l)} ` : ""}${fmt(d.v[s][i], d.unit)}</span>`).join("")}`;
  tip.hidden = false;
  const left = (cx / 600) * box.width;
  tip.style.left = `${Math.min(Math.max(left, 60), box.width - 60)}px`;
});
function storeView() {
  return `<div id="stbox" class="stbox"></div>`;
}
const USE_WORDS = { images: "VM disks", rootdir: "Container disks", backup: "Backups", iso: "Installer discs", vztmpl: "Container templates" };
const onlineNodes = () => (S.data?.nodes ?? []).filter((n) => n.online).map((n) => n.name);
/* Storage as disks and pools (ADR 0014): one view, shaped like a disk manager, with every action on it. */
const guestName = (vmid) => S.data?.vms.find((v) => v.id === vmid)?.name ?? `Guest ${vmid}`;
const sizeWords = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10} TB` : n > 0 && n < 0.1 ? "under 0.1 GB" : `${n >= 10 ? Math.round(n) : n} GB`);
function diskLine(d) {
  const facts = [d.kind, sizeWords(d.sizeGb)];
  const known = S.diskData?.[S.storeNode]?.find((x) => x.path === d.path);
  const wipe = known?.canWipe;
  // The server's reason, when it gives one, for not offering a drive.
  const blocked = d.blocked || known?.blocked || "";
  return `<div class="stdisk"><div><b>${esc(d.model || d.path)}</b>${d.system ? `<span class="sttag">System disk</span>` : ""}
      <small>${esc(facts.join(", "))}${d.model ? `, ${esc(d.path)}` : ""}${d.wearLeft === null ? "" : `, ${d.wearLeft}% life left`}</small>
      ${d.givenTo ? `<small>Given to ${esc(d.givenTo)} directly. That VM reads and writes this drive itself, so BossMox won't touch it.</small>` : blocked ? `<small>${esc(blocked)}</small>` : d.otherUses.length ? `<small>Also has ${esc(d.otherUses.join(", "))}, which isn't Proxmox storage.</small>` : ""}</div>
    <div class="actions"><button class="linkbtn healthbtn ${d.failing ? "bad" : ""}" data-diskhealth="${esc(d.path)}"><span class="dot ${d.failing ? "warn" : d.health === "UNKNOWN" ? "" : "running"}"></span>${d.failing ? "Failing" : d.health === "UNKNOWN" ? "Health unknown" : "Healthy"}</button>${wipe ? `<button class="btn" data-diskwipe="${esc(d.path)}">Wipe</button>` : ""}</div></div>`;
}
function poolBlock(p, onSystem = false) {
  const pct = p.totalGb ? Math.min(100, Math.round((p.usedGb / p.totalGb) * 100)) : 0;
  const who = (g) => (S.data?.vms.some((v) => v.id === g.vmid) ? guestName(g.vmid) : `Left over from guest ${g.vmid}`);
  const guest = (g) => (g.usedGb !== null && g.usedGb < g.gb ? (g.usedGb < 0.1 ? `${who(g)} (${sizeWords(g.gb)} disk, nearly empty)` : `${who(g)} ${sizeWords(g.usedGb)} of a ${sizeWords(g.gb)} disk`) : p.thin ? `${who(g)} (${sizeWords(g.gb)} disk)` : `${who(g)} ${sizeWords(g.gb)}`);
  const using = [...p.guests.map(guest), ...p.files.filter((f) => f.gb >= 0.1).map((f) => `${f.label} ${sizeWords(f.gb)}`), ...(p.otherGb ? [`${p.otherLabel} ${sizeWords(p.otherGb)}`] : [])];
  const facts = [
    p.layout,
    p.thin ? "Disks here take space only as they fill." : "",
    p.overGivenGb ? `The disks given out here add up to ${sizeWords(p.overGivenGb)}, more than the pool holds. If they all fill up, guests on it stop.` : "",
    p.snapshots,
    p.otherNodes,
  ].filter(Boolean);
  const holds = p.uses.map((u) => USE_WORDS[u]).filter(Boolean);
  const listed = S.storeList?.some((s) => s.id === p.id);
  const open = S.openPools?.has(`${S.storeNode}/${p.id}`);
  return `<div class="stpool ${p.overGivenGb ? "warnpool" : ""}">
    <div class="sthead"><div><b>${esc(p.id)}</b> <span class="inl">${esc(p.title)}</span></div>
      ${listed ? `<div class="actions"><button class="btn" data-stedit="${esc(p.id)}">Change use</button>${p.shared || !p.disks.length ? `<button class="btn" data-stremove="${esc(p.id)}">Remove</button>` : onSystem ? "" : `<button class="btn" data-pooldel="${esc(p.id)}">Delete</button>`}</div>` : ""}</div>
    ${p.active ? `<small>${sizeWords(p.usedGb)} used of ${sizeWords(p.totalGb)}, ${sizeWords(p.freeGb)} free</small><div class="meter"><i style="width:${pct}%"></i></div>` : `<p class="loginerr">This node can't reach it right now.</p>`}
    ${using.length ? `<small>Using it: ${esc(using.join(", "))}</small>` : ""}
    <small>Holds ${esc(holds.join(", ").toLowerCase().replace(/\bvm\b/g, "VM") || "nothing yet")}.</small>
    ${facts.map((f) => `<small>${esc(f)}</small>`).join("")}
    ${p.details ? `<small class="stdetails">${esc(p.details)}</small>` : ""}
    ${p.active ? `<div><button class="linkbtn" data-poolopen="${esc(p.id)}" aria-expanded="${open ? "true" : "false"}">${open ? "Hide what's on it" : "What's on it"}</button></div>${open ? poolItemsList(p) : ""}` : ""}</div>`;
}
const ITEM_WORDS = { disk: "Disks", disc: "Installer discs", template: "Container templates", backup: "Backups", import: "Imports", snippet: "Snippets", other: "Other" };
function poolItemsList(p) {
  const holdsDiscs = p.uses.includes("iso");
  const groups = Object.keys(ITEM_WORDS).map((k) => [k, p.items.filter((i) => i.kind === k)]).filter(([, list]) => list.length);
  const row = (i) => {
    const what = i.kind === "disk" ? (i.leftover ? "Left over from a guest that no longer exists" : `${i.owner || guestName(i.vmid)}'s disk`) : "";
    const size = i.usedGb !== null && i.usedGb < i.gb ? `${sizeWords(i.usedGb)} of ${sizeWords(i.gb)}` : sizeWords(i.gb);
    const button = i.kind === "backup" ? `<button class="btn" data-open="backups">Open Backups</button>` : i.canDelete ? `<button class="btn ${i.leftover ? "danger" : ""}" data-itemdelete="${esc(i.volid)}" data-itempool="${esc(p.id)}">Delete</button>` : "";
    return `<div class="snap"><div>${esc(i.name)}<small>${esc([what, size].filter(Boolean).join(", "))}${!i.canDelete && i.kind !== "backup" && i.kind !== "disk" ? `. ${esc(i.whyNot)}` : ""}</small></div><div class="actions">${button}</div></div>`;
  };
  return `<div class="stitems">
    ${groups.map(([k, list]) => `<p class="stitemhd">${ITEM_WORDS[k]} (${list.length})</p>${list.map(row).join("")}`).join("") || `<p class="meta">Nothing Proxmox keeps track of is on it.</p>`}
    ${p.otherGb ? `<p class="meta">${esc(p.otherLabel)} take ${sizeWords(p.otherGb)}. Proxmox only lists what it keeps track of, so those can't be shown here.</p>` : ""}
    ${holdsDiscs ? `<div class="row-end"><button class="btn" data-itemupload="${esc(p.id)}">Upload an installer disc</button></div>` : ""}</div>`;
}
/* Guided Add storage (ADR 0015): plain questions, BossMox picks the type, the server says what will happen. */
const PURPOSES = [
  ["vms", "VMs and containers", "Their disks, with snapshots."],
  ["files", "Backups and installer discs", "Backups, ISOs and container templates."],
  ["both", "Both", "One drive for everything. Fine to start with; backups are safer on a different drive from the guests."],
];
const POOL_NAMES = { vms: "vmpool", files: "backups", both: "storage" };
function askSetup() {
  S.setup = { where: "", devices: new Set(), purpose: "vms", name: POOL_NAMES.vms, named: false };
  drawSetup();
}
function drawSetup(problem = "") {
  const st = S.setup;
  const node = S.storeNode;
  const drives = (S.diskData?.[node] ?? []).filter((d) => d.free || d.canWipe);
  const blocked = (S.diskData?.[node] ?? []).find((d) => d.blocked)?.blocked ?? "";
  const choice = (key, value, title, line, on, disabled = false) => `<button class="choice ${on ? "on" : ""}" role="radio" aria-checked="${on}" data-setup="${key}" data-setupval="${value}" ${disabled ? "disabled" : ""}><b>${esc(title)}</b><small>${esc(line)}</small></button>`;
  const where = `<p class="stq">Where is it?</p><div class="choices" role="radiogroup" aria-label="Where is it">
    ${choice("where", "drive", "A drive in this computer", drives.length ? `${drives.length} on ${node} can be used.` : blocked || `${node} has no drive that can be used. Every drive already holds something.`, st.where === "drive", !drives.length)}
    ${choice("where", "nas", "A NAS or file server", "Storage over the network. Every node can use it.", st.where === "nas")}</div>`;
  // iSCSI is on the way (Rocky, 2026-11-09): shown so people know, greyed out until it's built and tested.
  const nasPart = st.where !== "nas" ? "" : `<p class="stq">How does it share?</p><div class="choices" role="radiogroup" aria-label="How it shares" style="grid-template-columns:1fr">
    ${choice("share", "nfs", "NFS", "Shared folders, the usual choice for Linux and most NAS boxes.", false)}
    ${choice("share", "smb", "SMB", "Windows file sharing. Needs a username and password.", false)}
    <button class="choice" role="radio" aria-checked="false" aria-disabled="true" disabled><b>iSCSI</b><small>A disk on the NAS, used as if it were inside the node.</small><span class="soon">Coming soon</span></button></div>`;
  const drivePart = st.where !== "drive" ? "" : `
    <p class="stq">Which ${drives.length > 1 ? "drives" : "drive"}?</p><fieldset class="uses"><legend class="sr">Drives</legend>${drives.map((d) => `<label class="createcheck"><input type="checkbox" data-setupdisk="${esc(d.path)}" ${st.devices.has(d.path) ? "checked" : ""}> ${esc(d.model || d.path)}, ${sizeWords(d.sizeGb)}${d.model ? ` <small class="inl">${esc(d.path)}</small>` : ""} <small class="inl">${d.free ? "empty" : `has old data (${esc(d.used)})`}</small></label>`).join("")}</fieldset>
    <p class="stq">What's it for?</p><div class="choices" role="radiogroup" aria-label="What it's for" style="grid-template-columns:1fr">${PURPOSES.map(([k, t, l]) => choice("purpose", k, t, l, st.purpose === k)).join("")}</div>
    <label class="field restartname"><span>Name</span><input id="setupname" maxlength="31" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(st.name)}"></label>
    ${(S.diskData?.[node] ?? []).some((d) => d.free) ? `<p class="meta"><button class="linkbtn" data-diskmake="1">Choose the type myself</button></p>` : ""}`;
  dialog(`<h3>Add storage to ${esc(node)}</h3>${problem ? `<p class="loginerr">${esc(problem)}</p>` : ""}${where}${nasPart}${drivePart}
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button>${st.where === "drive" ? `<button class="btn primary" data-setupnext="1">Continue</button>` : ""}</div>`);
}
async function setupSummary() {
  const st = S.setup;
  st.name = $("#setupname")?.value.trim() ?? st.name;
  if (!st.devices.size) return drawSetup("Pick a drive.");
  const node = S.storeNode;
  const q = new URLSearchParams({ server: node, devices: [...st.devices].join(","), purpose: st.purpose, name: st.name });
  const res = await fetch(`api/setup-plan?${q}`);
  const plan = await res.json().catch(() => ({}));
  if (!res.ok) return drawSetup(plan.error || "BossMox couldn't work that out.");
  dialog(`<h3>Make ${esc(st.name)}?</h3><p>${esc(plan.summary)}</p>
    <label class="field restartname"><span>Type erase to go ahead</span><input id="setupconfirm" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-setupback="1">Back</button><button class="btn danger" id="setupgo" data-setupgo="1" disabled>Erase and make ${esc(st.name)}</button></div>`);
}
function setupGo() {
  const st = S.setup;
  const node = S.storeNode;
  runAction("storage-setup", node, `Making ${st.name} on ${node}. This can take a minute.`, { devices: [...st.devices], purpose: st.purpose, name: st.name, confirm: "erase" }, async () => {
    await loadDisks(node);
    await afterStorage();
  });
}
/* Deleting a pool on a local drive: explained when it can't be done, typed name when it can. */
function askPoolDelete(id) {
  const m = S.storeMaps?.[S.storeNode];
  const g = m?.groups.find((x) => x.pools.some((p) => p.id === id));
  const p = g?.pools.find((x) => x.id === id);
  if (!p) return;
  const node = S.storeNode;
  const users = (S.data?.vms ?? []).filter((v) => v.usesStorage.includes(id)).map((v) => v.name);
  const why = g.disks.some((d) => d.system)
    ? `${id} is on the system disk, alongside Proxmox itself, so BossMox won't delete it. A fresh install splits the system disk into a folder (local) and a pool for guests (local-lvm). That's normal, and both are useful.`
    : users.length ? `${users.join(", ")} still ${users.length === 1 ? "uses" : "use"} it. Move or remove ${users.length === 1 ? "that" : "those"} first.`
      : p.items.length ? `There's still something on it. Open What's on it, and delete or move ${p.items.length === 1 ? "it" : "them"} first.` : "";
  if (why) return dialog(`<h3>${esc(id)} can't be deleted${g.disks.some((d) => d.system) ? "" : " yet"}</h3><p>${esc(why)}</p>${closeRow}`);
  const drives = g.disks.map((d) => (d.model ? `${d.model} (${d.path})` : d.path)).join(" and ");
  S.poolDelete = id;
  dialog(`<h3>Delete ${esc(id)}?</h3><p>This erases ${esc(id)} from ${esc(drives)}. The ${g.disks.length === 1 ? "drive becomes" : "drives become"} empty, ready to use for something else. It can't be undone.</p>
    <label class="field restartname"><span>Type ${esc(id)} to go ahead</span><input id="pooldelconfirm" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="pooldelgo" data-pooldelgo="1" disabled>Delete ${esc(id)}</button></div>`);
  S.poolDeleteNode = node;
}
function askItemDelete(pool, volid) {
  const i = S.storeMaps?.[S.storeNode] && [...S.storeMaps[S.storeNode].groups.flatMap((g) => g.pools), ...S.storeMaps[S.storeNode].unplaced, ...S.storeMaps[S.storeNode].network].find((p) => p.id === pool)?.items.find((x) => x.volid === volid);
  if (!i) return;
  const node = S.storeNode;
  const line = i.leftover
    ? `This disk is left over from guest ${i.vmid}, which no longer exists, and nothing uses it. Deleting it frees ${sizeWords(i.usedGb ?? i.gb)} on ${pool}. It can't be undone.`
    : `This deletes ${i.name} from ${pool}, freeing ${sizeWords(i.gb)}. It can't be undone.`;
  confirmAction(`Delete ${i.name}?`, line, `Delete ${i.name}`, () => runAction("content-delete", node, `Deleting ${i.name}`, { storage: pool, volid, confirm: volid }, () => loadStorageMap(node)), true);
}
function mapPane() {
  const nodes = onlineNodes();
  S.storeNode = nodes.includes(S.storeNode) ? S.storeNode : nodes[0];
  const m = S.storeMaps?.[S.storeNode];
  const pick = nodes.length > 1 ? `<label class="field stnode"><span>Node</span><select id="stnode">${nodes.map((n) => `<option ${n === S.storeNode ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>` : `<div></div>`;
  const top = `<div class="sttop">${pick}<div class="actions"><button class="btn primary" data-setupstart="1">Add storage</button></div></div>`;
  if (!m) return `${top}<p class="empty">${esc(S.mapError || "Looking at this node's disks and storage.")}</p>`;
  const section = (heading, body) => `<h3 class="sthd">${heading}</h3>${body}`;
  return `${top}
    ${m.groups.map((g) => `<section class="stgroup">${g.disks.length > 1 ? `<p class="stmany">${g.disks.length} disks working together</p>` : ""}${g.disks.map(diskLine).join("")}${g.disks.some((d) => d.system) && g.pools.length > 1 ? `<small class="stnote">Proxmox itself lives here too. A fresh install splits this disk into a folder for files and a pool for guests' disks. That's normal, and both stay.</small>` : ""}${g.pools.map((p) => poolBlock(p, g.disks.some((d) => d.system))).join("")}</section>`).join("")}
    ${m.empty.length ? section("Empty disks", `<section class="stgroup">${m.empty.map(diskLine).join("")}<small class="stnote">Nothing is on these yet. Add storage turns them into a pool.</small></section>`) : ""}
    ${m.otherDisks.length ? section("Disks used by something else", `<section class="stgroup">${m.otherDisks.map(diskLine).join("")}</section>`) : ""}
    ${m.unplaced.length ? section("On this node, disk not identified", `<section class="stgroup">${m.unplaced.map(poolBlock).join("")}</section>`) : ""}
    ${m.network.length ? section("Network storage", `<section class="stgroup">${m.network.map(poolBlock).join("")}</section>`) : ""}`;
}
async function loadStorageMap(node) {
  if (!node) return;
  const run = S.loadRun;
  try {
    const { map } = await signal(`api/storage-map?server=${encodeURIComponent(node)}`);
    if (run !== S.loadRun) return;
    S.storeMaps = { ...S.storeMaps, [node]: map };
    S.mapError = "";
  } catch (err) {
    if (err.message === "signed out" || run !== S.loadRun) return;
    S.mapError = err.message || "BossMox lost contact with Proxmox.";
  }
  drawStore();
}
function drawStore() {
  const box = $("#stbox");
  if (!box) return;
  const html = mapPane();
  if (html === box.dataset.drawn) return;
  box.innerHTML = html;
  box.dataset.drawn = html;
}
async function loadStorage() {
  const run = S.loadRun;
  try {
    const { list } = await signal("api/storage-list");
    if (run !== S.loadRun) return;
    S.storeList = list;
    S.storeError = "";
  } catch (err) {
    if (err.message === "signed out" || run !== S.loadRun) return;
    S.storeError = err.message || "BossMox lost contact with Proxmox.";
  }
  drawStore();
  if ($("#stbox")) await loadStorageMap(S.storeNode ?? onlineNodes()[0]);
}
async function loadDisks(node) {
  const run = S.loadRun;
  try {
    const { disks } = await signal(`api/disks?server=${encodeURIComponent(node)}`);
    if (run !== S.loadRun) return;
    S.diskData = { ...S.diskData, [node]: disks };
    drawStore();
    renderHealth();
  } catch { /* the next pass asks again, and the tab says it's still looking */ }
}
const afterStorage = async () => {
  await refresh();
  await loadStorage();
};
function askAddShare(kind = "") {
  S.scan = null;
  dialog(`<h3>Add ${kind === "smb" ? "an SMB share" : kind === "nfs" ? "an NFS share" : "network storage"}</h3><p>BossMox looks at what the NAS shares, so you can pick from a list.</p>
    <p class="loginerr" id="formerr" hidden></p>
    <label class="field restartname" ${kind ? "hidden" : ""}><span>Type</span><select id="sharekind"><option value="nfs" ${kind === "smb" ? "" : "selected"}>NFS</option><option value="smb" ${kind === "smb" ? "selected" : ""}>SMB (Windows sharing)</option></select></label>
    <label class="field restartname"><span>NAS address</span><input id="sharehost" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="192.168.1.20"></label>
    <div id="smbfields" hidden><div class="createrow"><label class="field"><span>Username</span><input id="shareuser" autocomplete="off" autocapitalize="none" spellcheck="false"></label><label class="field"><span>Password</span><input id="sharepass" type="password" autocomplete="new-password"></label></div></div>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-stscan="1">Look for shares</button></div>`);
  $("#smbfields").hidden = kind !== "smb";
  $("#sharehost").focus();
}
async function scanShares() {
  const kind = $("#sharekind").value;
  const host = $("#sharehost").value.trim();
  const username = $("#shareuser").value.trim();
  const password = $("#sharepass").value;
  if (!host) return formError("Enter the NAS address.");
  const server = onlineNodes()[0];
  if (!server) return formError("No node is online to look from.");
  const go = $("[data-stscan]");
  go.disabled = true;
  go.textContent = "Looking";
  try {
    const res = await post("api/storage-scan", { server, kind, host, username, password });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    if (!out.shares) throw new Error(`${server} couldn't reach ${host}${kind === "smb" ? ", or that sign-in was refused" : ""}.`);
    if (!out.shares.length) throw new Error(`${host} isn't sharing anything with this node.`);
    S.scan = { server, kind, host, username, password, shares: out.shares };
    const suggest = (out.shares[0].split("/").filter(Boolean).pop() ?? "nas").replace(/[^A-Za-z0-9-]/g, "-");
    dialog(`<h3>Add ${esc(host)}</h3><p class="loginerr" id="formerr" hidden></p>
      <label class="field restartname"><span>Shared folder</span><select id="sharepath">${out.shares.map((x) => `<option>${esc(x)}</option>`).join("")}</select></label>
      <label class="field restartname"><span>Name in BossMox</span><input id="shareid" maxlength="64" value="${esc(`nas-${suggest}`)}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
      <fieldset class="uses"><legend>What it's for</legend>${["backup", "iso", "vztmpl", "images", "rootdir"].map((u) => `<label class="createcheck"><input type="checkbox" value="${u}" ${u === "backup" || u === "iso" ? "checked" : ""}> ${USE_WORDS[u]}</label>`).join("")}</fieldset>
      <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-stsave="1">Test and add</button></div>`);
  } catch (err) {
    go.disabled = false;
    go.textContent = "Look for shares";
    if (err.message !== "signed out") formError(err.message || "BossMox lost contact with Proxmox.");
  }
}
const pickedUses = () => [...document.querySelectorAll(".uses input:checked")].map((c) => c.value);
function saveShare() {
  const c = S.scan;
  const id = $("#shareid").value.trim();
  const uses = pickedUses();
  if (!uses.length) return formError("Pick at least one thing to keep there.");
  if (S.storeList?.some((s) => s.id.toLowerCase() === id.toLowerCase())) return formError(`${id} already exists. Pick another name.`);
  runAction("storage-add", c.server, `Testing and adding ${id}`, { kind: c.kind, id, host: c.host, path: $("#sharepath").value, username: c.username, password: c.password, uses }, afterStorage);
  S.scan = null;
}
function askEditStorage(id) {
  const s = S.storeList.find((x) => x.id === id);
  S.editStore = id;
  dialog(`<h3>What's ${esc(id)} for?</h3><p class="loginerr" id="formerr" hidden></p>
    <fieldset class="uses"><legend>Keep on it</legend>${s.usesAllowed.map((u) => `<label class="createcheck"><input type="checkbox" value="${u}" ${s.uses.includes(u) ? "checked" : ""}> ${USE_WORDS[u]}</label>`).join("")}</fieldset>
    <p class="meta">Turning something off doesn't delete what's already there.</p>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-stuses="1">Save</button></div>`);
}
/**
 * Nothing on the node can hold this. Say so, and offer the fix instead of stopping (ADR 0014): a storage that
 * could hold it gets a button to start doing so, otherwise the way to add one.
 */
function noPlaceFor(title, server, use) {
  const words = USE_WORDS[use].toLowerCase().replace(/\bvm\b/g, "VM");
  const could = (S.storeList ?? []).filter((x) => !x.disabled && x.usesAllowed.includes(use) && !x.uses.includes(use) && (!x.nodes.length || x.nodes.includes(server)));
  const pick = could[0];
  S.noPlace = pick ? { id: pick.id, uses: [...pick.uses, use] } : null;
  dialog(`<h3>${esc(title)}</h3><p>${esc(server)} has no storage set up for ${esc(words)}.${pick ? ` ${esc(pick.id)} can hold them too, without changing anything already on it.` : " Add a NAS, or make storage on an empty disk, and pick this as one of the things it's for."}</p>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button>${pick ? `<button class="btn primary" data-noplace="1">Let ${esc(pick.id)} hold ${esc(words)}</button>` : `<button class="btn primary" data-openstore="1">Open Storage</button>`}</div>`);
}
function saveUses() {
  const uses = pickedUses();
  if (!uses.length) return formError("Pick at least one thing to keep there.");
  runAction("storage-edit", onlineNodes()[0], `Changing ${S.editStore}`, { id: S.editStore, uses }, afterStorage);
}
function askRemoveStorage(id) {
  dialog(`<h3>Remove ${esc(id)}?</h3><p>BossMox and Proxmox stop using it. Nothing on it is erased, so you can add it back later.</p>
    <label class="field restartname"><span>Type ${esc(id)} to confirm</span><input id="rname" data-word="${esc(id.toLowerCase())}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="rgo" data-stremovego="${esc(id)}" disabled>Remove</button></div>`);
  $("#rname").focus();
}
async function showDiskHealth(path) {
  const node = S.storeNode;
  const d = S.diskData?.[node]?.find((x) => x.path === path);
  dialog(`<h3>${esc(path)} on ${esc(node)}</h3><p>Asking the disk.</p>${closeRow}`);
  try {
    const r = await signal(`api/disk-smart?server=${encodeURIComponent(node)}&disk=${encodeURIComponent(path)}`);
    const rows = (r.attributes ?? []).map((a) => `${a.name ?? a.id}: ${a.raw ?? a.value ?? ""}`);
    const body = rows.length ? rows.join("\n") : r.text ?? "";
    dialog(`<h3>${esc(path)} on ${esc(node)}</h3><p class="${d?.failing ? "loginerr" : ""}">${d?.failing ? "This disk reports a problem. Move what's on it and replace it." : (r.health ?? "UNKNOWN") === "UNKNOWN" ? "This disk doesn't report its health. Virtual disks and some USB drives can't." : "This disk reports that it's healthy."}</p>
      ${body.trim() ? `<pre class="tasklog whole">${esc(body)}</pre>` : ""}${closeRow}`);
  } catch (err) {
    if (err.message !== "signed out") failDialog("Couldn't ask that disk", err);
  }
}
function askWipe(path) {
  const node = S.storeNode;
  const d = S.diskData[node].find((x) => x.path === path);
  S.editDisk = path;
  dialog(`<h3>Wipe ${esc(path)} on ${esc(node)}?</h3><p>Everything on this ${d.sizeGb} GB disk is erased for good. It holds ${esc(d.used)} now.</p>
    <label class="field restartname"><span>Type erase to confirm</span><input id="rname" data-word="erase" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="rgo" data-diskwipego="1" disabled>Wipe disk</button></div>`);
  $("#rname").focus();
}
function askMakeStorage() {
  const free = S.diskData[S.storeNode].filter((d) => d.free);
  dialog(`<h3>Make storage on ${esc(S.storeNode)}</h3><p class="loginerr" id="formerr" hidden></p>
    <label class="field restartname"><span>Type</span><select id="mkkind"><option value="zfs">ZFS: copies, checks and snapshots</option><option value="lvmthin">LVM-thin: simple, with snapshots</option><option value="directory">Folder: holds anything, including backups</option></select></label>
    <label class="field restartname"><span>Name</span><input id="mkname" maxlength="31" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="fast"></label>
    <fieldset class="uses" id="mkdisks"><legend>Disks</legend>${free.map((d) => `<label class="createcheck"><input type="checkbox" value="${esc(d.path)}"> ${esc(d.path)}, ${d.sizeGb} GB${d.model ? ` ${esc(d.model)}` : ""}</label>`).join("")}</fieldset>
    <div id="mkraidwrap"></div><div id="mkfswrap" hidden><label class="field restartname"><span>Format</span><select id="mkfs"><option>ext4</option><option>xfs</option></select></label></div>
    <label class="field restartname"><span>Everything on these disks is erased. Type erase to confirm</span><input id="rname" data-word="erase" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="rgo" data-mkgo="1" disabled>Make storage</button></div>`);
  drawMakeChoices();
}
const pickedDisks = () => [...document.querySelectorAll("#mkdisks input:checked")].map((c) => c.value);
/** Only offers layouts the number of picked disks can actually do. */
function drawMakeChoices() {
  const kind = $("#mkkind").value;
  const n = pickedDisks().length;
  $("#mkfswrap").hidden = kind !== "directory";
  const was = $("#mkraid")?.value;
  const options = [["single", "One disk, no copies", n === 1], ["mirror", "Mirror: survives losing all but one disk", n >= 2], ["raidz", "RAIDZ: survives losing 1 disk", n >= 3], ["raidz2", "RAIDZ2: survives losing 2 disks", n >= 4], ["raid10", "Striped mirrors: fast, survives 1 per pair", n >= 4 && n % 2 === 0]].filter((o) => o[2]);
  $("#mkraidwrap").innerHTML = kind === "zfs" && options.length ? `<label class="field restartname"><span>How the disks work together</span><select id="mkraid">${options.map(([k, l]) => `<option value="${k}" ${k === was ? "selected" : ""}>${l}</option>`).join("")}</select></label>` : "";
}
function makeStorage() {
  const kind = $("#mkkind").value;
  const devices = pickedDisks();
  const name = $("#mkname").value.trim();
  if (!name) return formError("Enter a name.");
  if (!devices.length) return formError("Pick a disk.");
  if (kind !== "zfs" && devices.length !== 1) return formError("This type uses one disk.");
  const node = S.storeNode;
  runAction("disk-storage", node, `Making ${name} on ${node}`, { kind, name, devices, raid: $("#mkraid")?.value ?? "", filesystem: $("#mkfs").value, confirm: "erase" }, async () => {
    await loadDisks(node);
    await afterStorage();
  });
}
function diskIssues() {
  return Object.entries(S.diskData ?? {}).flatMap(([node, disks]) => disks.filter((d) => d.failing).map((d) => ({ kind: "disk-health", title: `${d.path} on ${node} is failing`, detail: "" })));
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
  S.taskToken = (S.taskToken ?? 0) + 1;
  const me = S.taskToken;
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
    let view;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      view = await signal(url);
      if (me !== S.taskToken) return;
      drawTask(title, view);
      if (view.finished) break;
    }
    S.taskRunning = false;
    // What runs after success (clearing a deleted guest, re-checking a fix) mustn't run when Close ends a failure (#59).
    if (view.result === "failed") S.afterTask = null;
    loadServer();
  } catch (err) {
    if (me !== S.taskToken) return;
    S.taskRunning = false;
    S.afterTask = null;
    drawTask(title, null, err.message || "BossMox lost contact with Proxmox.");
  }
}

/* Update terminal */
let term = null;
/*
 * Guests moved off a node (ADR 0025). The record and the moves live on the BossMox server, so every browser sees
 * the same, and closing this page doesn't strand a move half done.
 */
async function loadMoves() {
  try {
    S.moves = await signal("api/moves");
  } catch (err) {
    if (err.message === "signed out") throw err;
  }
  return S.moves;
}
function movedGuests(server) {
  const a = S.moves?.away?.[server];
  return a?.guests?.length ? a : null;
}
const awayWords = (a) => a.guests.map((g) => `${g.name} (on ${g.to})`).join(", ");
/** Starts moving guests off a node or home to it. Returns the job's id. */
async function startMoves(action, server) {
  const res = await post(`api/action/${action}`, { server, confirm: server });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  return body.task;
}
/** One line on guests that stayed away because their home had no room, or "". */
function stayedWords(job) {
  const stayed = job.guests.filter((g) => g.state === "stayed");
  if (!stayed.length) return "";
  return `${stayed.map((g) => g.name).join(", ")} stayed where ${stayed.length === 1 ? "it is" : "they are"}: ${job.node} doesn't have room while keeping ${keepFree()}% free. ${stayed.length === 1 ? "It's" : "They're"} running, and Move everything back on ${job.node}'s Overview tries again later.`;
}
const keepFree = () => S.data?.preferences?.keepFreePct ?? 10;
const KEEP_CHOICES = [5, 10, 15, 20, 25, 30];
/** The cluster-wide room to keep on each node when BossMox moves guests. `again` redraws the window it's in. */
const keepFreeField = (again) => `<label class="field restartname"><span>Keep free on each node</span><select id="keepfree" data-keepagain="${esc(again)}">${KEEP_CHOICES.map((n) => `<option value="${n}" ${n === keepFree() ? "selected" : ""}>${n}% of memory, storage and processor</option>`).join("")}</select></label>`;
const jobOf = (m, id) => (m?.job && id && `job:${m.job.startedAt}` === id ? m.job : null);
function jobRows(job, home) {
  const word = (g) => ({
    done: home ? `Back on ${g.target}` : `Moved to ${g.target}`,
    failed: home ? "Didn't get home" : "Didn't move",
    stayed: "Stayed where it is: no room at home",
    moving: home ? "Moving back" : `Moving to ${g.target}`,
    waiting: job.running ? "Waiting its turn" : "Not moved",
  })[g.state];
  const dot = (g) => (g.state === "done" ? "running" : g.state === "failed" || g.state === "stayed" || (!job.running && g.state === "waiting") ? "warn" : "busy");
  return job.guests.map((g) => `<div class="snap"><div>${esc(g.name)}</div><span class="state"><span class="dot ${dot(g)}"></span>${esc(word(g))}</span></div>`).join("");
}
/** Follows a move job started from a node's Overview until it ends. */
async function followMoves(id, title) {
  let shown = false;
  for (;;) {
    let job = null;
    try {
      job = jobOf(await loadMoves(), id);
    } catch {
      return;
    }
    // Closed, or another window opened over it: stop following. The moves carry on without it (#57).
    if (shown && !($("#scrim").classList.contains("on") && $("#dialog [data-moveswin]"))) return;
    if (job) {
      shown = true;
      const words = job.error ? `<p class="loginerr">${esc(job.error)}</p>` : `<p>${job.running ? "One at a time, each checked for room first. You can close this: the moves carry on." : stayedWords(job) ? esc(stayedWords(job)) : "All of them are home."}</p>`;
      dialog(`<h3 data-moveswin="1">${esc(title)}</h3>${words}<div class="restartlist">${jobRows(job, job.kind === "home")}</div><div class="row-end">${job.running ? `<button class="btn" data-movestop="${esc(job.node)}">Stop after this one</button>` : ""}<button class="btn" data-dlg="cancel">Close</button></div>`);
      if (!job.running) {
        await refresh();
        renderServerDetail();
        return;
      }
    }
    await wait(2000);
  }
}
function askMoveBack(server) {
  const m = movedGuests(server);
  if (!m) return;
  confirmAction(`Move ${m.guests.length} back to ${server}?`, `${awayWords(m)} will move back to ${server}, one at a time. BossMox checks that ${server} has room before each one.`, `Move back to ${server}`, async () => {
    try {
      followMoves(await startMoves("move-home", server), `Moving back to ${server}`);
    } catch (err) {
      dialog(`<h3>Nothing moved</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p>${closeRow}`);
    }
  });
}
async function stopMoves(server) {
  const res = await post("api/action/move-stop", { server });
  if (!res.ok) throw new Error((await res.json()).error);
}

/*
 * Restart and Update all nodes (ADR 0027). The page asks what to do with each running VM, then the BossMox server
 * runs it. This page, or any other, only follows: closing it changes nothing.
 */
const PHASE_WORDS = { waiting: "Waiting its turn", checking: "Checking the cluster", emptying: "Moving and shutting down", installing: "Installing updates", restarting: "Restarting", starting: "Starting guests again", returning: "Bringing guests home", done: "Done", failed: "Stopped here" };
function vmWords(v, running = true) {
  return ({
    waiting: !running ? (v.choice === "shutdown" ? "Not shut down" : "Not moved") : v.choice === "shutdown" ? "Will shut down" : "Will move",
    moving: "Moving",
    moved: `On ${v.on ?? "another node"}`,
    stopping: "Shutting down",
    off: "Off for the restart",
    starting: "Starting",
    started: "Running again",
    home: "Back home",
    stayed: `Stayed on ${v.on ?? "another node"}`,
    failed: v.note ? `Problem: ${v.note}` : "Problem",
  })[v.state] ?? v.state;
}
const vmDot = (v) => (["home", "started", "moved"].includes(v.state) ? "running" : ["failed", "stayed"].includes(v.state) ? "warn" : v.state === "waiting" || v.state === "off" ? "" : "busy");

/** Opens the start window: what will happen to each running VM, with a choice for each. */
async function openRunStart(kind, server = "") {
  S.taskRunning = true;
  try {
    if (kind === "update") {
      const names = onlineNodes();
      dialog(`<h3>Checking every node for updates</h3><p>This looks for new updates. It doesn't install anything.</p>`);
      await Promise.all(names.map(async (n) => {
        const res = await post("api/action/check-updates", { server: n });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        // A failed check leaves that node's list stale. The plan reads Proxmox's task list and leaves it out, named (#55, #73).
        await followTask(n, body.task);
      }));
    } else dialog(`<h3>Planning the restart of ${esc(server)}</h3><p>Reading what runs there and where it can go.</p>`);
    const [plan, reboot] = await Promise.all([
      signal(`api/run-plan?kind=${kind}${kind === "restart" ? `&server=${encodeURIComponent(server)}` : ""}`),
      kind === "restart" ? signal(`api/reboot-plan?server=${encodeURIComponent(server)}`).catch(() => null) : null,
    ]);
    S.taskRunning = false;
    drawRunStart(kind, server, plan, reboot);
  } catch (err) {
    S.taskRunning = false;
    if (err.message === "signed out") return closeDialog();
    dialog(`<h3>Couldn't prepare it</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p>${closeRow}`);
  }
}
function drawRunStart(kind, server, plan, reboot) {
  S.runStart = { kind, server, plan, reboot };
  const again = `run:${kind}:${server}`;
  const busy = reboot?.busy?.length ? [`Wait for this to finish first: ${reboot.busy.join(", ")}.`] : [];
  const blocked = [...plan.blocked, ...busy];
  if (blocked.length) return dialog(`<h3>Not ready</h3>${blocked.map((b) => `<p class="loginerr">${esc(b)}</p>`).join("")}<div class="row-end"><button class="btn" data-dlg="cancel">Close</button><button class="btn" data-runagain="${esc(again)}">Check again</button></div>`);
  const skipped = (plan.notChecked ?? []).map((n) => `<p class="loginerr">Left out: ${esc(n.name)}. Its check for updates failed (${esc(n.why)}), so BossMox doesn't know what it needs. If its update channel needs a subscription it doesn't have, Health check can switch it to the free one.</p>`).join("");
  if (!plan.nodes.length) return dialog(skipped ? `<h3>Nothing to install on the nodes that were checked</h3>${skipped}${closeRow}` : `<h3>Every node is up to date</h3><p>Nothing is waiting to install.</p>${closeRow}`);
  const restarts = plan.nodes.filter((n) => n.restart);
  const pick = (v) => {
    if (v.self) return `<span class="state">BossMox itself: moves${v.to ? ` to ${esc(v.to)}` : ""}</span>`;
    const opts = [
      v.canMove ? `<option value="move" ${v.choice === "move" ? "selected" : ""}>Move${v.to ? ` to ${esc(v.to)}` : ""}</option>` : "",
      v.discSlots.length ? `<option value="eject">Eject its disc, then move</option>` : "",
      `<option value="shutdown" ${v.choice === "shutdown" ? "selected" : ""}>Shut down, start again after</option>`,
    ].join("");
    return `<select data-vmchoice="${v.id}" aria-label="What to do with ${esc(v.name)}">${opts}</select>`;
  };
  const row = (v) => `<div class="snap"><div>${esc(v.name)}${!v.canMove && !v.self ? `<small>${esc(v.why)}</small>` : ""}</div>${pick(v)}</div>`;
  const nodeBlock = (n) => `<div class="restartlist"><div class="snap"><div><b>${esc(n.name)}</b>${kind === "update" ? `<small>${n.updates} ${n.updates === 1 ? "update" : "updates"}${n.version ? `, version ${esc(n.version)}` : ""}</small>` : ""}</div><span class="state">${n.restart ? (n.vms.length ? "Restarts" : "Restarts, nothing running") : "No restart needed"}</span></div>${n.vms.map(row).join("")}</div>`;
  const how = kind === "update"
    ? "BossMox updates one node at a time, in this order. For a node that restarts, it moves or shuts down each running VM as chosen below, installs, restarts, starts what it shut down and brings the rest home. Config files you've changed keep your version. It runs on the BossMox server: you can close this window, and follow it from any browser."
    : "BossMox moves or shuts down each running VM as chosen below, restarts the node, then starts what it shut down and brings the rest home. It runs on the BossMox server: you can close this window, and follow it from any browser.";
  const word = kind === "update" ? "confirm" : "reboot";
  dialog(`<h3>${kind === "update" ? `Update ${plan.nodes.length === 1 ? esc(plan.nodes[0].name) : `${skipped ? "" : "all "}${plan.nodes.length} nodes`}?` : `Restart ${esc(server)}?`}</h3>
    <p>${how}</p>${skipped}
    ${restarts.some((n) => n.vms.length) ? `<p class="meta">${plan.moveBatch > 1 ? `Moves run up to ${plan.moveBatch} at a time.` : plan.moveShared ? "Moves run one at a time: they share the cluster heartbeat's only network. Health check says how to give them their own." : "Moves run one at a time."}</p>` : ""}
    ${plan.nodes.map(nodeBlock).join("")}
    ${restarts.some((n) => n.vms.length) ? keepFreeField(again) : ""}
    ${kind === "update" && !plan.keepsMajority && restarts.length ? `<div class="advice" style="margin-top:12px"><div><b>This cluster has only ${plan.votes} votes</b>Everything keeps running, but nothing can be started, stopped or changed while a node restarts.</div></div>` : ""}
    ${kind === "restart" && reboot?.backupStorages?.length && restarts[0]?.vms.length ? `<div class="restartbackup"><select id="rstore" aria-label="Backup storage" data-bkwarn="${esc(server)}">${reboot.backupStorages.map((s) => poolOption(server, s)).join("")}</select><button class="btn" data-backup="${esc(server)}">Back up first</button></div>${backupWarnLine(server, reboot.backupStorages[0].name)}` : ""}
    <label class="field restartname"><span>Type ${word} to start</span><input id="rname" data-word="${word}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="rgo" data-runstart="1" disabled>${kind === "update" ? "Start updating" : `Restart ${esc(server)}`}</button></div>`);
  S.restart = { server, guests: restarts.flatMap((n) => n.vms) };
  $("#rname").focus();
}
async function startRun() {
  const { kind, server } = S.runStart ?? {};
  if (!kind) return;
  const choices = Object.fromEntries([...document.querySelectorAll("[data-vmchoice]")].map((s) => [s.dataset.vmchoice, s.value]));
  const confirm = $("#rname").value;
  dialog(`<h3>Starting</h3><p>${Object.values(choices).includes("eject") ? "Taking the chosen discs out, then checking" : "Checking"} the plan once more.</p>`);
  try {
    const res = await post("api/action/run-start", { server: kind === "restart" ? server : onlineNodes()[0], kind, choices, confirm });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    openRun();
  } catch (err) {
    dialog(`<h3>It didn't start</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p><div class="row-end"><button class="btn" data-dlg="cancel">Close</button><button class="btn" data-runagain="run:${esc(kind)}:${esc(server)}">Check again</button></div>`);
  }
}
/** Follows the run in a window until it's closed. The run itself doesn't care whether anyone is watching. */
async function openRun() {
  S.runView = (S.runView ?? 0) + 1;
  const me = S.runView;
  for (;;) {
    try {
      S.run = (await signal("api/run")).run;
    } catch (err) {
      if (err.message === "signed out") return;
    }
    if (me !== S.runView) return;
    drawRun(S.run);
    renderHealth();
    if (!S.run?.running) {
      await refresh();
      return loadMoves().catch(() => {});
    }
    await wait(3000);
  }
}
function drawRun(run) {
  if (!run) return dialog(`<h3>Nothing is running</h3>${closeRow}`);
  const what = run.kind === "update" ? (run.nodes.length === 1 ? `Updating ${run.nodes[0].name}` : `Updating ${run.nodes.length} nodes`) : `Restarting ${run.nodes[0]?.name ?? ""}`;
  const title = run.running ? what : run.error ? `${what}: stopped` : run.kind === "update" ? "Updated" : `${run.nodes[0]?.name ?? ""} restarted`;
  const kept = run.nodes.flatMap((n) => n.keptConfig.map((f) => `${n.name}: ${f}`));
  const stayed = run.nodes.flatMap((n) => n.vms.filter((v) => v.state === "stayed"));
  // A node a Stop left partway reads as stopped, not as the step it was in.
  const halted = (n, i) => !run.running && i === run.current && !["done", "failed", "waiting"].includes(n.phase);
  const nodeBlock = (n, i) => `<div class="restartlist"><div class="snap"><div><b>${esc(n.name)}</b>${n.note ? `<small>${esc(n.note)}</small>` : ""}</div><span class="state"><span class="dot ${n.phase === "done" ? "running" : n.phase === "failed" || halted(n, i) ? "warn" : i === run.current && run.running ? "busy" : ""}"></span>${esc(halted(n, i) ? `Stopped after ${(PHASE_WORDS[n.phase] ?? n.phase).toLowerCase()}` : PHASE_WORDS[n.phase] ?? n.phase)}</span></div>
    ${n.restart ? n.vms.map((v) => `<div class="snap"><div>${esc(v.name)}${v.note && !["failed", "stayed"].includes(v.state) ? `<small>${esc(v.note)}</small>` : ""}</div><span class="state"><span class="dot ${vmDot(v)}"></span>${esc(vmWords(v, run.running))}</span></div>`).join("") : ""}</div>`;
  dialog(`<h3>${esc(title)}</h3>
    ${run.error ? `<p class="loginerr">${esc(run.error)}</p>` : run.running ? `<p>Started by ${esc(run.by)}. It runs on the BossMox server, so this window can be closed; open it again from the desktop.</p>` : `<p>Everything that was planned is done.</p>`}
    ${run.nodes.map(nodeBlock).join("")}
    ${stayed.map((v) => `<p class="meta">${esc(v.name)} stays on ${esc(v.on ?? "another node")}, running: ${esc((v.note ?? "its home had no room").replace(/\.$/, ""))}.</p>`).join("")}
    ${stayed.length ? `<p class="meta">Move everything back on a node's Overview tries again later.</p>` : ""}
    ${kept.length ? `<p class="meta">Config files you'd changed kept your version. The new one from the update sits beside each as .dpkg-dist: ${esc(kept.join(", "))}.</p>` : ""}
    <div class="row-end">${run.running ? `<button class="btn" data-runstop="1">Stop after this step</button>` : ""}<button class="btn" data-runclose="1">Close</button></div>`);
}
/** A line on the desktop while a run is going, for any browser. */
function runLine() {
  const r = S.run;
  if (!r?.running) return "";
  const n = r.nodes[r.current];
  return `<div class="look-items"><div class="look-row"><button class="look-item" data-runopen="1"><span class="dot busy"></span><span>${esc(r.kind === "update" ? "Updating nodes" : "Restarting a node")}${n ? `: ${esc(n.name)}, ${esc((PHASE_WORDS[n.phase] ?? n.phase).toLowerCase())}` : ""}</span></button></div></div>`;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const closeRow = `<div class="row-end"><button class="btn" data-dlg="cancel">Close</button></div>`;
async function followTask(server, task) {
  for (;;) {
    await wait(1000);
    const view = await signal(`api/task?server=${encodeURIComponent(server)}&task=${encodeURIComponent(task)}`);
    if (view.finished) return view;
  }
}

/* Network, read only for now: a wrong change here can cut off the server, so editing needs its own design. */
function drawNetwork(n) {
  const fact = (label, value) => (value ? `<dt>${label}</dt><dd>${esc(value)}</dd>` : "");
  const card = (i) => `<article class="netcard"><header><span class="dot ${i.active ? "running" : ""}"></span><b>${esc(i.name)}</b><small>${esc(i.kind)}${i.active ? "" : ", not connected"}</small></header>
    ${i.note ? `<p class="meta">${esc(i.note)}</p>` : ""}
    <dl class="plain">${fact("Address", i.address)}${fact("Gateway", i.gateway)}${fact("Uses", i.ports.join(", "))}${fact("Part of", i.partOf)}${i.kind === "Virtual switch" ? `<dt>Guests</dt><dd>${esc(i.guests.join(", ") || "None")}</dd>` : ""}</dl></article>`;
  $("#netdetail").innerHTML = `<div class="head"><div><h2>${esc(n.server)}</h2><div class="state">${n.dnsServers.length ? `Looks up names with ${esc(n.dnsServers.join(", "))}` : "No name server set"}${n.searchDomain ? `, in ${esc(n.searchDomain)}` : ""}</div></div></div>
    ${n.interfaces.map(card).join("") || `<p class="empty">This node didn't report any network connections.</p>`}
    <p class="meta">BossMox shows the network but can't change it yet. A wrong change here can cut off the node, so that's coming with a safety net.</p>`;
}
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
  if (S.nets[asked]) drawNetwork(S.nets[asked]);
  const run = S.loadRun;
  try {
    const n = await signal(`api/network?server=${encodeURIComponent(asked)}`);
    if (run !== S.loadRun || asked !== S.netServer || !$("#netdetail")) return;
    const changed = JSON.stringify(n) !== JSON.stringify(S.nets[asked]);
    S.nets[asked] = n;
    if (changed) drawNetwork(n);
  } catch (err) {
    if (err.message !== "signed out" && $("#netdetail")) $("#netdetail").innerHTML = `<p class="empty">${esc(err.message || "BossMox lost contact with Proxmox.")}</p>`;
  }
}

/** Redrawn only when it changes, so an opened explanation doesn't snap shut on the next address check. */
function drawAgentHelp(v) {
  const box = $("#vmagent");
  const html = agentHelp(v);
  if (box && box.dataset.drawn !== html) {
    box.innerHTML = html;
    box.dataset.drawn = html;
  }
}
function agentHelp(v) {
  const a = S.addresses?.[v.id];
  if (!a || a.known) return "";
  return `<details class="agentmore"><summary>How to set that up</summary><small>The guest agent is a small program inside the VM that tells Proxmox its address and lets it shut down cleanly. To install it: on Debian or Ubuntu, <code>apt install qemu-guest-agent</code>; on Windows, the guest tools on the virtio-win disc. ${v.agent ? "Its setting is already on here, so once it's installed it should show up within a minute." : `Its setting is off here too. Turning it on takes effect after ${esc(v.name)} is shut down and started again.`}</small>${v.agent ? "" : `<button class="linkbtn" data-agenton="${v.id}">Turn on the guest agent setting</button>`}</details>`;
}
function snapshotAdvice(v) {
  const fix = S.snapFix?.[v.id] ?? [];
  if (!fix.length) return `<div class="advice"><div><b>Snapshots aren't available for ${esc(v.name)}</b>The storage holding its disk can't take them. Backups still work.</div></div>`;
  return `<div class="advice"><div><b>Snapshots aren't available for ${esc(v.name)} yet</b>Its disks are kept in a format that can't be snapshotted. BossMox can convert them where they are, which takes about a minute for every few GB. ${v.running ? "Shut it down first." : ""}</div><button class="btn" data-snapfix="${v.id}" ${v.running ? "disabled" : ""}>Make snapshots work</button></div>`;
}
/* A guest's address, asked for only while its Overview is showing */
function addressWords(v) {
  const a = S.addresses?.[v.id];
  if (!a) return "Checking";
  if (a.list.length) return a.list.join(", ");
  if (v.type === "qemu" && !a.known) return "Unknown until the guest agent is running inside it";
  return "None yet";
}
async function loadAddress(v) {
  const got = S.addresses?.[v.id];
  if (got && Date.now() - got.at < 20000) return;
  S.addresses = { ...S.addresses, [v.id]: { list: got?.list ?? [], known: got?.known ?? true, at: Date.now() } };
  if (v.type === "qemu" && !v.agent) {
    S.addresses[v.id].known = false;
    if (S.sel === v.id && $("#vmaddr")) $("#vmaddr").textContent = addressWords(v);
    if (S.sel === v.id) drawAgentHelp(v);
    return;
  }
  try {
    const r = await signal(`api/guest-addresses?server=${encodeURIComponent(v.node)}&guest=${v.id}&type=${v.type}`);
    S.addresses[v.id] = { list: r.addresses, known: r.known, at: Date.now() };
    if (S.sel === v.id && $("#vmaddr")) $("#vmaddr").textContent = addressWords(v);
    if (S.sel === v.id) drawAgentHelp(v);
  } catch { /* the next look asks again */ }
}

/* Hardware */
const planFor = (v) => signal(`api/create-plan?server=${encodeURIComponent(v.node)}&kind=${v.type}`);
const after = () => refresh().then(renderDetail);
/** Where a storage is and what it can't do, in a few words, from the storage map. Empty until the map has loaded. */
function poolWords(node, id) {
  const m = S.storeMaps?.[node];
  if (!m) return "";
  for (const g of m.groups) {
    const p = g.pools.find((x) => x.id === id);
    if (p) return `${g.disks.some((d) => d.system) ? "on the system disk" : `on ${g.disks.map((d) => (d.model ? `${d.model} (${d.path})` : d.path)).join(" + ")}`}${p.snapshots.startsWith("Snapshots don't") ? ", no snapshots" : ""}`;
  }
  const n = m.network.find((x) => x.id === id);
  return n ? `${n.title.toLowerCase()}${n.details ? ` at ${n.details}` : ""}` : "";
}
const poolOption = (node, s, selected = false) => {
  const words = poolWords(node, s.name ?? s);
  const free = s.freeGb === undefined ? "" : `, ${s.freeGb} GB free`;
  return `<option value="${esc(s.name ?? s)}" ${selected ? "selected" : ""}>${esc(s.name ?? s)}${words ? `, ${esc(words)}` : ""}${free}</option>`;
};
const storageOptions = (plan, node = plan.server ?? S.storeNode) => plan.storages.map((s) => poolOption(node, s)).join("");
/** A backup on the same computer as the guests goes down with it. Said under every place a backup is saved. */
function backupWarning(node, id) {
  const m = S.storeMaps?.[node];
  if (!m || m.network.some((p) => p.id === id)) return "";
  const g = m.groups.find((x) => x.pools.some((p) => p.id === id));
  if (!g) return "";
  return g.disks.some((d) => d.system)
    ? "This is the system disk, the same drive Proxmox runs from. If that drive fails, these backups go with it. A NAS, or at least another drive, is much safer."
    : "This drive is in the same computer as the guests. If the computer fails or is stolen, the backups go with it. A NAS is safer.";
}
const backupWarnLine = (node, id) => `<p class="meta warnline" data-bkwarnfor="${esc(node)}">${esc(backupWarning(node, id))}</p>`;
/** A network as a person sees it: the node's own network, a port it's plugged into, or guests only. */
function bridgeWords(node, name) {
  const i = S.nets?.[node]?.interfaces?.find((x) => x.name === name);
  if (!i) return name;
  if (i.gateway) return `${name}, the network the node itself is on`;
  if (i.ports?.length) return `${name}, connected to ${i.ports.join(" and ")}`;
  return `${name}, guests only: no network port, so they can only reach each other`;
}
const bridgeOptions = (node, list) => list.map((b) => `<option value="${esc(b)}">${esc(bridgeWords(node, b))}</option>`).join("");
const formError = (text) => {
  const e = $("#formerr");
  e.textContent = text;
  e.hidden = false;
};
function askGrow(slot) {
  const v = selected();
  S.editDisk = slot;
  dialog(`<h3>Grow this disk</h3><p>It's ${v.disks.find((d) => d.slot === slot)?.sizeGb} GB now. A disk can only grow, and the system inside ${esc(v.name)} may need telling about the new space.</p>
    <p class="loginerr" id="formerr" hidden></p>
    <label class="field restartname"><span>GB to add</span><input id="growby" type="number" min="1" value="8"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-growgo="1">Grow disk</button></div>`);
  $("#growby").focus();
}
function growDisk() {
  const v = selected();
  const addGb = Number($("#growby").value);
  if (!Number.isInteger(addGb) || addGb < 1) return formError("Enter a whole number of GB.");
  runAction("disk-grow", v.node, `Growing a disk on ${v.name}`, { ...guestBody(v), disk: S.editDisk, addGb }, after);
}
async function askAddDisk() {
  const v = selected();
  let plan;
  try {
    plan = await planFor(v);
  } catch (err) {
    return failDialog("Couldn't prepare that", err);
  }
  dialog(`<h3>Add a disk to ${esc(v.name)}</h3><p class="loginerr" id="formerr" hidden></p>
    <div class="createrow"><label class="field"><span>Size in GB</span><input id="disksize" type="number" min="1" value="32"></label></div>
    <label class="field"><span>Keep it on</span><select id="diskstore">${storageOptions(plan, v.node)}</select></label>
    ${v.type === "lxc" ? `<label class="field"><span>Where it appears</span><input id="diskmount" placeholder="/data" autocomplete="off" autocapitalize="none" spellcheck="false"></label>` : ""}
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-diskaddgo="1">Add disk</button></div>`);
}
function addDisk() {
  const v = selected();
  const sizeGb = Number($("#disksize").value);
  if (!Number.isInteger(sizeGb) || sizeGb < 1) return formError("Enter a whole number of GB.");
  if (v.type === "lxc" && !$("#diskmount").value.trim()) return formError("Enter where it should appear, such as /data.");
  runAction("disk-add", v.node, `Adding a disk to ${v.name}`, { ...guestBody(v), sizeGb, storage: $("#diskstore").value, mount: $("#diskmount")?.value.trim() ?? "" }, after);
}
function askRemoveDisk(slot) {
  const v = selected();
  const d = v.disks.find((x) => x.slot === slot);
  dialog(`<h3>Erase this disk?</h3><p>The ${d?.sizeGb} GB disk ${esc(slot)} on ${esc(v.name)} and everything on it is erased for good.</p>
    <label class="field restartname"><span>Type erase to confirm</span><input id="rname" data-word="erase" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="rgo" data-diskremovego="${esc(slot)}" disabled>Erase disk</button></div>`);
  $("#rname").focus();
}
function removeDisk(slot) {
  const v = selected();
  runAction("disk-remove", v.node, `Erasing a disk on ${v.name}`, { ...guestBody(v), disk: slot, confirm: "erase" }, after);
}
async function askAddNic() {
  const v = selected();
  let plan;
  try {
    plan = await planFor(v);
  } catch (err) {
    return failDialog("Couldn't prepare that", err);
  }
  dialog(`<h3>Add a network card to ${esc(v.name)}</h3><p class="loginerr" id="formerr" hidden></p>
    <label class="field"><span>Network</span><select id="nicbridge">${bridgeOptions(v.node, plan.bridges)}</select></label>
    <label class="field"><span>VLAN, if it needs one</span><input id="nicvlan" inputmode="numeric" autocomplete="off"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-nicaddgo="1">Add card</button></div>`);
}
function addNic() {
  const v = selected();
  runAction("nic-add", v.node, `Adding a network card to ${v.name}`, { ...guestBody(v), bridge: $("#nicbridge").value, vlan: $("#nicvlan").value.trim() }, after);
}
/* A container's address (ADR 0024). A VM's address is set inside the VM, so only containers get this. */
const addrWords = (n) => (n.ip === "dhcp" ? "automatic address" : n.ip ? `${n.ip}${n.gw ? ` via ${n.gw}` : ""}` : "no IPv4 address");
function askAddress(slot) {
  const v = selected();
  const n = v.nics.find((x) => x.slot === slot);
  if (!n) return;
  const fixed = n.ip && n.ip !== "dhcp";
  dialog(`<h3>Change ${esc(v.name)}'s address</h3>
    <p>On ${esc(n.bridge)}${n.vlan ? `, VLAN ${esc(n.vlan)}` : ""}. Now: ${esc(addrWords(n))}.</p><p class="loginerr" id="formerr" hidden></p>
    <label class="field"><span>Address</span><select id="addrmode"><option value="fixed" ${fixed ? "selected" : ""}>Fixed: stays the same</option><option value="dhcp" ${fixed ? "" : "selected"}>Automatic: from your router</option></select></label>
    <div id="addrfixed" ${fixed ? "" : "hidden"}><div class="createrow">
      <label class="field"><span>Address and network size</span><input id="addrip" placeholder="192.168.1.30/24" value="${fixed ? esc(n.ip) : ""}" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Gateway (your router)</span><input id="addrgw" placeholder="192.168.1.1" value="${esc(n.gw ?? "")}" autocomplete="off" spellcheck="false"></label></div>
      <p class="meta">Make sure nothing else on the network uses that address.</p></div>
    ${v.running ? `<p class="meta">${esc(v.name)} is running, so the change happens right away. Anything connected to its old address, like an SSH session, is cut off.${fixed ? "" : " It also keeps its old automatic address until it restarts, so restart it afterward."}</p>` : ""}
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-addrgo="${esc(slot)}">Change address</button></div>`);
}
function changeAddress(slot) {
  const v = selected();
  const mode = $("#addrmode").value;
  const address = $("#addrip").value.trim();
  const gateway = $("#addrgw").value.trim();
  if (mode === "fixed" && !/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(address)) return formError("Type the address with its network size, like 192.168.1.30/24.");
  runAction("guest-address", v.node, `Changing ${v.name}'s address`, { ...guestBody(v), nic: slot, confirm: slot, mode, address, gateway }, after);
}
document.addEventListener("change", (e) => {
  if (e.target.id === "addrmode") $("#addrfixed").hidden = e.target.value !== "fixed";
});
function askRemoveNic(slot) {
  const v = selected();
  const n = v.nics.find((x) => x.slot === slot);
  confirmAction(`Remove this network card from ${v.name}?`, `It's connected to ${n?.bridge}. Anything using it loses that connection.`, "Remove card", () => runAction("nic-remove", v.node, `Removing a network card from ${v.name}`, { ...guestBody(v), nic: slot, confirm: slot }, after), true);
}
async function askClone(id) {
  const v = S.data?.vms.find((g) => g.id === id);
  if (!v) return;
  if (v.type === "lxc" && v.running) return dialog(`<h3>Shut down ${esc(v.name)} first</h3><p>Proxmox can only copy a container while it's shut down.</p>${closeRow}`);
  let plan;
  try {
    plan = await planFor(v);
  } catch (err) {
    return failDialog("Couldn't prepare that", err);
  }
  dialog(`<h3>${v.template ? `New guest from ${esc(v.name)}` : `Clone ${esc(v.name)}`}</h3><p>${v.template ? "This makes a separate guest from the template." : "This makes a complete separate copy."} ${v.running ? `${esc(v.name)} keeps running, with a brief pause as the copy starts.` : ""} The new one starts switched off, on ${esc(v.node)}.</p>
    <p class="loginerr" id="formerr" hidden></p>
    <label class="field restartname"><span>Name</span><input id="clonename" maxlength="63" value="${esc(v.template ? "" : `${v.name}-copy`)}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <label class="field"><span>Keep its disks on</span><select id="clonestore">${storageOptions(plan, v.node)}</select></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-clonego="${v.id}">${v.template ? "Create" : "Clone"}</button></div>`);
  $("#clonename").focus();
}
function cloneGuest(id) {
  const v = S.data.vms.find((g) => g.id === id);
  const name = $("#clonename").value.trim();
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(name)) return formError("A name uses letters, numbers, dots and dashes, and starts and ends with a letter or number.");
  if (S.data.vms.some((g) => g.name.toLowerCase() === name.toLowerCase())) return formError(`${name} already exists. Pick another name.`);
  runAction("guest-clone", v.node, `Making ${name}`, { ...guestBody(v), name, storage: $("#clonestore").value }, after);
}
function askTemplate(id) {
  const v = S.data?.vms.find((g) => g.id === id);
  if (!v) return;
  if (v.running) return dialog(`<h3>Shut ${esc(v.name)} down first</h3><p>A running guest can't become a template. Shut it down from its Overview, then make it a template.</p>${closeRow}`);
  dialog(`<h3>Make ${esc(v.name)} a template?</h3><p>A template is a master copy for making new guests. ${esc(v.name)} can't be started again after this, and that can't be undone. Clone it first if you want to keep using it.</p>
    <label class="field restartname"><span>Type template to confirm</span><input id="rname" data-word="template" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn danger" id="rgo" data-templatego="${v.id}" disabled>Make template</button></div>`);
  $("#rname").focus();
}
function makeTemplate(id) {
  const v = S.data.vms.find((g) => g.id === id);
  runAction("guest-template", v.node, `Making ${v.name} a template`, { ...guestBody(v), confirm: "template" }, after);
}

/* Installer discs from this computer, and container templates */
function askUpload(server = S.createFor.server, stores = S.createPlan?.mediaStorages ?? [], after = null) {
  S.uploadTo = { server, after: after ?? (() => loadCreate(server, S.createFor.kind)) };
  if (!stores.length) return noPlaceFor("Nowhere to keep a disc", server, "iso");
  dialog(`<h3>Upload an installer disc</h3><p>The file goes straight to ${esc(server)}. Keep this page open until it finishes.</p>
    <p class="loginerr" id="formerr" hidden></p>
    <label class="field restartname"><span>Disc image (.iso)</span><input id="uploadfile" type="file" accept=".iso,.img"></label>
    <label class="field restartname"><span>Keep it on</span><select id="uploadstore">${stores.map((s) => poolOption(server, s)).join("")}</select></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-uploadgo="1">Upload</button></div>`);
}
function startUpload() {
  const file = $("#uploadfile").files[0];
  if (!file) return formError("Choose a file first.");
  if (!/^[\w.-]+\.(iso|img)$/i.test(file.name)) return formError("That has to be an .iso or .img file, with no spaces in its name.");
  const { server, after } = S.uploadTo;
  const storage = $("#uploadstore").value;
  const xhr = new XMLHttpRequest();
  S.taskRunning = true;
  const show = (line) => dialog(`<h3>Uploading ${esc(file.name)}</h3><p>${esc(line)}</p><div class="meter"><i style="width:${S.uploadPct ?? 0}%"></i></div>`);
  S.uploadPct = 0;
  show("Starting.");
  xhr.upload.onprogress = (e) => {
    S.uploadPct = Math.round((e.loaded / e.total) * 100);
    show(S.uploadPct < 100 ? `${S.uploadPct}% sent.` : "Sent. Proxmox is saving it.");
  };
  const done = (title, line, bad) => {
    S.taskRunning = false;
    dialog(`<h3>${esc(title)}</h3><p class="${bad ? "loginerr" : ""}">${esc(line)}</p>${closeRow}`);
    S.afterTask = after;
  };
  xhr.onload = () => {
    let body = {};
    try {
      body = JSON.parse(xhr.responseText);
    } catch { /* the status still says what happened */ }
    if (xhr.status === 401) {
      S.taskRunning = false;
      closeDialog();
      return showLogin("You've been signed out. Sign in again to continue.");
    }
    if (xhr.status !== 200) return done("The upload failed", body.error || "BossMox couldn't finish that.", true);
    // The file has arrived, but Proxmox still has to save it: it's ready only when that task ends well (#53).
    if (!body.task) return done("Uploaded", `${file.name} is ready on ${server}.`, false);
    show("Sent. Proxmox is saving it.");
    followTask(server, body.task).then(
      (view) => (view.result === "failed" ? done("The upload failed", `Proxmox couldn't save ${file.name}: ${view.message || "it didn't say why"}.`, true) : done("Uploaded", `${file.name} is ready on ${server}.`, false)),
      (err) => (err.message === "signed out" ? done("Signed out", "You were signed out while Proxmox was saving the file. Sign in again and check Storage to see if it's there.", true) : done("Not sure it saved", `${file.name} arrived, but BossMox lost sight of Proxmox saving it. Check Storage to see if it's there.`, true)),
    );
  };
  xhr.onerror = () => done("The upload failed", "The connection dropped. Nothing was saved.", true);
  xhr.open("POST", `api/upload?server=${encodeURIComponent(server)}&storage=${encodeURIComponent(storage)}&filename=${encodeURIComponent(file.name)}`);
  xhr.setRequestHeader("X-BossMox", "1");
  xhr.setRequestHeader("Content-Type", "application/octet-stream");
  xhr.send(file);
}
async function askDownloadTemplate() {
  const { server } = S.createFor;
  const stores = S.createPlan?.mediaStorages ?? [];
  let list;
  try {
    list = (await signal(`api/templates?server=${encodeURIComponent(server)}`)).templates;
  } catch (err) {
    return failDialog("Couldn't list the templates", err);
  }
  if (!list.length) return dialog(`<h3>No templates listed</h3><p>${esc(server)} hasn't fetched the template list yet. Try again in a minute.</p>${closeRow}`);
  if (!stores.length) return noPlaceFor("Nowhere to keep a template", server, "vztmpl");
  dialog(`<h3>Download a template</h3><p>A template is a ready-made system for new containers. ${esc(server)} downloads it directly.</p>
    <label class="field restartname"><span>System</span><select id="tmplname">${list.map((t) => `<option value="${esc(t.template)}">${esc(t.template.replace(/\.tar\.\w+$/, ""))}</option>`).join("")}</select></label>
    <label class="field restartname"><span>Keep it on</span><select id="tmplstore">${stores.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-tmplgo="1">Download</button></div>`);
}
function downloadTemplate() {
  const { server, kind } = S.createFor;
  runAction("template-download", server, "Downloading the template", { storage: $("#tmplstore").value, template: $("#tmplname").value }, () => loadCreate(server, kind));
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
    S.createFor = { server, kind };
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
    ${!vm && !p.installers.length ? `<p class="meta">This node has no templates yet. Download one to make a container.</p>` : ""}
    ${vm ? `<p class="meta" style="margin:-8px 0 14px">${p.installers.length ? "" : "This node has no installer discs yet. "}<button class="linkbtn" data-discadd="1">Add a disc from a web address</button> or <button class="linkbtn" data-discupload="1">upload one</button></p>` : `<p class="meta" style="margin:-8px 0 14px"><button class="linkbtn" data-tmpladd="1">Download a template</button></p>`}
    ${vm ? "" : field("Password for root", `<input id="cpassword" type="password" autocomplete="new-password">`)}
    <div class="createrow">
      ${field(`Processor cores (${p.cores} here)`, `<input id="ccores" type="number" min="1" max="128" value="${esc(kept.cores)}">`)}
      ${field(`Memory in GB (${p.memoryGb} here)`, `<input id="cmemory" type="number" min="0.25" step="0.25" value="${esc(kept.memory)}">`)}
      ${field("Disk in GB", `<input id="cdisk" type="number" min="1" value="${esc(kept.disk)}">`)}
    </div>
    ${field("Keep its disk on", `<select id="cstorage">${p.storages.map((s) => poolOption(server, s)).join("")}</select>`)}
    ${p.storages.length ? "" : `<p class="loginerr">${esc(server)} has nowhere to keep ${vm ? "VM" : "container"} disks yet. <button class="linkbtn" data-openstore="1">Open Storage</button> and use Add storage.</p>`}
    ${field("Network", `<select id="cbridge">${bridgeOptions(server, p.bridges)}</select>`)}
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
async function askGuestDelete(id) {
  const v = S.data?.vms.find((g) => g.id === id);
  if (!v) return;
  if (v.running) return dialog(`<h3>Shut ${esc(v.name)} down first</h3><p>A running guest can't be deleted. Shut it down from its Overview, then delete it.</p>${closeRow}`);
  const clones = (S.data?.vms ?? []).filter((x) => x.id !== v.id && (x.refs ?? []).some((r) => r.includes(`base-${v.id}-disk-`))).map((x) => x.name);
  if (clones.length) {
    return dialog(`<h3>${esc(v.name)} can't be deleted yet</h3><p>${esc(clones.join(", "))} ${clones.length === 1 ? "was" : "were"} made from this template and still ${clones.length === 1 ? "needs" : "need"} it. Delete ${clones.length === 1 ? "that clone" : "those clones"} first.</p>${closeRow}`);
  }
  // Asked fresh: what this says decides whether someone deletes their only copy.
  dialog(`<h3>Delete ${esc(v.name)}?</h3><p>Checking its backups.</p>`);
  let backups = null;
  try {
    const list = await signal("api/backups");
    backups = list.groups.find((g) => g.id === v.id)?.backups ?? [];
  } catch { /* said below */ }
  const kept = backups === null
    ? "BossMox couldn't check its backups just now, so don't count on there being one."
    : backups.length
      ? `It has ${backups.length === 1 ? "1 backup" : `${backups.length} backups`}, the newest from ${when(backups[0].takenAt)}. ${backups.length === 1 ? "That stays" : "Those stay"}, so it can be restored.`
      : "It has no backups, so once it's deleted there's no getting it back.";
  dialog(`<h3>Delete ${esc(v.name)}?</h3><p>${esc(v.name)} and its disks are erased for good, and its snapshots go too. ${esc(kept)}</p>
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
  const run = S.loadRun;
  try {
    const list = await signal("api/backups");
    if (run !== S.loadRun) return;
    const changed = JSON.stringify(list) !== JSON.stringify(S.backups) || S.backupsError;
    S.backups = list;
    S.backupsError = "";
    if (changed) drawBackups();
  } catch (err) {
    if (err.message === "signed out" || run !== S.loadRun) return;
    S.backupsError = err.message || "BossMox lost contact with Proxmox.";
    drawBackups();
  }
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
  const elsewhere = b.backupsElsewhere
    ? `<p class="meta bkelse">BossMox isn't checking backup schedules, because you back up your guests another way. Failed Proxmox backups are still reported. <button class="linkbtn" data-backupselsewhere="off">Check schedules again</button></p>`
    : "";
  return `${elsewhere}${protectBanner()}${b.unscheduled.length ? `<div class="advice"><div><b>${b.unscheduled.length} ${b.unscheduled.length === 1 ? "isn't" : "aren't"} on a backup schedule</b>${esc(b.unscheduled.join(", "))}</div><div class="actions"><button class="btn" data-jobadd="1">Add a schedule</button><button class="btn" data-backupselsewhere="on">We back up another way</button></div></div>` : ""}
    ${b.groups.map(group).join("")}
    ${missing.length ? `<h3 class="bkhead">No backups yet</h3>${missing.map((v) => `<div class="snap"><div>${esc(v.name)}<small>On ${esc(v.node)}</small></div><button class="btn" data-bknow="${v.id}">Back up now</button></div>`).join("")}` : ""}
    ${!b.groups.length && !missing.length ? `<p class="empty">There's nothing to back up yet.</p>` : ""}`;
}
/** A schedule that takes in every guest also takes in ones made later, which is why this is the one to have. */
const everythingCovered = () => S.backups.schedules.some((j) => j.what === "Everything" && j.on);
const protectBanner = () => (everythingCovered() ? "" : `<div class="advice"><div><b>Protect everything</b>Back up every guest each night, including new ones you add later.</div><button class="btn primary" data-protect="1">Set it up</button></div>`);
async function askProtect() {
  const server = onlineNodes()[0];
  if (!server) return;
  try {
    const plan = await signal(`api/reboot-plan?server=${encodeURIComponent(server)}`);
    if (!plan.backupStorages.length) {
      dialog(`<h3>Nowhere to save backups</h3><p>Add a NAS first, and pick Backups as one of the things it's for.</p><div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-openstore="1">Open Storage</button></div>`);
      return;
    }
    S.protectOn = server;
    const best = [...plan.backupStorages].sort((a, b) => Number(b.shared) - Number(a.shared))[0];
    const on = (x) => poolOption(server, x, x.name === best.name);
    dialog(`<h3>Protect everything</h3><p>Every guest gets backed up each night, including new ones you add later. Proxmox runs this itself, so BossMox doesn't need to be running.</p>
      <p class="loginerr" id="formerr" hidden></p>
      <label class="field restartname"><span>Save to</span><select id="prstore" data-bkwarn="${esc(server)}">${plan.backupStorages.map(on).join("")}</select></label>
      ${backupWarnLine(server, best.name)}
      <div class="createrow"><label class="field"><span>What time</span><input id="prtime" type="time" value="02:00"></label><label class="field"><span>Nights to keep</span><input id="prkeep" type="number" min="1" max="99" value="7"></label></div>
      <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-protectgo="1">Protect everything</button></div>`);
  } catch (err) {
    if (err.message !== "signed out") failDialog("Couldn't prepare that", err);
  }
}
function saveProtect() {
  const time = $("#prtime").value;
  const keep = Number($("#prkeep").value);
  if (!/^\d\d:\d\d$/.test(time)) return formError("Pick a time.");
  if (!Number.isInteger(keep) || keep < 1 || keep > 99) return formError("Keep between 1 and 99 nights.");
  runAction("schedule-add", S.protectOn, "Setting up nightly backups", { schedule: time, guests: "all", storage: $("#prstore").value, keep }, () => {
    S.bkTab = "schedules";
    return loadBackups();
  });
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
    if (!plan.backupStorages.length) return noPlaceFor("Nowhere to save a backup", v.node, "backup");
    dialog(`<h3>Back up ${esc(v.name)} now?</h3><p>${v.running ? `${esc(v.name)} keeps running, though it may feel slower until this finishes.` : `${esc(v.name)} is off, so this is quick.`}</p>
      <label class="field restartname"><span>Save to</span><select id="bkstore" data-bkwarn="${esc(v.node)}">${plan.backupStorages.map((s) => poolOption(v.node, s)).join("")}</select></label>${backupWarnLine(v.node, plan.backupStorages[0].name)}
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
    if (!plan.storages.length) return noPlaceFor("Nowhere to restore to", x.node, x.type === "lxc" ? "rootdir" : "images");
    S.bkPlan = { x, plan };
    dialog(`<h3>Restore ${esc(x.group.name)}?</h3><p>From ${esc(when(x.takenAt))}, on ${esc(x.node)}. A copy sits alongside the original, switched off, and nothing is lost.</p>
      <label class="field restartname"><span>Put its disks on</span><select id="bkdisk">${plan.storages.map((s) => poolOption(x.node, s)).join("")}</select></label>
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
    if (!plan.backupStorages.length) return noPlaceFor("Nowhere to save backups", server, "backup");
    const days = [["", "Every day"], ["mon", "Mondays"], ["tue", "Tuesdays"], ["wed", "Wednesdays"], ["thu", "Thursdays"], ["fri", "Fridays"], ["sat", "Saturdays"], ["sun", "Sundays"]];
    dialog(`<h3>Add a backup schedule</h3>
      <p class="loginerr" id="joberr" hidden></p>
      <label class="field restartname"><span>What to back up</span><select id="jobwhat"><option value="all">Everything</option>${S.data.vms.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join("")}</select></label>
      <label class="field restartname"><span>Which days</span><select id="jobday">${days.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
      <label class="field restartname"><span>What time, on the node's clock</span><input id="jobtime" type="time" value="02:00"></label>
      <label class="field restartname"><span>Save to</span><select id="jobstore" data-bkwarn="${esc(server)}">${plan.backupStorages.map((s) => poolOption(server, s)).join("")}</select></label>${backupWarnLine(server, plan.backupStorages[0].name)}
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
    const { supported, fix } = await signal(`api/snapshot-support?server=${encodeURIComponent(v.node)}&guest=${v.id}&type=${v.type}`);
    S.snapSupport = { ...S.snapSupport, [v.id]: supported };
    S.snapFix = { ...S.snapFix, [v.id]: fix ?? [] };
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
}
async function openTerminal(server) {
  if (term && term.guest === null) return openWin("terminal");
  try {
    if (term) throw new Error("Close the open console first, then open the updater.");
    const res = await post("api/action/install-updates", { server });
    const body = await res.json();
    if (res.status === 401) return showLogin("You've been signed out. Sign in again to continue.");
    if (!res.ok) throw new Error(body.error);
    showTerminal(server, body.terminal, "Install updates", `Updating ${esc(server)}. Check the list, then type <b>Y</b> and press Enter to install.`);
  } catch (err) {
    dialog(`<h3>Couldn't start the install</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p><div class="row-end"><button class="btn" data-dlg="cancel">Close</button></div>`);
  }
}
function showTerminal(server, id, title, help, guest = null, typed = null) {
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
    let waiting = typed;
    if (typed) setTimeout(() => {
      if (!waiting || term?.socket !== socket) return;
      waiting = null;
      const h = $(".vnctools span", wins.terminal);
      if (h) h.textContent = "The prompt didn't appear, so nothing was typed. Paste the command from the update window and press Enter.";
    }, 20000);
    socket.onmessage = (e) => {
      const bytes = new Uint8Array(e.data);
      xterm.write(bytes);
      if (waiting) {
        recent = (recent + decoder.decode(bytes, { stream: true })).slice(-400);
        if (atPrompt(recent)) {
          socket.send(`0:${utf8.encode(waiting).length}:${waiting}`);
          waiting = null;
        }
      }
      if (term?.done || isConsole) return;
      // Proxmox prints this when the updater finishes, then leaves a root shell open.
      recent = (recent + decoder.decode(bytes)).slice(-200);
      if (/(^|\n)starting shell\r?\n/.test(recent) && term) {
        term.done = true;
        $(".termhelp").textContent = `The updater has finished on ${server}. Check the output, then close this window.`;
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

/** True when a terminal's latest output ends at a shell prompt (root's # or a user's $), colours stripped. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape codes is the point.
const atPrompt = (text) => /[#$] ?$/.test(text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, ""));

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
      ${screen && v.type === "qemu" ? `<button class="btn" data-bootmenu="${id}">Force BIOS</button>` : ""}
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
/** typed: a command to type at the node's prompt without pressing Enter, so the person still starts it (ADR 0020). */
async function openNodeConsole(server, typed = null) {
  if (term) return dialog(`<h3>A terminal is already open</h3><p>Close it first, then open this console.</p>${closeRow}`);
  try {
    const res = await post("api/action/node-console", { server });
    const body = await res.json();
    if (res.status === 401) return showLogin("You've been signed out. Sign in again to continue.");
    if (!res.ok) throw new Error(body.error);
    const help = typed
      ? `The BossMox update command is typed in for you. Press Enter to start it, then type y when it asks. Near the end BossMox restarts: this window closes, and you sign in again on the new version.`
      : `Console for ${esc(server)}. Anything you run here changes the node right away.`;
    showTerminal(server, body.terminal, typed ? `Update BossMox on ${server}` : `Console: ${server}`, help, "node", typed);
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

/* Changing a VM or container's settings. The whole tab is the form, and only what changed gets sent. */
const CPU_COMMON = [["", "Proxmox default (kvm64)"], ["x86-64-v2-AES", "x86-64-v2-AES: moves between most hardware"], ["x86-64-v3", "x86-64-v3: newer, still portable"], ["host", "host: fastest, but needs matching hardware to move"]];
const OS_WORDS = [["l26", "Linux"], ["win11", "Windows 11 or Server 2022 and later"], ["win10", "Windows 10 or Server 2016 and 2019"], ["win8", "Windows 8 or Server 2012"], ["win7", "Windows 7 or Server 2008 R2"], ["l24", "Older Linux (2.4)"], ["solaris", "Solaris"], ["other", "Something else"]];
const MACHINE_WORDS = [["", "i440fx (default)"], ["q35", "q35 (newer, needed for PCIe passthrough)"]];
const CONTROLLER_WORDS = [["virtio-scsi-single", "VirtIO SCSI single (best for Linux)"], ["virtio-scsi-pci", "VirtIO SCSI"], ["lsi", "LSI 53C895A (works without drivers)"], ["lsi53c810", "LSI 53C810"], ["megasas", "MegaRAID SAS"], ["pvscsi", "VMware PVSCSI"]];
const DISPLAY_WORDS = [["", "Default"], ["std", "Standard VGA"], ["virtio", "VirtIO GPU"], ["qxl", "SPICE (qxl)"], ["vmware", "VMware compatible"], ["serial0", "Serial console"], ["none", "None"]];
const WAIT_WORDS = { memory: "Memory", cores: "Processor cores", sockets: "Sockets", cpu: "Processor type", balloon: "Memory it can shrink to", machine: "Machine type", scsihw: "Disk controller", vga: "Display", ostype: "Operating system", name: "Name", onboot: "Start at boot", swap: "Swap", agent: "Guest agent", tablet: "Tablet pointer", numa: "NUMA", cpulimit: "Processor limit", hostname: "Name", features: "Features", nameserver: "DNS servers", searchdomain: "Search domain", bios: "Starts with" };
const pickOne = (id, choices, now) => {
  const list = choices.some(([k]) => k === now) ? choices : [...choices, [now, now]];
  return `<select data-set="${id}">${list.map(([k, l]) => `<option value="${esc(k)}" ${k === now ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
};
const setText = (id, label, now, extra = "") => `<label class="field"><span>${label}</span><input data-set="${id}" value="${esc(now ?? "")}" autocomplete="off" autocapitalize="none" spellcheck="false" ${extra}></label>`;
const setNumber = (id, label, now, extra = "") => `<label class="field"><span>${label}</span><input data-set="${id}" type="number" value="${now ?? ""}" ${extra}></label>`;
const setGb = (id, label, mb, extra = "") => `<label class="field"><span>${label}</span><input data-set="${id}" data-gb="1" type="number" min="0" step="0.25" value="${mb === null || mb === undefined ? "" : mb / 1024}" ${extra}></label>`;
const setCheck = (id, label, on) => `<label class="createcheck"><input data-set="${id}" type="checkbox" ${on ? "checked" : ""}> ${label}</label>`;
const setPick = (id, label, choices, now) => `<label class="field"><span>${label}</span>${pickOne(id, choices, now)}</label>`;
function settingsPane(v) {
  const s = v.settings;
  if (!s) return `<p class="meta">Proxmox didn't return this guest's settings.</p>`;
  // What the form shows. Refreshes update v.settings but don't redraw the form, so changes are counted against this copy:
  // otherwise a field nobody touched here would be saved back over a change made elsewhere meanwhile (#56).
  S.setBase = { id: v.id, settings: { ...s } };
  const cpu = [...CPU_COMMON, ...(S.cpuTypes ?? []).filter((c) => !CPU_COMMON.some(([k]) => k === c)).map((c) => [c, c])];
  const common = `<h3 class="sethead">General</h3>
    ${setText("name", "Name", s.name, 'maxlength="63"')}
    <label class="field"><span>Notes</span><textarea data-set="notes" rows="3" maxlength="8000">${esc(s.notes)}</textarea></label>
    <div class="createrow">${setText("tags", "Tags, separated by spaces", s.tags)}${setNumber("startOrder", "Start order, if it matters", s.startOrder, 'min="1" max="999"')}</div>
    ${setCheck("onboot", "Start when its node starts", s.onboot)}
    ${setCheck("protection", "Protect from being deleted", s.protection)}`;
  const body = v.type === "qemu" ? `${common}
    <h3 class="sethead">Processor</h3>
    <div class="createrow">${setNumber("cores", "Cores", s.cores, 'min="1" max="128"')}${setNumber("sockets", "Sockets", s.sockets, 'min="1" max="4"')}</div>
    ${setPick("cpu", "Type", cpu, s.cpu)}
    <div class="createrow">${setNumber("cpuLimit", "Limit in cores, blank for none", s.cpuLimit, 'min="0" max="128" step="0.25"')}</div>
    ${setCheck("numa", "NUMA, for VMs that span physical processors", s.numa)}
    <h3 class="sethead">Memory</h3>
    <div class="createrow">${setGb("memoryMb", "Memory in GB", s.memoryMb, 'min="0.25"')}${setGb("balloonMb", "Can shrink to, in GB. Blank to stay fixed", s.balloonMb)}</div>
    <h3 class="sethead">System</h3>
    ${setPick("ostype", "Operating system", OS_WORDS, s.ostype)}
    ${setPick("bios", "Starts with", [["seabios", "BIOS"], ["ovmf", "UEFI"]], s.bios)}
    ${setPick("machine", "Machine type", MACHINE_WORDS, s.machine)}
    ${setPick("scsihw", "Disk controller", CONTROLLER_WORDS, s.scsihw)}
    ${setPick("display", "Display", DISPLAY_WORDS, s.display)}
    ${setCheck("agent", "The guest agent is installed inside it", s.agent)}
    ${setCheck("tablet", "Tablet pointer, so the mouse tracks in the console", s.tablet)}
    ${setCheck("acpi", "ACPI, so shutting down works from outside", s.acpi)}
    ${setCheck("kvm", "Hardware virtualization", s.kvm)}` : `${common}
    <h3 class="sethead">Processor and memory</h3>
    <div class="createrow">${setNumber("cores", "Cores", s.cores, 'min="1" max="128"')}${setNumber("cpuLimit", "Limit in cores, blank for none", s.cpuLimit, 'min="0" max="128" step="0.25"')}</div>
    <div class="createrow">${setGb("memoryMb", "Memory in GB", s.memoryMb, 'min="0.25"')}${setGb("swapMb", "Swap in GB", s.swapMb)}</div>
    <h3 class="sethead">Network names</h3>
    <div class="createrow">${setText("dns", "DNS servers, blank to copy the node", s.dns)}${setText("searchDomain", "Search domain", s.searchDomain)}</div>
    <h3 class="sethead">Features</h3>
    ${setCheck("nesting", "Nesting, needed for Docker and some newer systems", s.nesting)}
    ${setCheck("keyctl", "Keyctl, also needed for Docker in an unprivileged container", s.keyctl)}
    ${setCheck("fuse", "FUSE file systems", s.fuse)}
    <p class="meta">System: ${esc(s.system || "unknown")}. ${s.unprivileged ? "Unprivileged" : "Privileged"} container. These can't be changed after it's made.</p>`;
  return `<form id="setform" autocomplete="off">${body}<div class="setbar"><button type="button" class="btn" id="setundo" data-setundo="1" disabled>Undo changes</button><button type="button" class="btn primary" id="setsave" data-setsave="1" disabled>Save changes</button></div></form>
    <details class="upgroup"><summary>Technical details</summary><div class="raw">${Object.entries(v.tech).map(([k, val]) => `<span>${esc(k)}</span><code>${esc(val)}</code>`).join("")}</div></details>`;
}
function settingsChanges(v) {
  const out = {};
  const shown = S.setBase?.id === v.id ? S.setBase.settings : v.settings;
  document.querySelectorAll("#setform [data-set]").forEach((el) => {
    const key = el.dataset.set;
    const now = shown[key];
    let value = el.value;
    if (el.type === "checkbox") value = el.checked;
    else if (el.dataset.gb) value = el.value === "" ? null : Math.round(Number(el.value) * 1024);
    else if (el.type === "number") value = el.value === "" ? null : Number(el.value);
    else if (key === "tags") value = el.value.split(/[\s,;]+/).filter(Boolean).join(" ");
    else if (el.tagName === "TEXTAREA" || key === "name") value = el.value.trimEnd();
    if ((value ?? "") !== (now ?? "")) out[key] = value;
  });
  return out;
}
function settingsTouched() {
  const v = selected();
  if (!v?.settings) return;
  const n = Object.keys(settingsChanges(v)).length;
  $("#setsave").disabled = !n;
  $("#setundo").disabled = !n;
  $("#setsave").textContent = n ? `Save ${n} ${n === 1 ? "change" : "changes"}` : "Save changes";
}
function saveSettings() {
  const v = selected();
  const changes = settingsChanges(v);
  const name = changes.name;
  const taken = name && S.data.vms.find((g) => g.id !== v.id && g.name.toLowerCase() === name.toLowerCase());
  const go = () => runAction("guest-settings", v.node, `Saving ${name ?? v.name}`, { ...guestBody(v), changes }, async () => {
    await refresh();
    await loadWaiting(v);
    renderDetail();
  });
  if (taken) return dialog(`<h3>That name's taken</h3><p>${esc(taken.name)} already exists. Pick another name.</p>${closeRow}`);
  // Proxmox saves this happily, then refuses to start the guest, so it's said here instead.
  const wanted = (changes.cores ?? v.settings.cores) * (changes.sockets ?? v.settings.sockets ?? 1);
  const has = S.data.nodes.find((n) => n.name === v.node)?.cores ?? 0;
  if (has && wanted > has) return dialog(`<h3>That's more than ${esc(v.node)} has</h3><p>${wanted} processor cores were asked for, and ${esc(v.node)} has ${has}. Proxmox wouldn't be able to start ${esc(v.name)}.</p>${closeRow}`);
  const risky = ["bios", "machine", "scsihw"].filter((k) => k in changes);
  if (risky.length && !v.template) return confirmAction(`Change how ${v.name} starts?`, "Changing the firmware, machine type or disk controller can stop an installed system from starting. If it does, change it back.", "Save changes", go, true);
  go();
}
async function loadWaiting(v) {
  if (v.type === "lxc" && !v.running) return;
  try {
    const { waiting } = await signal(`api/guest-waiting?server=${encodeURIComponent(v.node)}&guest=${v.id}&type=${v.type}`);
    const had = JSON.stringify(S.waiting?.[v.id] ?? []);
    S.waiting = { ...S.waiting, [v.id]: waiting };
    if (S.sel === v.id && had !== JSON.stringify(waiting) && S.tab !== "settings") renderDetail();
    else if (S.sel === v.id) drawWaiting(v);
  } catch { /* the next look asks again */ }
}
function waitingWords(v) {
  const list = S.waiting?.[v.id] ?? [];
  if (!list.length) return "";
  const said = [...new Set(list.map((w) => (w.key === "memory" ? `Memory, ${Number(w.next) / 1024} GB` : w.key === "cores" ? `Processor cores, ${w.next}` : WAIT_WORDS[w.key] ?? "A hardware change")))];
  return `<div class="advice"><div><b>Waiting for a restart</b>${esc(said.join(". "))}. ${v.running ? "These apply the next time it's shut down and started." : "These apply when it next starts."}</div></div>`;
}
function drawWaiting(v) {
  const box = $("#vmwaiting");
  if (box) box.innerHTML = waitingWords(v);
}
function forceBios(id) {
  const v = S.data.vms.find((g) => g.id === id);
  if (!v.running) return startToBootMenu(id);
  confirmAction(`Restart ${v.name} into its boot menu?`, "It restarts right away, like pressing the reset button. Anything unsaved inside it is lost.", "Restart now", async () => {
    const state = $("#vncstate");
    const was = state?.textContent;
    if (state) state.textContent = "Restarting to the boot menu.";
    try {
      const res = await post("api/action/guest-boot-menu", { server: v.node, ...guestBody(v), confirm: String(v.id) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
    } catch (err) {
      failDialog(`${v.name} didn't restart`, err);
    }
    if (state?.isConnected) state.textContent = was;
  }, true);
}
/** Goes straight to the console, because the menu is why they pressed the button. */
async function startToBootMenu(id) {
  const v = S.data.vms.find((g) => g.id === id);
  dialog(`<h3>Starting ${esc(v.name)}</h3><p>BossMox is getting it to the boot menu, then opens the console.</p>`);
  try {
    const res = await post("api/action/guest-boot-menu", { server: v.node, ...guestBody(v), confirm: String(v.id) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    closeDialog();
    await refresh();
    renderDetail();
    openConsole(v.id);
  } catch (err) {
    failDialog(`${v.name} didn't start`, err);
  }
}
const discName = (disc) => (disc === "" ? "Empty" : disc === "cdrom" ? "The node's own disc drive" : disc.split("/").pop());
/** Every disc drive a VM has (ADR 0026). With none, the usual ide2 drive can still be given a disc. */
function discSection(v) {
  const drives = v.discDrives ?? [];
  if (!drives.length) return v.discLocked ? "" : `<div class="hwhead"><h3>Disc drive</h3><button class="btn" data-gdisc="ide2">Change disc</button></div><div class="snap"><div>Empty</div></div>`;
  return `<div class="hwhead"><h3>${drives.length > 1 ? "Disc drives" : "Disc drive"}</h3></div>${drives.map((d) => `<div class="snap"><div>${esc(discName(d.disc))}<small>${esc(d.slot)}</small></div><div class="actions"><button class="btn" data-gdisc="${esc(d.slot)}">Change disc</button></div></div>`).join("")}`;
}
async function askGuestDisc(slot = "ide2") {
  const v = selected();
  S.discSlot = slot;
  const now = (v.discDrives ?? []).find((d) => d.slot === slot)?.disc ?? v.disc;
  let discs;
  try {
    discs = (await planFor(v)).installers;
  } catch (err) {
    return failDialog("Couldn't list the discs", err);
  }
  const known = discs.some((d) => d.volid === now);
  dialog(`<h3>Change the disc in ${esc(v.name)}${(v.discDrives ?? []).length > 1 ? `, ${esc(slot)}` : ""}</h3>
    <label class="field restartname"><span>Installer disc</span><select id="gdisc"><option value="">No disc</option>${now && !known ? `<option value="${esc(now)}" selected>${esc(discName(now))}</option>` : ""}${discs.map((d) => `<option value="${esc(d.volid)}" ${d.volid === now ? "selected" : ""}>${esc(d.label)}</option>`).join("")}</select></label>
    <div class="row-end"><button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-gdiscgo="1">Save</button></div>`);
}

/* Getting an installer disc onto a server from a web address */
function askDisc() {
  const server = $("#cserver").value;
  const stores = S.createPlan?.mediaStorages ?? [];
  if (!stores.length) return noPlaceFor("Nowhere to keep a disc", server, "iso");
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
  if (!/^https:\/\/\S+\.iso$/i.test(url)) {
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
  tasklog: () => `<div class="vms"><aside><div id="tlnodes"></div></aside><div id="tlbox"><div class="tltools"><input class="search" id="tlq" type="search" placeholder="Find a task" aria-label="Find a task" value="${esc(S.tlQ ?? "")}"><select id="tlshow" aria-label="Which tasks"><option value="all">All tasks</option><option value="problems">Problems only</option></select></div><div id="tlrows"></div></div></div>`,
  network: () => `<div class="vms"><aside><div id="netlist"></div></aside><div id="netdetail"></div></div>`,
  backups: () => `<div id="bkbox" class="bkbox"></div>`,
  health: () => `<div id="hcbox" class="bkbox"></div>`,
  settings: () => `<div id="setbox" class="bkbox"></div>`,
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
  if (d.noticex) {
    const n = readNotices();
    saveNotices({ ...n, dismissed: [...n.dismissed, d.noticex] });
    return renderHealth();
  }
  if (d.noticetoggle) {
    const n = readNotices();
    saveNotices({ ...n, collapsed: !n.collapsed });
    return renderHealth();
  }
  if (d.urange) {
    S.usageRange = d.urange;
    if (wins.vms) renderDetail();
    if (wins.monitor) renderServerDetail();
    return;
  }
  if (d.lineup) {
    closeDeskMenu();
    saveIconSpots({});
    return layoutIcons();
  }
  if (d.noticerestore) {
    saveNotices({ ...readNotices(), dismissed: [], collapsed: false });
    return renderHealth();
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
  if (d.restartserver) return openRunStart("restart", d.restartserver);
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
  if (d.bootmenu) return forceBios(+d.bootmenu);
  if (d.setsave) return saveSettings();
  if (d.setundo) return renderDetail();
  if (d.gdisc) return askGuestDisc(d.gdisc === "1" ? "ide2" : d.gdisc);
  if (d.gdiscgo) {
    const v = selected();
    return runAction("guest-disc", v.node, `Changing the disc in ${v.name}`, { ...guestBody(v), slot: S.discSlot ?? "ide2", disc: $("#gdisc").value }, after);
  }
  if (d.discadd) return askDisc();
  if (d.discgo) return downloadDisc();
  if (d.taskview) return viewTask(d.tasknode, d.taskview);
  if (d.tasklog) {
    S.tlNode = d.tasklog;
    openWin("tasklog");
    return drawTaskLog();
  }
  if (d.tlnode) {
    S.tlNode = d.tlnode;
    return drawTaskLog();
  }
  if (d.tlmore) return moreTasks();
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
  if (d.openstore) {
    closeDialog();
    return openWin("storage");
  }
  if (d.protect) return askProtect();
  if (d.protectgo) return saveProtect();
  if (d.stadd) return askAddShare();
  if (d.stscan) return scanShares();
  if (d.stsave) return saveShare();
  if (d.stedit) return askEditStorage(d.stedit);
  if (d.stuses) return saveUses();
  if (d.setupstart) return askSetup();
  if (d.setup) {
    if (d.setup === "share") return askAddShare(d.setupval);
    if (d.setup === "where") S.setup.where = d.setupval;
    if (d.setup === "purpose") {
      S.setup.name = $("#setupname")?.value.trim() || S.setup.name;
      if (!S.setup.named || Object.values(POOL_NAMES).includes(S.setup.name)) S.setup.name = POOL_NAMES[d.setupval];
      S.setup.purpose = d.setupval;
    }
    return drawSetup();
  }
  if (d.setupnext) return setupSummary();
  if (d.setupback) return drawSetup();
  if (d.setupgo) return setupGo();
  if (d.pooldel) return askPoolDelete(d.pooldel);
  if (d.pooldelgo) {
    const id = S.poolDelete;
    const node = S.poolDeleteNode;
    return runAction("pool-delete", node, `Deleting ${id}`, { storage: id, confirm: id }, async () => {
      await loadDisks(node);
      await afterStorage();
    });
  }
  if (d.checknow) {
    t.disabled = true;
    return (async () => {
      const res = await post("api/action/update-check-now", { server: onlineNodes()[0] });
      if (!res.ok) throw new Error((await res.json()).error);
      await refresh();
      S.healthAgain = true;
      if (wins.health) await loadHealthCheck();
      const avail = S.data?.update?.available;
      if (avail) return dialog(`<h3>BossMox ${esc(avail.version)} is available</h3><p>Updating keeps your settings and doesn't touch your guests.</p><div class="row-end"><button class="btn" data-dlg="cancel">Close</button><button class="btn primary" data-bmupdate="1">How to update</button></div>`);
      if (wins.health) return;
      dialog(`<h3>BossMox is up to date</h3>${closeRow}`);
    })().catch((err) => dialog(`<h3>BossMox couldn't check</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p>${closeRow}`));
  }
  if (d.bmupdate) {
    const u = S.data?.update;
    if (!u?.available) return;
    // The update script looks for the BossMox VM on the node it runs on, so it has to run where that VM is.
    const home = S.data.vms.filter((v) => v.name === "bossmox");
    const first = home.length === 1 && onlineNodes().includes(home[0].node) ? home[0].node : null;
    const where = first ? `on ${esc(first)}, the node that holds the BossMox VM` : "on the node that holds the BossMox VM";
    return dialog(`<h3>Update to BossMox ${esc(u.available.version)}</h3>
      <p>Run this as root ${where}, in its console or over SSH. It downloads the new version, checks it, and restarts BossMox. Your settings stay, your guests aren't touched, and if the new version doesn't start, the old one comes back. Anyone signed in is signed out once.</p>
      <pre class="tasklog whole updcmd">${esc(u.command)}</pre>
      <p class="meta"><a href="${esc(u.available.url)}" target="_blank" rel="noopener noreferrer">What's new in ${esc(u.available.version)}</a></p>
      ${first ? `<p class="meta">Update now opens ${esc(first)}'s console here with the command typed in. Press Enter, then type y when it asks.</p>` : ""}
      <div class="row-end"><button class="btn" data-dlg="cancel">Close</button><button class="btn ${first ? "" : "primary"}" data-copyupdate="1">Copy the command</button>${first ? `<button class="btn primary" data-updnow="${esc(first)}">Update now</button>` : ""}</div>`);
  }
  if (d.updnow) {
    const cmd = S.data?.update?.command;
    if (!cmd) return;
    closeDialog();
    return openNodeConsole(d.updnow, cmd);
  }
  if (d.copyupdate) {
    const cmd = S.data?.update?.command ?? "";
    // The clipboard needs a secure page and permission; when it says no, the command is selected for Ctrl+C.
    const select = () => {
      const r = document.createRange();
      r.selectNodeContents($("#dialog .updcmd"));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      t.textContent = "Selected: press Ctrl+C";
    };
    if (!navigator.clipboard) return select();
    navigator.clipboard.writeText(cmd).then(() => (t.textContent = "Copied"), select);
    return;
  }
  if (d.updatecheck) {
    const on = d.updatecheck === "on";
    const after = async () => {
      await refresh();
      if (wins.health) {
        S.healthAgain = true;
        await loadHealthCheck();
      }
    };
    return on
      ? confirmAction("Check for BossMox updates?", "Every 6 hours BossMox asks GitHub whether a newer version is out, and tells you if there is. It never installs anything by itself. GitHub sees this BossMox's internet address when it asks.", "Check for updates", () => runAction("preferences-set", onlineNodes()[0], "Saving", { updateCheck: true }, after))
      : confirmAction("Stop checking for updates?", "BossMox will stop asking GitHub for new versions, for everyone who uses it, so it won't tell you when one is out. You can turn the check back on in the health check.", "Stop checking", () => runAction("preferences-set", onlineNodes()[0], "Saving", { updateCheck: false }, after));
  }
  if (d.backupselsewhere) {
    const on = d.backupselsewhere === "on";
    const after = async () => {
      await refresh();
      if (wins.backups) await loadBackups();
      if (wins.health) {
        S.healthAgain = true;
        await loadHealthCheck();
      }
    };
    return on
      ? confirmAction("Stop warning about backup schedules?", "Use this if your guests are backed up by something Proxmox doesn't know about, such as Veeam, a script or another backup server. BossMox stops warning about guests without a Proxmox backup schedule, for everyone who uses it, in every browser. Failed Proxmox backups are still reported, and you can turn the warnings back on any time.", "Stop the warnings", () => runAction("preferences-set", onlineNodes()[0], "Saving", { backupsElsewhere: true }, after))
      : confirmAction("Check backup schedules again?", "BossMox will warn again about any guest that isn't on a Proxmox backup schedule, for everyone who uses it.", "Check schedules again", () => runAction("preferences-set", onlineNodes()[0], "Saving", { backupsElsewhere: false }, after));
  }
  if (d.movefix) return moveFix();
  if (d.hapolicy) {
    return confirmAction("Have HA move its guests before a node restarts?", "Proxmox's HA shutdown policy changes to Migrate for the whole cluster. When a node shuts down or restarts, from Proxmox or by hand, the guests HA manages move to another node first, and come back after. A guest that can't move holds up the shutdown.", "Turn it on", () => runAction("recommended-set", onlineNodes()[0], "Saving", { id: "ha-shutdown", on: true, choice: "" }, async () => {
      S.healthChecks = null;
      S.healthAgain = true;
      await loadHealthCheck();
    }));
  }
  if (d.leftover) {
    S.leftoverKeep = new Set();
    return drawLeftover();
  }
  if (d.logo) return removeLeftover();
  if (d.mfnet) {
    S.moveFix.net = d.mfnet;
    const c = S.recommended?.find((x) => x.id === "move-network")?.choices?.find((x) => x.value === d.mfnet);
    // A network that also carries storage starts with the limit on.
    if (c?.storage) Object.assign(S.moveFix, { limitOn: true, speed: S.moveFix.speed === "50" ? "250" : S.moveFix.speed });
    return drawMoveFix();
  }
  if (d.mfgo) return applyMoveFix();
  if (d.setsw) {
    const s = S.recommended?.find((x) => x.id === d.setsw);
    if (!s) return;
    return askSetting(s.id, !s.on, S.setChoice[s.id] ?? s.choice ?? "");
  }
  if (d.setagain) {
    S.recommended = null;
    drawSettings();
    return loadSettings();
  }
  if (d.hcagain) {
    S.healthChecks = null;
    S.healthAgain = true;
    drawHealthCheck();
    return loadHealthCheck();
  }
  if (d.hcupdates) {
    openWin("monitor");
    pickServer(d.hcupdates);
    S.serverTab = "updates";
    return renderServerDetail();
  }
  if (d.hcadd) {
    openWin("storage");
    return askSetup();
  }
  if (d.hcstore !== undefined) {
    if (d.hcstore) S.storeNode = d.hcstore;
    openWin("storage");
    return drawStore();
  }
  if (d.hcboot) {
    const ids = d.hcboot.split(",").map(Number);
    const names = ids.map((id) => S.data?.vms.find((v) => v.id === id)?.name).filter(Boolean);
    return confirmAction(`Start ${names.length === 1 ? names[0] : `${names.length} guests`} at boot?`, `${names.join(", ")} will start by themselves whenever ${names.length === 1 ? "its node" : "their nodes"} start, after a power cut or an update restart. Nothing changes while ${names.length === 1 ? "it's" : "they're"} running now.`, "Start at boot", () => runAction("boot-on", onlineNodes()[0], "Saving", { guests: ids.join(",") }, async () => {
      await refresh();
      await loadHealthCheck();
    }));
  }
  if (d.snapfix) {
    const v = S.data?.vms.find((g) => g.id === +d.snapfix);
    if (!v) return;
    return confirmAction(`Make snapshots work for ${v.name}?`, `BossMox converts ${v.name}'s disks to a format that can be snapshotted, on the same storage. It takes about a minute for every few GB, and ${v.name} stays shut down until it's done. Make a backup first if it holds anything you can't lose.`, "Convert its disks", () => runAction("snapshot-fix", v.node, `Converting ${v.name}'s disks`, { ...guestBody(v), confirm: String(v.id) }, async () => {
      delete S.snapSupport[v.id];
      await refresh();
      await checkSnapshots(v);
      renderDetail();
    }));
  }
  if (d.agenton) {
    const v = S.data?.vms.find((g) => g.id === +d.agenton);
    if (!v) return;
    return confirmAction(`Turn on the guest agent setting for ${v.name}?`, `It takes effect after ${v.name} is shut down and started again. The agent itself still has to be installed inside it.`, "Turn it on", () => runAction("guest-settings", v.node, `Saving ${v.name}`, { ...guestBody(v), changes: { agent: true } }, refresh));
  }
  if (d.poolopen) {
    S.openPools ??= new Set();
    const key = `${S.storeNode}/${d.poolopen}`;
    if (S.openPools.has(key)) S.openPools.delete(key);
    else S.openPools.add(key);
    return drawStore();
  }
  if (d.itemdelete) return askItemDelete(d.itempool, d.itemdelete);
  if (d.itemupload) {
    const node = S.storeNode;
    return askUpload(node, [d.itemupload], () => loadStorageMap(node));
  }
  if (d.noplace && S.noPlace) {
    const { id, uses } = S.noPlace;
    return runAction("storage-edit", onlineNodes()[0], `Letting ${id} hold more`, { id, uses }, afterStorage);
  }
  if (d.stremove) return askRemoveStorage(d.stremove);
  if (d.stremovego) {
    t.disabled = true;
    return runAction("storage-remove", onlineNodes()[0], `Removing ${d.stremovego}`, { id: d.stremovego, confirm: d.stremovego }, afterStorage);
  }
  if (d.diskhealth) return showDiskHealth(d.diskhealth);
  if (d.diskwipe) return askWipe(d.diskwipe);
  if (d.diskwipego) {
    t.disabled = true;
    const node = S.storeNode;
    return runAction("disk-wipe", node, `Wiping ${S.editDisk}`, { disk: S.editDisk, confirm: "erase" }, async () => {
      await loadDisks(node);
      await loadStorageMap(node);
    });
  }
  if (d.diskmake) return askMakeStorage();
  if (d.mkgo) return makeStorage();
  if (d.jobsave) return saveSchedule();
  if (d.jobtoggle) return toggleSchedule(d.jobtoggle);
  if (d.jobdelete) return askScheduleDelete(d.jobdelete);
  if (d.power) return askPower(d.power, d.guest ? +d.guest : S.sel);
  if (d.diskgrow) return askGrow(d.diskgrow);
  if (d.growgo) return growDisk();
  if (d.diskadd) return askAddDisk();
  if (d.diskaddgo) return addDisk();
  if (d.diskremove) return askRemoveDisk(d.diskremove);
  if (d.diskremovego) {
    t.disabled = true;
    return removeDisk(d.diskremovego);
  }
  if (d.nicadd) return askAddNic();
  if (d.nicaddgo) return addNic();
  if (d.nicremove) return askRemoveNic(d.nicremove);
  if (d.addrchange) return askAddress(d.addrchange);
  if (d.addrgo) return changeAddress(d.addrgo);
  if (d.clone) return askClone(+d.clone);
  if (d.clonego) return cloneGuest(+d.clonego);
  if (d.maketemplate) return askTemplate(+d.maketemplate);
  if (d.templatego) {
    t.disabled = true;
    return makeTemplate(+d.templatego);
  }
  if (d.discupload) return askUpload();
  if (d.uploadgo) return startUpload();
  if (d.tmpladd) return askDownloadTemplate();
  if (d.tmplgo) return downloadTemplate();
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
  if (d.rolling) return openRunStart("update");
  if (d.runstart) {
    t.disabled = true;
    return startRun();
  }
  if (d.runagain) {
    const [, kind, server] = d.runagain.split(":");
    return openRunStart(kind, server);
  }
  if (d.runopen) return openRun();
  if (d.runclose) {
    S.runView = (S.runView ?? 0) + 1;
    return closeDialog();
  }
  if (d.runstop) {
    t.disabled = true;
    return post("api/action/run-stop", { server: onlineNodes()[0] })
      .then(async (res) => (res.ok ? null : Promise.reject(new Error((await res.json()).error))))
      .catch((err) => dialog(`<h3>It didn't stop</h3><p class="loginerr">${esc(err.message)}</p>${closeRow}`));
  }
  if (d.movestop) {
    t.disabled = true;
    return stopMoves(d.movestop).catch((err) => dialog(`<h3>The moves didn't stop</h3><p class="loginerr">${esc(err.message)}</p>${closeRow}`));
  }
  if (d.backup) {
    const server = d.backup;
    const ids = (S.restart?.guests ?? []).map((v) => v.id).join(",");
    const storage = $("#rstore").value;
    return confirmAction(`Back up ${S.restart.guests.length} on ${server}?`, `This saves a copy to ${storage}. They stay running, though they may feel slower while it runs.`, `Back up to ${storage}`, () => runAction("back-up-guests", server, `Backing up ${server}`, { guests: ids, storage }, () => openRunStart("restart", server)));
  }
  if (d.channel && d.channelserver) {
    const server = d.channelserver;
    const free = d.channel === "free";
    const line = free
      ? "Proxmox's free channel gets the same software as the paid one, sooner and with less testing. Proxmox suggests it for testing and non-production use, and a subscription for production. BossMox turns the paid sources off, without deleting them, and then checks for updates."
      : "This node has an active subscription, so it can use Proxmox's tested enterprise channel. BossMox turns the free sources off, without deleting them, and then checks for updates.";
    return confirmAction(`${CHANNEL_WORDS[d.channel]} on ${server}?`, line, CHANNEL_WORDS[d.channel], () => runAction("update-channel", server, `Switching ${server} to the ${d.channel} channel`, { channel: d.channel }));
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
});
document.addEventListener("input", (e) => {
  if (e.target.id === "setupconfirm") $("#setupgo").disabled = e.target.value.trim().toLowerCase() !== "erase";
  if (e.target.id === "pooldelconfirm") $("#pooldelgo").disabled = e.target.value.trim() !== S.poolDelete;
  if (e.target.id === "setupname" && S.setup) {
    S.setup.name = e.target.value.trim();
    S.setup.named = true;
  }
});
document.addEventListener("change", (e) => {
  if (e.target.dataset?.lokeep !== undefined) {
    S.leftoverKeep ??= new Set();
    if (e.target.checked) S.leftoverKeep.delete(e.target.dataset.lokeep);
    else S.leftoverKeep.add(e.target.dataset.lokeep);
    return drawLeftover();
  }
  if (e.target.id === "mflimit" || e.target.id === "mfspeed") {
    if (e.target.id === "mflimit") S.moveFix.limitOn = e.target.checked;
    else S.moveFix.speed = e.target.value;
    return drawMoveFix();
  }
  if (e.target.dataset?.setpick) {
    const id = e.target.dataset.setpick;
    S.setChoice[id] = e.target.value;
    // Already on: a new pick is a change of its own, so it asks too. Off: it's what the switch will use.
    if (S.recommended?.find((x) => x.id === id)?.on) askSetting(id, true, e.target.value);
    return;
  }
  if (e.target.id === "vmnode") {
    S.vmNode = e.target.value;
    return renderList();
  }
  if (e.target.dataset?.keepagain) {
    const again = e.target.dataset.keepagain;
    const keepFreePct = Number(e.target.value);
    const [, kind, server] = again.split(":");
    // Saved for the whole cluster, so it asks first (#55). Cancel goes back to the same plan, unchanged.
    const shown = S.runStart;
    S.afterTask = () => drawRunStart(shown.kind, shown.server, shown.plan, shown.reboot);
    return confirmAction(
      `Keep ${keepFreePct}% free on every node?`,
      `This is a cluster-wide setting, not just for this ${kind === "update" ? "update" : "restart"}. From now on BossMox keeps ${keepFreePct}% of each node's memory, storage and processor free when it moves guests, here and in Move off and Move back.`,
      "Save for every node",
      () => (async () => {
        const res = await post("api/action/preferences-set", { server: onlineNodes()[0], keepFreePct });
        if (!res.ok) return dialog(`<h3>That wasn't saved</h3><p class="loginerr">${esc((await res.json()).error)}</p>${closeRow}`);
        await refresh();
        openRunStart(kind, server);
      })().catch((err) => dialog(`<h3>That wasn't saved</h3><p class="loginerr">${esc(err.message || "BossMox lost contact with Proxmox.")}</p>${closeRow}`)),
    );
  }
  if (e.target.dataset?.bkwarn) {
    const line = e.target.closest("#dialog")?.querySelector(".warnline");
    if (line) line.textContent = backupWarning(e.target.dataset.bkwarn, e.target.value);
  }
  if (e.target.dataset?.setupdisk && S.setup) {
    if (e.target.checked) S.setup.devices.add(e.target.dataset.setupdisk);
    else S.setup.devices.delete(e.target.dataset.setupdisk);
  }
  if (e.target.closest?.("#setform")) settingsTouched();
  if (e.target.id === "stnode") {
    S.storeNode = e.target.value;
    drawStore();
    loadDisks(S.storeNode);
    loadStorageMap(S.storeNode);
  }
  if (e.target.id === "sharekind") $("#smbfields").hidden = e.target.value !== "smb";
  if (e.target.id === "mkkind" || e.target.closest?.("#mkdisks")) drawMakeChoices();
  if (e.target.id === "tlshow") {
    S.tlShow = e.target.value;
    drawTaskLog();
  }
  if (e.target.id === "ckind" || e.target.id === "cserver") loadCreate($("#cserver").value, $("#ckind").value);
});
document.addEventListener("input", (e) => {
  if (e.target.id === "rname") {
    $("#rgo").disabled = e.target.value.trim().toLowerCase() !== (e.target.dataset.word ?? "reboot");
  }
  if (e.target.closest?.("#setform")) settingsTouched();
  if (e.target.id === "tlq") {
    S.tlQ = e.target.value;
    drawTaskLog();
  }
  if (e.target.id === "vmq") {
    S.q = e.target.value;
    renderList();
  }
});

/* Look picker: remembered per browser */
const LOOKS = [["daylight", "Daylight"], ["dusk", "Dusk"], ["workbench", "Workbench"]];
function setLook(k) {
  if (!["daylight", "dusk", "workbench"].includes(k)) k = "daylight";
  document.documentElement.dataset.look = k;
  try { localStorage.setItem("bossmox-look", k); } catch { /* still works, just not remembered */ }
  $("#lookpick").value = k;
}
$("#looks").insertAdjacentHTML("beforeend", `<select id="lookpick" aria-label="Look">${LOOKS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>`);
$("#lookpick").addEventListener("change", (e) => setLook(e.target.value));

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
  S.details = {};
  S.nets = {};
  S.backups = null;
  S.backupsError = "";
  S.taskLog = null;
  S.storeList = null;
  S.diskData = {};
  S.waiting = {};
  S.scan = null;
  S.addresses = {};
  S.snapSupport = {};
  S.loadRun += 1;
  S.loadingAhead = false;
  S.loadedAhead = false;
  term?.socket?.close();
  term?.xterm?.dispose();
  term?.observer?.disconnect();
  term = null;
  S.taskRunning = false;
  S.watching = false;
  S.taskToken = (S.taskToken ?? 0) + 1;
  S.pending = S.afterTask = S.who = S.backups = S.snapSupport = null;
  $("#scrim").classList.remove("on");
  closeVnc();
  Object.keys(wins).forEach((k) => {
    wins[k].remove();
    delete wins[k];
  });
  renderTasks();
  challenge = null;
  $("#desk").hidden = true;
  $("#who").hidden = true;
  $("#version").hidden = true;
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
  // Sign-out bumps loadRun: an answer that arrives after it is dropped, so a slow refresh can't bring the desktop back
  // (#59). An answer is also dropped once a newer one has been shown, so an older answer can't replace it. Only a newer
  // answer that has arrived counts: when every read takes longer than the 10-second poll, each answer is still shown,
  // and a failure still raises "Showing old data" (#70).
  const gen = S.loadRun;
  S.refreshSeq = (S.refreshSeq ?? 0) + 1;
  const seq = S.refreshSeq;
  const late = () => gen !== S.loadRun || (S.shownSeq ?? 0) > seq;
  try {
    const res = await fetch("api/overview");
    const body = await res.json();
    if (late()) return;
    if (res.status === 401) {
      showLogin(S.data ? "You've been signed out. Sign in again to continue." : "");
      return;
    }
    if (!res.ok) throw new Error(body.error);
    S.shownSeq = seq;
    S.data = body;
    S.who = body.username;
    $("#who").textContent = body.username;
    $("#who").hidden = false;
    $("#version").textContent = body.version;
    $("#version").hidden = !body.version;
    $("#login").hidden = true;
    $("#desk").hidden = false;
    $("#signout").hidden = false;
    polling ??= setInterval(refresh, 10000);
    // A run going on the server shows on the desktop, in this browser or any other.
    const wasRunning = S.run?.running;
    const latest = (await signal("api/run").catch(() => ({ run: null }))).run;
    if (late()) return;
    S.run = latest;
    // Not over a window someone is using: it opens on the next refresh after that one closes (#57).
    if (S.run?.running && S.runView === undefined && !$("#scrim").classList.contains("on")) openRun();
    else if (wasRunning && !S.run?.running && S.runView === undefined) renderHealth();
    if (S.sel === null && body.vms[0]) S.sel = body.vms[0].id;
    S.failed = false;
  } catch (err) {
    if (late()) return;
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
  if (S.ticks++ % 3 === 0) loadAhead();
  drawStore();
}

const q = new URLSearchParams(location.search);
let saved = null;
try { saved = localStorage.getItem("bossmox-look"); } catch { /* use the default */ }
setLook(q.get("look") || saved || "daylight");
tick();
setInterval(tick, 20000);
refresh();
