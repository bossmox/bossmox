// A stand-in for Proxmox with invented data, for screens and demos.
import http from "node:http";

const G = 1024 ** 3;
const q = (vmid, name, node, status, maxcpu, mem, disk, cpu) => ({
  type: "qemu",
  vmid,
  name,
  node,
  status,
  maxcpu,
  maxmem: mem * G,
  mem: status === "running" ? mem * G * 0.6 : 0,
  maxdisk: disk * G,
  cpu,
});
const resources = [
  { type: "node", node: "server1", status: "online", cpu: 0.31, maxcpu: 24, mem: 54 * G, maxmem: 100 * G },
  { type: "node", node: "server2", status: "online", cpu: 0.44, maxcpu: 24, mem: 61 * G, maxmem: 100 * G },
  q(101, "domain-controller", "server1", "running", 4, 12, 120, 0.12),
  q(103, "accounting", "server2", "running", 8, 32, 500, 0.63),
  q(108, "test-bench", "server2", "stopped", 2, 4, 60, 0),
  { type: "storage", storage: "fast-pool", node: "server1", shared: 1, status: "available", disk: 2000 * G, maxdisk: 6000 * G },
];
const configs = {
  101: { ostype: "win11", onboot: 1, machine: "q35", bios: "ovmf", scsihw: "virtio-scsi-single", scsi0: "x,size=120G", net0: "virtio=AA,bridge=vmbr0" },
  103: { ostype: "win10", onboot: 1, scsihw: "pvscsi", scsi0: "x,size=500G", net0: "vmxnet3=AA,bridge=vmbr0" },
  108: { ostype: "l26", scsihw: "virtio-scsi-single", scsi0: "x,size=60G", net0: "virtio=AA,bridge=vmbr0" },
};

let restartedAt = 0;
const reply = (res, data, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data }));
};

// Sign in as demo / demo with any realm. demo2 / demo also asks for the code 123456.
http
  .createServer((req, res) => {
    const p = req.url.replace("/api2/json", "");
    if (p === "/access/domains")
      return reply(res, [
        { realm: "pam", comment: "Linux PAM" },
        { realm: "pve", comment: "Proxmox VE", default: 1 },
      ]);
    if (req.method === "POST" && p === "/access/ticket") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const f = new URLSearchParams(body);
        const user = f.get("username") ?? "";
        if (f.get("tfa-challenge")) {
          if (f.get("password") === "totp:123456") reply(res, { username: user, ticket: "MOCKTICKET", CSRFPreventionToken: "MOCKCSRF" });
          else reply(res, null, 401);
          return;
        }
        if (user.startsWith("demo2@") && f.get("password") === "demo") {
          reply(res, { username: user, ticket: "MOCKCHALLENGE", NeedTFA: 1 });
          return;
        }
        const good = user.startsWith("demo@") && ["demo", "MOCKTICKET"].includes(f.get("password"));
        if (good) reply(res, { username: user, ticket: "MOCKTICKET", CSRFPreventionToken: "MOCKCSRF" });
        else reply(res, null, 401);
      });
      return;
    }
    if (!req.headers.cookie?.includes("PVEAuthCookie=MOCKTICKET")) return reply(res, null, 401);
    if (req.method === "POST" && p.endsWith("/apt/update")) {
      if (!req.headers.csrfpreventiontoken) return reply(res, null, 403);
      req.resume();
      return reply(res, "UPID:server1:0000AAAA:0000BBBB:0000CCCC:aptupdate::demo@pve:");
    }
    if (p.includes("/tasks/UPID")) {
      if (p.includes("/log"))
        return reply(res, [
          { n: 1, t: "Reading package lists" },
          { n: 2, t: "TASK OK" },
        ]);
      return reply(res, { status: "stopped", exitstatus: "OK" });
    }
    if (req.method === "POST" && p.endsWith("/status")) {
      req.resume();
      restartedAt = Date.now();
      return reply(res, null);
    }
    if (p.includes("/tasks?source=active")) return reply(res, []);
    if (p.includes("/storage?content=backup")) return reply(res, [{ storage: "backups", avail: 900 * G, active: 1, enabled: 1 }]);
    const n = p.match(/^\/nodes\/([\w-]+)\/(status|apt\/update|apt\/repositories|subscription|services|tasks)/);
    if (n) {
      const replies = {
        status: {
          uptime: restartedAt ? Math.floor((Date.now() - restartedAt) / 1000) : 793600,
          pveversion: "pve-manager/9.2.2/demo",
          "current-kernel": { release: "7.0.2-6-pve" },
          cpuinfo: { model: "Intel Xeon Silver 4110", cpus: 32 },
          memory: { used: 54 * G, total: 100 * G },
          rootfs: { used: 12 * G, total: 96 * G },
        },
        "apt/update": [
          { Package: "proxmox-kernel-7.0", Title: "Latest Proxmox kernel", OldVersion: "7.0.2-6", Version: "7.0.14-28", Origin: "Proxmox" },
          { Package: "pve-manager", Title: "The Proxmox web interface and API", OldVersion: "9.2.2", Version: "9.2.26", Origin: "Proxmox" },
          { Package: "curl", Title: "Command line tool for transferring data", OldVersion: "8.14.1-2", Version: "8.14.1-2+deb13u2", Origin: "Debian" },
        ],
        "apt/repositories": { files: [{ repositories: [{ Enabled: true, URIs: ["http://download.proxmox.com/debian/pve"], Components: ["pve-no-subscription"] }] }] },
        subscription: { status: "notfound" },
        services: [
          { service: "pveproxy", desc: "PVE API Proxy Server", state: "running", "unit-state": "enabled" },
          { service: "postfix", desc: "Postfix Mail Transport Agent", state: "dead", "unit-state": "enabled" },
        ],
        tasks: [
          { upid: "a", type: "vzdump", id: "103", user: "root@pam", status: "OK", starttime: 1762380000, endtime: 1762380060 },
          { upid: "b", type: "aptupdate", user: "root@pam", status: "unable to fetch", starttime: 1762370000, endtime: 1762370060 },
        ],
      };
      return reply(res, replies[n[2]]);
    }
    const m = p.match(/qemu\/(\d+)\/(config|snapshot)$/);
    let data;
    if (p === "/cluster/resources") data = resources;
    else if (p === "/cluster/backup-info/not-backed-up") data = [{ vmid: 108 }];
    else if (m && m[2] === "config") data = configs[m[1]];
    else if (m) data = [{ name: "current" }];
    if (data === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data }));
  })
  .listen(8079, "127.0.0.1", () => console.log("Mock Proxmox on http://127.0.0.1:8079"));
