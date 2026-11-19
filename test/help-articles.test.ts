import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { UPGRADE_HELP } from "../src/upgrade-check.js";

/** The Help articles (ADR 0044), read from the repo the same way the release carries them. */
const DIR = new URL("../../docs/help/", import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
const read = (key: string) => readFileSync(new URL(`${key}.md`, DIR), "utf8");

/** Every article answers the same five questions, in this order. */
const SECTIONS = ["What it is", "If you leave it", "What BossMox does", "Is it safe?", "Proxmox's own page"];
/** Hosts an article may link to (plan 0.3.2, design review: not all of github.com, which holds anyone's content). */
const HOSTS = new Set(["pve.proxmox.com", "bugzilla.proxmox.com", "forum.proxmox.com", "www.proxmox.com"]);

test("every article the upgrade checker can point to exists, and nothing else is lying around", () => {
  for (const key of UPGRADE_HELP) assert.ok(files.includes(`${key}.md`), `${key}.md`);
  for (const f of files) assert.match(f, /^[a-z0-9-]+\.md$/, "names are plain keys");
});

test("each article has a title and the five sections, in order", () => {
  for (const f of files) {
    const text = readFileSync(new URL(f, DIR), "utf8");
    assert.match(text, /^# \S/, `${f}: title first`);
    const heads = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(heads, SECTIONS, f);
  }
});

test("links go only to Proxmox's own sites or BossMox's repository, over https", () => {
  for (const f of files) {
    const text = readFileSync(new URL(f, DIR), "utf8");
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] as string);
    assert.ok(links.length, `${f}: links to Proxmox's own page`);
    for (const l of links) {
      const u = new URL(l);
      assert.equal(u.protocol, "https:", `${f}: ${l}`);
      assert.ok(HOSTS.has(u.host) || (u.host === "github.com" && u.pathname.startsWith("/bossmox/")), `${f}: ${l}`);
    }
  }
});

test("articles are public: no real cluster, company, node name or address in them", () => {
  for (const f of files) {
    const text = read(f.replace(/\.md$/, ""));
    assert.doesNotMatch(text, /maverick|mavcomp|\bMCS\b|pve-node\d|\b10\.\d+\.\d+\.\d+\b|172\.16\./i, f);
    assert.doesNotMatch(text, /<[a-z!/]/i, `${f}: no raw HTML`);
  }
});
