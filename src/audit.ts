/**
 * One audit line per action, as `key=value` pairs. Values can come from the request, so each is cleaned the same
 * way: nothing in one can start a new line, colour a terminal, or add a field of its own with a space (#59).
 */
export function auditLine(at: Date, event: string, who: string, address: string, fields: Record<string, string | number> = {}): string {
  const value = (s: string | number) => String(s).replace(/[^\x21-\x7e]/g, "?");
  const extra = Object.entries(fields)
    .map(([k, v]) => ` ${k}=${value(v)}`)
    .join("");
  return `audit ${at.toISOString()} ${event} user=${value(who)} from=${value(address)}${extra}`;
}
