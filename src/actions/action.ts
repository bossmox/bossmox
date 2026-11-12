import type { Session } from "../auth.js";

/** One named thing BossMox can change on Proxmox. There is no general pass-through: every action is listed. */
export type Action = (name: string, who: Session, body: Record<string, unknown>) => Promise<string | null>;
