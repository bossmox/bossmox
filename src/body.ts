import type { IncomingMessage } from "node:http";
import { AuthError } from "./auth.js";

/**
 * A request's small JSON body. The server allows hours per request for big uploads, so an ordinary body gets its own
 * time to arrive: a client sending one byte at a time can't hold a connection for hours (#59). Once the body is all
 * here the limit is off, because the action itself may take much longer and must keep its connection.
 */
export function readJsonBody(req: IncomingMessage, limits: { maxBytes: number; waitMs: number }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const slow = setTimeout(() => {
      reject(new AuthError(408, "That request took too long to arrive."));
      req.destroy();
    }, limits.waitMs);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limits.maxBytes) {
        clearTimeout(slow);
        reject(new AuthError(413, "That request was too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("error", (err) => {
      clearTimeout(slow);
      reject(err);
    });
    req.on("close", () => clearTimeout(slow));
    req.on("end", () => {
      clearTimeout(slow);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        reject(new AuthError(400, "That request couldn't be read."));
      }
    });
  });
}
