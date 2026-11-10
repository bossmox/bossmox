/**
 * Runs one command in a node's root console from the BossMox server and reads how it ended (ADR 0027). Used to
 * install updates without a person at the page. The console is Proxmox's own termproxy, the same one the Shell
 * window uses, so it runs with the person's own rights: a root@pam login gets a root shell, others get a login
 * prompt, which is refused here before anything is typed.
 */
import tls from "node:tls";
import { WebSocket } from "ws";
import type { TermProxy } from "./terminal.js";

/** Printed after the command with its exit code. Typed as `$?`, so the echoed command line never matches. */
const DONE = /__BOSSMOX_DONE__:(\d+)/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]|\r/g;

export const plainText = (raw: string) => raw.replace(ANSI, "");

/** The exit code once the command has finished, or null while it hasn't. */
export function finished(output: string): number | null {
  const m = DONE.exec(plainText(output));
  return m ? Number(m[1]) : null;
}

/** A login prompt instead of a shell: this account doesn't get a root console from Proxmox. */
export const askedToLogIn = (output: string) => /(^|\n)[\w.-]+ login: ?$/.test(plainText(output).trimEnd() + " ");

/** Config files dpkg kept the old version of, because they were changed locally. The new one sits beside it. */
export function keptConfigFiles(output: string): string[] {
  const out = new Set<string>();
  for (const m of plainText(output).matchAll(/Configuration file '([^']+)'/g)) out.add(m[1] as string);
  return [...out];
}

/** Installs a node's updates with nobody answering: existing config files stay, and the exit code is printed. */
export const INSTALL_COMMAND =
  "export DEBIAN_FRONTEND=noninteractive; apt-get update -q >/dev/null 2>&1; " +
  "apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade; " +
  "echo __BOSSMOX_DONE__:$?\n";

export interface ShellConfig {
  readonly pveUrl: URL;
  readonly pveCa?: string | Buffer | undefined;
  readonly pveTlsName?: string | undefined;
}
export interface ShellResult {
  exitCode: number;
  /** The last part of what it printed, without colours. */
  tail: string;
  keptConfig: string[];
}

const KEEP = 64 * 1024;

/** Opens the node's console, types the command, and waits for it to finish. Rejects with a plain reason. */
export function runOnNode(config: ShellConfig, node: string, ticket: string, proxy: TermProxy, command: string, timeoutMs = 45 * 60 * 1000): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api2/json/nodes/${encodeURIComponent(node)}/vncwebsocket`, config.pveUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("port", String(proxy.port));
    url.searchParams.set("vncticket", proxy.ticket);
    const name = config.pveTlsName;
    const ws = new WebSocket(url, "binary", {
      handshakeTimeout: 10_000,
      headers: { Cookie: `PVEAuthCookie=${encodeURIComponent(ticket)}` },
      ...(config.pveCa ? { ca: config.pveCa } : {}),
      ...(name ? { checkServerIdentity: (_h: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(name, cert) } : {}),
    });
    let output = "";
    let typed = false;
    let settled = false;
    const send = (text: string) => ws.send(`0:${Buffer.byteLength(text)}:${text}`);
    const end = (err: Error | null, result?: ShellResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(typeAfter);
      try {
        if (ws.readyState === WebSocket.OPEN) send("exit\n");
      } catch { /* closing anyway */ }
      ws.close();
      if (err) reject(err);
      else resolve(result as ShellResult);
    };
    const timer = setTimeout(() => end(new Error(`The install on ${node} didn't finish within ${Math.round(timeoutMs / 60000)} minutes. It may still be running there.`)), timeoutMs);
    // The shell needs a moment after the login line; a login prompt in that time means no root shell.
    let typeAfter: NodeJS.Timeout | undefined;
    const typeCommand = () => {
      if (settled || typed) return;
      if (askedToLogIn(output)) return end(new Error(`Your Proxmox account doesn't get a root console on ${node}, so BossMox can't install there. Sign in as root@pam to run updates.`));
      typed = true;
      send(command);
    };
    ws.on("open", () => ws.send(`${proxy.user}:${proxy.ticket}\n`));
    ws.on("message", (data) => {
      const text = data.toString();
      output = (output + text).slice(-KEEP);
      if (!typed) {
        clearTimeout(typeAfter);
        typeAfter = setTimeout(typeCommand, 1500);
        return;
      }
      const code = finished(output);
      if (code !== null) end(null, { exitCode: code, tail: plainText(output).slice(-4000), keptConfig: keptConfigFiles(output) });
    });
    ws.on("error", (err) => end(new Error(`BossMox lost the console on ${node}: ${err.message}`)));
    ws.on("close", () => end(new Error(`The console on ${node} closed before the install finished.`)));
  });
}
