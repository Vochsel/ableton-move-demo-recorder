// Older modules call drawMenuFooter({left, right}); the current host takes hint
// strings. Translate so their footers draw as hints instead of "[object Object]".
export * from "../../ref/schwung/src/shared/menu_layout.mjs";
import { drawMenuFooter as real } from "../../ref/schwung/src/shared/menu_layout.mjs";
export function drawMenuFooter(hints, y) {
    if (hints && typeof hints === "object" && !Array.isArray(hints) && ("left" in hints || "right" in hints)) {
        hints = [hints.left, hints.right].filter((h) => h !== undefined && h !== null && String(h).trim());
    }
    return real(hints, y);
}
