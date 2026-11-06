"use strict";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const FINGERPRINT_HELP = "In Proxmox, open the node, then System, then Certificates, and look at pve-ssl.pem. Or run this on the node: openssl x509 -noout -fingerprint -sha256 -in /etc/pve/local/pve-ssl.pem";
const S = { busy: false, first: null, cluster: null };

async function post(route, body) {
  const res = await fetch(`setup/${route}`, { method: "POST", headers: { "Content-Type": "application/json", "X-BossMox": "1" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || "That step failed. Try again.");
  return out;
}
function screen(step, title, lead, html) {
  $("#step").textContent = step ? `Step ${step} of 5` : "";
  $("#title").textContent = title;
  $("#lead").textContent = lead;
  $("#problem").hidden = true;
  $("#body").innerHTML = html;
  $("#body input")?.focus();
}
function problem(text) {
  const p = $("#problem");
  p.textContent = text;
  p.hidden = false;
}
/** Runs a step, keeps its button from being pressed twice, and shows why it failed. */
async function run(button, label, work) {
  if (S.busy) return;
  S.busy = true;
  const was = button.textContent;
  button.disabled = true;
  button.textContent = label;
  $("#problem").hidden = true;
  try {
    await work();
  } catch (err) {
    problem(err.message || "BossMox lost contact. Try again.");
    button.disabled = false;
    button.textContent = was;
  }
  S.busy = false;
}
const field = (label, input) => `<label class="field"><span>${label}</span>${input}</label>`;
const textInput = (id, extra = "") => `<input id="${id}" autocomplete="off" autocapitalize="none" spellcheck="false" ${extra}>`;
const buttons = (...b) => `<div class="setuprow">${b.join("")}</div>`;

function codeScreen() {
  screen(1, "Enter the setup code", "It's on this VM's console, which proves you control it. Open the VM's console in Proxmox to see it.",
    `${field("Setup code", textInput("code", 'maxlength="20"'))}${buttons(`<button class="btn primary" data-do="code">Continue</button>`)}`);
}
function addressScreen() {
  screen(2, "Connect to Proxmox", "Enter the address of any one of your Proxmox nodes. If you have several, you can add the others next.",
    `${field("Node address", textInput("address", 'placeholder="192.168.1.10"'))}${buttons(`<button class="btn primary" data-do="look">Continue</button>`)}`);
}
function fingerprintBlock(fp) {
  return `<code class="fingerprint">${esc(fp)}</code><p class="meta">${esc(FINGERPRINT_HELP)}</p>`;
}
function matchScreen() {
  screen(2, "Is this your node?", `This is the certificate fingerprint ${S.first.address} just showed. Compare it with the one on the node, so your password can't go to the wrong machine.`,
    `${fingerprintBlock(S.first.fingerprint)}${buttons(`<button class="btn" data-do="again">Back</button>`, `<button class="btn primary" data-do="match">It matches</button>`)}`);
}
function signInScreen() {
  screen(3, "Sign in to Proxmox", "To build a cluster, sign in as root. BossMox uses this password only during setup and doesn't save it.",
    `<div class="setuppair">${field("Username", textInput("user", 'value="root"'))}${field("Sign-in type", `<select id="realm"><option value="pam">Linux (PAM)</option><option value="pve">Proxmox</option></select>`)}</div>
     ${field("Password", `<input id="password" type="password" autocomplete="off">`)}${buttons(`<button class="btn primary" data-do="signin">Sign in</button>`)}`);
}
const nodeRows = () => `<div class="restartlist">${S.cluster.nodes.map((n) => `<div class="snap"><div>${esc(n.name)}<small>${esc(n.address)}</small></div><span class="state"><span class="dot ${n.online ? "running" : "warn"}"></span>${n.online ? "Online" : "Offline"}</span></div>`).join("")}</div>`;
function clusterScreen() {
  const c = S.cluster;
  if (c.clusterName) {
    screen(4, `Cluster ${c.clusterName}`, `${c.nodes.length} ${c.nodes.length === 1 ? "node" : "nodes"} so far. To add another, enter its address. Add three or more if you can, so the cluster keeps running while one restarts.`,
      `${nodeRows()}${c.canBuild ? `${field("Another node's address", textInput("address", 'placeholder="192.168.1.11"'))}` : `<p class="meta">Sign in as root to add nodes.</p>`}
       ${buttons(c.canBuild ? `<button class="btn" data-do="lookjoin">Add this node</button>` : "", `<button class="btn primary" data-do="done">Finish adding</button>`)}`);
    return;
  }
  screen(4, "Build a cluster", "This node isn't in a cluster yet. A cluster lets nodes share guests and keep them running through a restart. You can also stay on one node.",
    `${nodeRows()}${c.canBuild ? field("Cluster name", textInput("name", 'maxlength="15" placeholder="home-lab"')) : `<p class="meta">Sign in as root to build a cluster.</p>`}
     ${buttons(`<button class="btn" data-do="done">Stay on one node</button>`, c.canBuild ? `<button class="btn primary" data-do="create">Create cluster</button>` : "")}`);
}
function joinScreen(joiner) {
  S.joiner = joiner;
  screen(4, `Add ${joiner.address}?`, "Compare this fingerprint with the one on that node, then enter its root password. The node has to be empty, and it restarts its Proxmox services as it joins. This can take a couple of minutes.",
    `${fingerprintBlock(joiner.fingerprint)}${field("Root password for that node", `<input id="password" type="password" autocomplete="off">`)}
     ${buttons(`<button class="btn" data-do="backcluster">Back</button>`, `<button class="btn primary" data-do="join">It matches, add it</button>`)}`);
}
function finishScreen() {
  screen(5, "Ready to finish", `BossMox will manage ${S.cluster.clusterName || "this node"} and answer at ${location.host}. Setup then locks, and you sign in with your Proxmox account as normal.`,
    `${nodeRows()}${buttons(`<button class="btn" data-do="backcluster">Back</button>`, `<button class="btn primary" data-do="finish">Finish setup</button>`)}`);
}
async function waitForBossMox() {
  screen(0, "Finishing", "BossMox is restarting with your settings. This page moves on by itself.", "");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const up = await fetch("healthz").then((r) => r.json()).catch(() => null);
    if (up && !up.setup) {
      location.href = "/";
      return;
    }
  }
  problem("BossMox hasn't come back yet. Check the VM's console.");
}

const ACTIONS = {
  code: (b) => run(b, "Checking", async () => {
    await post("code", { code: $("#code").value });
    addressScreen();
  }),
  look: (b) => run(b, "Connecting", async () => {
    S.first = await post("look", { address: $("#address").value });
    matchScreen();
  }),
  again: () => addressScreen(),
  match: () => signInScreen(),
  signin: (b) => run(b, "Signing in", async () => {
    S.cluster = await post("signin", { ...S.first, user: $("#user").value.trim(), realm: $("#realm").value, password: $("#password").value });
    clusterScreen();
  }),
  create: (b) => run(b, "Creating", async () => {
    S.cluster = await post("create", { name: $("#name").value.trim() });
    clusterScreen();
  }),
  lookjoin: (b) => run(b, "Connecting", async () => joinScreen(await post("look", { address: $("#address").value }))),
  join: (b) => run(b, "Joining, this takes a minute or two", async () => {
    S.cluster = await post("add", { ...S.joiner, password: $("#password").value });
    S.joiner = null;
    clusterScreen();
  }),
  backcluster: () => clusterScreen(),
  done: () => finishScreen(),
  finish: (b) => run(b, "Finishing", async () => {
    await post("finish", {});
    await waitForBossMox();
  }),
};
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-do]");
  if (b) ACTIONS[b.dataset.do](b);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target.tagName !== "INPUT") return;
  $("#body .btn.primary, #body [data-do='lookjoin']")?.click();
});
codeScreen();
