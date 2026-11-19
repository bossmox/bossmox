/**
 * Help articles (ADR 0044): a small Markdown subset turned into HTML, everything escaped. Headings, paragraphs, lists,
 * bold, italic, code and links; anything else, raw HTML included, shows as text. A link is only made for an https
 * address on Proxmox's own sites or BossMox's repository. Loaded before app.js; tests run it in node:vm.
 */
const HELP_HOSTS = ["pve.proxmox.com", "bugzilla.proxmox.com", "forum.proxmox.com", "www.proxmox.com"];

const helpEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The address as a safe link target, or null. Parsed, never pattern-matched, so "https://evil/pve.proxmox.com" fails. */
function helpLink(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (HELP_HOSTS.includes(u.hostname) || (u.hostname === "github.com" && u.pathname.startsWith("/bossmox/"))) return u.href;
  return null;
}

/** Bold and italic on text that is already escaped, so the markers can't open anything else. */
const helpEmphasis = (s) => s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\*([^*]+)\*/g, "<i>$1</i>");

/** One line of text: links and code first (their insides aren't formatted again), then everything else escaped. */
function helpInline(text) {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g)) {
    out += helpEmphasis(helpEsc(text.slice(last, m.index)));
    if (m[3] !== undefined) out += `<code>${helpEsc(m[3])}</code>`;
    else {
      const href = helpLink(m[2]);
      out += href ? `<a href="${helpEsc(href)}" target="_blank" rel="noopener noreferrer">${helpEsc(m[1])}</a>` : helpEsc(m[1]);
    }
    last = m.index + m[0].length;
  }
  return out + helpEmphasis(helpEsc(text.slice(last)));
}

/** A whole article as HTML. The first heading is the title. */
function helpHtml(markdown) {
  const out = [];
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${helpInline(para.join(" "))}</p>`);
    para = [];
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of String(markdown).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const head = /^(#{1,2}) (.+)$/.exec(line);
    const item = /^(?:- |\d+\. )(.+)$/.exec(line);
    if (!line.trim()) flush();
    else if (head) {
      flush();
      out.push(head[1] === "#" ? `<h3>${helpInline(head[2])}</h3>` : `<h4>${helpInline(head[2])}</h4>`);
    } else if (item) {
      if (para.length) flush();
      const kind = /^\d/.test(line) ? "ol" : "ul";
      if (list !== kind) {
        if (list) out.push(`</${list}>`);
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${helpInline(item[1])}</li>`);
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join("");
}
