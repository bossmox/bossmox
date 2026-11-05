// A stand-in for Proxmox with invented data, for screens and demos.
import http from "node:http";

const G = 1024 ** 3;
const q = (vmid, name, node, status, maxcpu, mem, disk, cpu) => ({
  type: "qemu", vmid, name, node, status, maxcpu, maxmem: mem * G,
  mem: status === "running" ? mem * G * 0.6 : 0, maxdisk: disk * G, cpu,
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

http.createServer((req, res) => {
  const p = req.url.replace("/api2/json", "");
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
}).listen(8079, "127.0.0.1", () => console.log("Mock Proxmox on http://127.0.0.1:8079"));
