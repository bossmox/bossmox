/** What a request may contain, checked the same way by every route and action. */
export const NODE_NAME = /^(?!\.+$)[\w.-]{1,64}$/;
export const UPID = /^UPID:[\w.-]+:[0-9A-F]{8}:[0-9A-F]{8,}:[0-9A-F]{8}:\w+:[^:\s]*:[\w.@!-]+:$/;
export const STORAGE = /^(?!\.+$)[\w.-]{1,64}$/;
export const VOLUME = /^[\w.-]+:[\w./-]+$/;
export const JOB_ID = /^[\w-]{1,64}$/;
export const SCHEDULE = /^((mon|tue|wed|thu|fri|sat|sun) )?([01]\d|2[0-3]):[0-5]\d$/;
export const SNAPSHOT_NAME = /^[A-Za-z][\w-]{1,39}$/;

/** A string from a request, or empty when it's missing, not a string, or longer than `max`. */
export const text = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : "");
