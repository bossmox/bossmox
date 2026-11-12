import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import type { Peer, Pinned } from "./pinned.js";
import { parseAddress, PinError, PveReply } from "./pinned.js";
import { applyChannel, ChannelError, type ChannelIO } from "./update-channel.js";
import { plainError } from "./plain-errors.js";
import type { Saved } from "./settings.js";
import { checkNetworks, migrationNetwork, type NetCheck } from "./cluster-net.js";

const MAX_CODE_TRIES = 10;
const MAX_CODE_TRIES_ALL = 200;
const CODE_WINDOW_MS = 5 * 60 * 1000;
const TOKEN_MS = 60 * 60 * 1000;
const JOIN_WAIT_MS = 4 * 60 * 1000;
const VERIFY_WAIT_MS = 60 * 1000;
const CLUSTER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,14}$/;

export class WizardError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Everything the wizard needs from the outside world, so its logic can be tested with no network. */
export interface Outside {
  probe(host: string, port: number): Promise<Peer>;
  call<T>(to: Pinned, method: "GET" | "POST" | "PUT", path: string, opts?: { ticket?: string; csrf?: string; form?: Record<string, string> }): Promise<T>;
  /** Whether a node's certificate verifies against the certificate authority, and matches `name` or else the address. */
  verifies(host: string, port: number, ca: string, name?: string): Promise<boolean>;
  saveCa(pem: string): string;
  saveSettings(values: Saved): void;
  wait(ms: number): Promise<void>;
  now(): number;
}

interface Login {
  username: string;
  ticket: string;
  CSRFPreventionToken?: string;
  NeedTFA?: number;
}
interface ClusterEntry {
  type?: string;
  name?: string;
  ip?: string;
  online?: number;
  nodes?: number;
  quorate?: number;
}
export interface NodeView {
  name: string;
  address: string;
  online: boolean;
}

const hashCode = (code: string) => createHash("sha256").update(code.toUpperCase().replace(/[^0-9A-Z]/g, "")).digest();

/** Holds a setup in progress. Passwords live here only until it finishes, and never reach a file or a log. */
export class Wizard {
  private tries = 0;
  private readonly triesBy = new Map<string, number>();
  private triesFrom = 0;
  private token = "";
  private tokenUntil = 0;
  private first: Pinned | undefined;
  private ticket = "";
  private csrf = "";
  private user = "";
  private password = "";
  private nodeName = "";
  private clusterName = "";
  private nodes: NodeView[] = [];
  /** The address Proxmox gives for this node, when it isn't the one we reached it on. */
  private otherAddress = "";
  finished = false;

  constructor(private readonly hashFile: string, private readonly out: Outside) {}

  /**
   * Wrong codes are counted per address (security review 2026-11-09, L1), so one machine sending junk can't lock
   * the real admin out. A high ceiling for everyone together still stops a spread-out guessing run.
   */
  enterCode(code: string, from = ""): string {
    const t = this.out.now();
    if (t - this.triesFrom > CODE_WINDOW_MS) {
      this.tries = 0;
      this.triesFrom = t;
      this.triesBy.clear();
    }
    const mine = this.triesBy.get(from) ?? 0;
    if (mine >= MAX_CODE_TRIES || this.tries >= MAX_CODE_TRIES_ALL) throw new WizardError(429, "Too many wrong codes. Wait 5 minutes and try again.");
    this.tries += 1;
    this.triesBy.set(from, mine + 1);
    if (!existsSync(this.hashFile)) throw new WizardError(400, "No setup code exists on this machine. On the Proxmox node, run qm guest exec followed by this VM's ID and -- bossmox-reset to make one.");
    const want = Buffer.from(readFileSync(this.hashFile, "utf8").trim(), "hex");
    const got = hashCode(code);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new WizardError(401, "That code didn't match. Check the VM's console and try again.");
    this.triesBy.delete(from);
    this.token = randomBytes(32).toString("base64url");
    this.tokenUntil = t + TOKEN_MS;
    return this.token;
  }

  allowed(token: string | undefined): boolean {
    this.forgetIfExpired();
    if (!token || !this.token || this.out.now() > this.tokenUntil) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async look(address: string) {
    const target = parseAddress(address);
    if (!target) throw new WizardError(400, "That doesn't look like an address. Use something like 192.168.1.10.");
    try {
      const peer = await this.out.probe(target.host, target.port);
      return { address: `${target.host}:${target.port}`, fingerprint: peer.fingerprint };
    } catch {
      throw new WizardError(400, `Nothing answered on ${target.host}:${target.port}. Check the address, and that Proxmox is running there.`);
    }
  }

  private pin(address: string, fingerprint: string): Pinned {
    const target = parseAddress(address);
    if (!target || !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)) throw new WizardError(400, "That request isn't valid.");
    return { ...target, fingerprint };
  }

  private async login(to: Pinned, username: string, password: string): Promise<Login> {
    try {
      return await this.out.call<Login>(to, "POST", "/access/ticket", { form: { username, password } });
    } catch (err) {
      if (err instanceof PinError) throw new WizardError(400, err.message);
      if (err instanceof PveReply && (err.status === 401 || err.status === 403)) throw new WizardError(401, "Wrong username or password.");
      throw new WizardError(502, `Proxmox couldn't be reached. ${(err as Error).message}`);
    }
  }

  async signIn(address: string, fingerprint: string, user: string, realm: string, password: string) {
    if (!/^[\w.@+-]{1,64}$/.test(user) || !/^[\w.-]{1,32}$/.test(realm) || !password) throw new WizardError(400, "Enter a username and password.");
    const to = this.pin(address, fingerprint);
    const login = await this.login(to, `${user}@${realm}`, password);
    if (login.NeedTFA) throw new WizardError(400, "This account uses a one-time code, which setup can't accept yet. Use root for setup.");
    this.first = to;
    this.ticket = login.ticket;
    this.csrf = login.CSRFPreventionToken ?? "";
    this.user = login.username;
    this.password = password;
    // On a cluster /nodes lists every node, so the one that answered is the cluster's "local" entry.
    const status = await this.out.call<{ type?: string; name?: string; local?: number }[]>(to, "GET", "/cluster/status", this.auth()).catch(() => []);
    const local = status.find((e) => e.type === "node" && e.local === 1)?.name;
    const nodes = local ? [] : await this.out.call<{ node: string }[]>(to, "GET", "/nodes", this.auth());
    this.nodeName = local ?? nodes[0]?.node ?? "";
    return this.state();
  }

  /** An hour after the code, a setup left open drops the root password and ticket (security review L5). */
  forgetIfExpired() {
    if (!this.token || this.out.now() <= this.tokenUntil) return;
    this.token = "";
    this.password = "";
    this.ticket = "";
    this.csrf = "";
  }

  private auth() {
    return { ticket: this.ticket, csrf: this.csrf };
  }

  private need(): Pinned {
    if (!this.first) throw new WizardError(400, "Sign in first.");
    return this.first;
  }

  private async refresh() {
    const entries = await this.out.call<ClusterEntry[]>(this.need(), "GET", "/cluster/status", this.auth());
    const cluster = entries.find((e) => e.type === "cluster");
    this.clusterName = cluster?.name ?? "";
    const nodes = entries.filter((e) => e.type === "node");
    // Proxmox reports whatever /etc/hosts says, which goes stale when a node moves. The address we reached it on is proven.
    const reached = this.need().host;
    const reported = nodes.find((n) => n.name === this.nodeName)?.ip ?? "";
    // Only two addresses can be compared. A name the person typed says nothing about the address behind it.
    this.otherAddress = reported && reported !== reached && isIP(reached) ? reported : "";
    this.nodes = nodes.map((n) => ({ name: n.name ?? "", address: n.name === this.nodeName ? reached : n.ip ?? "", online: n.online === 1 }));
  }

  async state() {
    await this.refresh();
    return { user: this.user, clusterName: this.clusterName, nodes: this.nodes, canBuild: this.user === "root@pam", otherAddress: this.otherAddress };
  }

  private requireRoot() {
    if (this.user !== "root@pam") throw new WizardError(403, "Proxmox only lets root@pam build a cluster. Sign in as root to do this.");
  }

  async createCluster(name: string) {
    this.requireRoot();
    if (!CLUSTER_NAME.test(name)) throw new WizardError(400, "A cluster name is 1 to 15 letters, numbers or dashes, starting with a letter or number.");
    await this.refresh();
    if (this.clusterName) throw new WizardError(400, `This node is already in the cluster ${this.clusterName}.`);
    const to = this.need();
    const task = await this.out.call<string>(to, "POST", "/cluster/config", { ...this.auth(), form: { clustername: name } });
    await this.follow(to, task);
    await this.settle((s) => s.clusterName === name);
    return this.state();
  }

  private async follow(to: Pinned, task: string, node = this.nodeName) {
    const until = this.out.now() + JOIN_WAIT_MS;
    const path = `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(task)}/status`;
    while (this.out.now() < until) {
      await this.out.wait(1500);
      // Proxmox restarts its services during this, so a failed check doesn't mean anything yet.
      const status = await this.out.call<{ status?: string; exitstatus?: string }>(to, "GET", path, this.auth()).catch(() => null);
      if (status?.status === "stopped") {
        if (status.exitstatus !== "OK") throw new WizardError(502, `Proxmox couldn't do that: ${status.exitstatus}`);
        return;
      }
    }
    throw new WizardError(504, "Proxmox is taking too long. Check the node, then try again.");
  }

  private async settle(done: (s: { clusterName: string; nodes: NodeView[] }) => boolean) {
    const until = this.out.now() + JOIN_WAIT_MS;
    while (this.out.now() < until) {
      const ok = await this.refresh().then(() => done({ clusterName: this.clusterName, nodes: this.nodes })).catch(() => false);
      if (ok) return;
      await this.out.wait(3000);
    }
    throw new WizardError(504, "Proxmox is taking too long. Check the cluster, then try again.");
  }

  async addNode(address: string, fingerprint: string, password: string) {
    this.requireRoot();
    if (!password) throw new WizardError(400, "Enter that node's root password.");
    const to = this.pin(address, fingerprint);
    const first = this.need();
    if (to.host === first.host) throw new WizardError(400, "That's the node you're already connected to.");
    await this.refresh();
    if (!this.clusterName) throw new WizardError(400, "Create the cluster first.");

    const login = await this.login(to, "root@pam", password);
    const auth = { ticket: login.ticket, csrf: login.CSRFPreventionToken ?? "" };
    const [{ node } = { node: "" }] = await this.out.call<{ node: string }[]>(to, "GET", "/nodes", auth);
    if (this.nodes.some((n) => n.name === node)) throw new WizardError(400, `A node called ${node} is already in this cluster. Each node needs its own name.`);
    const status = await this.out.call<ClusterEntry[]>(to, "GET", "/cluster/status", auth);
    const other = status.find((e) => e.type === "cluster");
    if (other) throw new WizardError(400, `${node} is already in the cluster ${other.name}. Remove it from there first.`);
    const base = `/nodes/${encodeURIComponent(node)}`;
    const [vms, cts] = await Promise.all([this.out.call<unknown[]>(to, "GET", `${base}/qemu`, auth), this.out.call<unknown[]>(to, "GET", `${base}/lxc`, auth)]);
    if (vms.length + cts.length > 0) throw new WizardError(400, `${node} has ${vms.length + cts.length} guests on it. A node has to be empty to join a cluster. Move or remove them first.`);

    try {
      await this.out.call<string>(to, "POST", "/cluster/config/join", {
        ...auth,
        form: { hostname: first.host.replace(/^\[|\]$/g, ""), password: this.password, fingerprint: first.fingerprint },
      });
    } catch (err) {
      if (!(err instanceof PveReply)) throw err;
      throw new WizardError(502, `${node} couldn't join: ${err.reason}`);
    }
    await this.settle((s) => s.nodes.some((n) => n.name === node && n.online));
    return this.state();
  }

  /**
   * The networks the cluster's nodes share, and whether moves run on the heartbeat's only one (ADR 0028). The
   * screen asks which network moves should use only when there's a real choice.
   */
  async networks(): Promise<NetCheck & { current: string | null }> {
    await this.refresh();
    const to = this.need();
    const none = { ...checkNetworks([], null), current: null };
    if (!this.clusterName || this.nodes.length < 2) return none;
    const get = <T>(p: string) => this.out.call<T>(to, "GET", p, this.auth());
    const [config, options] = await Promise.all([get<Record<string, unknown>[]>("/cluster/config/nodes"), get<{ migration?: string | { network?: string } }>("/cluster/options")]);
    const nodes = await Promise.all(config.map(async (c) => {
      const name = String(c.node ?? c.name ?? "");
      const links = Object.keys(c).filter((k) => /^ring\d+_addr$/.test(k)).sort().map((k) => String(c[k]));
      const ifaces = await get<{ cidr?: string }[]>(`/nodes/${encodeURIComponent(name)}/network`);
      return { name, links, addresses: ifaces.flatMap((i) => (i.cidr ? [i.cidr] : [])) };
    }));
    const current = migrationNetwork(options.migration);
    return { ...checkNetworks(nodes, current), current };
  }

  /** Points VM moves at one of the networks every node shares. Keeps the encrypted (secure) move type as it was. */
  async setMoveNetwork(net: string) {
    this.requireRoot();
    const check = await this.networks();
    if (!check.known || !check.others.includes(net)) throw new WizardError(400, "Pick one of the networks shown.");
    const to = this.need();
    const options = await this.out.call<{ migration?: string | { type?: string } }>(to, "GET", "/cluster/options", this.auth());
    const m = options.migration;
    const type = (typeof m === "string" ? /(?:^|,)(?:type=)?(secure|insecure)(?:,|$)/.exec(m)?.[1] : m?.type) ?? "secure";
    await this.out.call<null>(to, "PUT", "/cluster/options", { ...this.auth(), form: { migration: `type=${type},network=${net}` } });
    return this.networks();
  }

  /**
   * Puts every node on the chosen update channel (ADR 0013). The screen picks free unless the person says they
   * have a subscription. Problems on one node don't stop the others; they come back as plain sentences.
   */
  async setChannel(target: string) {
    if (target !== "free" && target !== "enterprise") throw new WizardError(400, "Pick one of the choices.");
    await this.refresh();
    const to = this.need();
    const io: ChannelIO = {
      get: (p) => this.out.call(to, "GET", p, this.auth()),
      put: (p, form) => this.out.call(to, "PUT", p, { ...this.auth(), form }),
      post: (p, form) => this.out.call(to, "POST", p, { ...this.auth(), form }),
    };
    const online = this.nodes.filter((n) => n.online);
    if (target === "enterprise") {
      // Check every node first, so a missing subscription doesn't leave the cluster half switched.
      const without: string[] = [];
      for (const n of online) {
        const sub = await io.get<{ status?: string }>(`/nodes/${encodeURIComponent(n.name)}/subscription`);
        if (sub.status?.toLowerCase() !== "active") without.push(n.name);
      }
      if (without.length) throw new WizardError(400, `${without.join(", ")} ${without.length === 1 ? "doesn't" : "don't"} have an active subscription. Add the key on the node's Subscription page in Proxmox, or use the free channel.`);
    }
    const problems = this.nodes.filter((n) => !n.online).map((n) => `${n.name} is offline, so it wasn't changed.`);
    for (const n of online) {
      try {
        await this.follow(to, await applyChannel(io, n.name, target), n.name);
      } catch (err) {
        if (err instanceof ChannelError) problems.push(err.message);
        else if (err instanceof PveReply) problems.push(`${n.name}: ${plainError(err.reason)}`);
        else if (err instanceof WizardError) problems.push(`${n.name} switched, but its check for updates didn't finish cleanly. Look at its Updates in BossMox after setup.`);
        else throw err;
      }
    }
    return { ...(await this.state()), channelProblems: problems };
  }

  /** Trust comes last: each standalone node has its own certificate authority until it joins. */
  async finish(publicHost: string) {
    await this.refresh();
    const first = this.need();
    const info = await this.out.call<{ filename?: string; pem?: string }[]>(first, "GET", `/nodes/${encodeURIComponent(this.nodeName)}/certificates/info`, this.auth());
    const ca = info.find((c) => c.filename === "pve-root-ca.pem")?.pem;
    const hosts = this.nodes.filter((n) => n.address).map((n) => n.address);
    if (!hosts.length) hosts.push(first.host);
    const failed: string[] = [];
    // A node that moved keeps its old address on its certificate, but its name still matches. One PVE_TLS_NAME
    // can only describe one node, so this is for a single node. A cluster's addresses have to match.
    const nodeName = hosts.length === 1 ? this.nodeName : "";
    let tlsName = "";
    const check = async (h: string, authority: string) => {
      if (await this.out.verifies(h, first.port, authority)) return true;
      if (!nodeName || !(await this.out.verifies(h, first.port, authority, nodeName))) return false;
      tlsName = nodeName;
      return true;
    };
    // A node that only just joined can take a few seconds to start using its new certificate.
    const until = this.out.now() + VERIFY_WAIT_MS;
    if (ca) {
      for (const h of hosts) {
        let good = await check(h, ca);
        while (!good && this.out.now() < until) {
          await this.out.wait(3000);
          good = await check(h, ca);
        }
        if (!good) failed.push(h);
      }
    }
    if (!ca) throw new WizardError(502, "BossMox couldn't read this cluster's certificate authority.");
    if (failed.length) throw new WizardError(502, `BossMox couldn't verify ${failed.join(", ")}, the address Proxmox gives for that node. If it's out of date, correct it in /etc/hosts on that node, then run pvecm updatecerts --force there.`);
    this.out.saveSettings({
      PVE_URL: hosts.map((h) => `https://${h}:${first.port}`).join(","),
      PVE_CA_FILE: this.out.saveCa(ca),
      ...(tlsName ? { PVE_TLS_NAME: tlsName } : {}),
      BOSSMOX_ALLOWED_HOSTS: publicHost,
    });
    this.finished = true;
    this.password = "";
    this.ticket = "";
    this.csrf = "";
    rmSync(this.hashFile, { force: true });
    rmSync(this.hashFile.replace(/\.hash$/, ".code"), { force: true });
  }
}

/**
 * During setup BossMox is reached by its address, as the installer prints it. A name with dots in it would be some
 * other site's DNS pointing here, the DNS-rebinding trick (security review L1), so it's refused.
 */
export function setupHostAllowed(host = ""): boolean {
  const name = host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  return isIP(name) !== 0 || /^[A-Za-z0-9-]{1,63}$/.test(name);
}
