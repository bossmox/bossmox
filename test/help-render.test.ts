import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Tests run from dist/test; the page's files are in public/, the articles in docs/help/.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
// Run it the way the browser does: a plain script in its own scope, with the browser's URL.
const page = vm.runInNewContext(`${read("public/help.js")}\n;({ helpHtml, helpLink })`, { URL }) as {
  helpHtml: (md: string) => string;
  helpLink: (href: string) => string | null;
};

test("an article becomes headings, paragraphs, lists, bold, code and links", () => {
  const html = page.helpHtml(
    "# Title\n\n## What it is\n\nOne **bold** and *soft* line\nthat runs on, with `code`.\n\n- first\n- second\n\n1. step\n\n[Guide](https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#Prerequisites)",
  );
  assert.equal(
    html,
    '<h3>Title</h3><h4>What it is</h4><p>One <b>bold</b> and <i>soft</i> line that runs on, with <code>code</code>.</p><ul><li>first</li><li>second</li></ul><ol><li>step</li></ol><p><a href="https://pve.proxmox.com/wiki/Upgrade_from_8_to_9#Prerequisites" target="_blank" rel="noopener noreferrer">Guide</a></p>',
  );
});

test("raw HTML and script in an article show as text", () => {
  const html = page.helpHtml('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n**<b>x</b>**');
  assert.doesNotMatch(html, /<script|<img|onerror="/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<b>&lt;b&gt;x&lt;\/b&gt;<\/b>/, "bold markers wrap escaped text only");
});

test("only https links to Proxmox's own sites or BossMox's repository become links", () => {
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://pve.proxmox.com/wiki/x",
    "https://pve.proxmox.com.evil.example/wiki",
    "https://evil.example/pve.proxmox.com",
    "https://user:pw@pve.proxmox.com/",
    "https://pve.proxmox.com:8443/",
    "https://github.com/someone/thing",
    "https://github.com/bossmoxx/thing",
    "//pve.proxmox.com/wiki",
  ])
    assert.equal(page.helpLink(bad), null, bad);
  assert.equal(page.helpLink("https://github.com/bossmox/bossmox/issues/110"), "https://github.com/bossmox/bossmox/issues/110");
  const html = page.helpHtml('[click](javascript:alert(1)) and [x"onmouseover="y](https://pve.proxmox.com/a)');
  assert.doesNotMatch(html, /href="javascript|onmouseover="y"/);
  assert.match(html, /^<p>click\b/, "a refused link shows its words only");
  assert.match(html, />x&quot;onmouseover=&quot;y<\/a>/, "a link's words are escaped");
});

test("a link inside code stays code, and code isn't formatted again", () => {
  assert.equal(page.helpHtml("`[a](https://pve.proxmox.com/) **b**`"), "<p><code>[a](https://pve.proxmox.com/) **b**</code></p>");
});

test("every shipped article renders with no tag the renderer doesn't make", () => {
  const dir = path.join(ROOT, "docs", "help");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const html = page.helpHtml(readFileSync(path.join(dir, f), "utf8"));
    const tags = new Set([...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]));
    for (const t of tags) assert.ok(["h3", "h4", "p", "ul", "ol", "li", "b", "i", "code", "a"].includes(t as string), `${f}: <${t}>`);
  }
});
