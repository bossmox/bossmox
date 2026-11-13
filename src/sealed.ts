/**
 * Secrets BossMox has to keep, sealed with a key that lives apart from them (ADR 0040). The key is
 * /etc/bossmox/secret.key, made by the installer, owned by root and readable by BossMox's group, so BossMox can use it
 * and can't replace it. A copy of /var/lib/bossmox on its own (a backup, a bug report) holds nothing usable.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export const keyPath = (env: NodeJS.ProcessEnv) => env.BOSSMOX_SECRET_KEY_FILE ?? "/etc/bossmox/secret.key";

/** The key, or null when the install doesn't have one yet (an install from before 0.2.1 that hasn't been updated). */
export function readKey(file: string): Buffer | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : null;
  return key?.length === 32 ? key : null;
}

/** AES-256-GCM: "v1.<iv>.<tag>.<data>", each part base64url. A changed byte or the wrong key fails to open. */
export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** The sealed text opened, or null when it was changed, sealed with another key, or isn't sealed at all. */
export function unseal(sealed: string, key: Buffer): string | null {
  const [v, iv, tag, data] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || data === undefined) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
