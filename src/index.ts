import { applySettings } from "./settings.js";

// Settings have to be in place before anything reads them, so each mode loads only after this check.
if (applySettings(process.env)) await import("./setup.js");
else await import("./server.js");
