/**
 * Proxmox's own failure messages, put into plain words (ADR 0016). The original stays on the end, because it's
 * what to search for or quote when asking for help. Unknown messages pass through untouched.
 */
const LOCKS: Record<string, string> = {
  backup: "It's being backed up right now. Try again when the backup finishes.",
  snapshot: "It's in the middle of a snapshot. Try again in a minute.",
  "snapshot-delete": "It's in the middle of deleting a snapshot. Try again in a minute.",
  rollback: "It's in the middle of going back to a snapshot. Try again in a minute.",
  migrate: "It's being moved to another node. Try again when the move finishes.",
  clone: "It's being cloned. Try again when the clone finishes.",
  create: "It's still being made. Try again in a minute.",
  destroy: "It's being deleted.",
  suspended: "It's suspended. Resume it first.",
};

const RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/still in use by linked clone/i, () => "A clone made from this template still needs it. Delete that clone first, or make it a full copy."],
  [/\b(?:VM|CT) is locked \(([\w-]+)\)/i, (m) => LOCKS[(m[1] ?? "").toLowerCase()] ?? "It's busy with something else. Try again in a minute."],
  [/\bprotected\b/i, () => "It's protected, so Proxmox won't delete it. Turn off its protection first."],
  [/no space left on device|not enough (free )?space|insufficient space|out of (data )?space|thin pool .* (is )?full/i, () => "The storage is full. Free some space, or pick another storage."],
  [/\b(?:VM|CT) (?:\d+ )?is running\b|is running - (?:destroy|unable)/i, () => "It's running. Shut it down first."],
  [/permission check failed/i, () => "Your Proxmox account doesn't have permission to do that."],
  [/storage '([^']+)' is not online|unable to activate storage '([^']+)'/i, (m) => `The storage ${m[1] ?? m[2]} isn't reachable right now. Check that it's switched on and connected.`],
  [/no such (?:VM|CT|guest)|does not exist/i, () => "It isn't there anymore. Someone may have deleted or moved it."],
];

export function plainError(raw: string): string {
  const text = raw.trim();
  for (const [pattern, say] of RULES) {
    const m = text.match(pattern);
    if (m) return `${say(m)} (Proxmox said: ${text})`;
  }
  return text;
}
