// Resolve hook: maps device paths and QuickJS builtins onto local stand-ins.
import { pathToFileURL } from "node:url";
import { fileURLToPath as __f2p } from "node:url";
import __path from "node:path";
const __ROOT = process.env.MDR_ROOT || __path.resolve(__path.dirname(__f2p(import.meta.url)), "../..");

const SHARED = __ROOT + "/ref/schwung/src/shared/";
const HOST = __ROOT + "/ref/schwung/src/host/";
const STUBS = __ROOT + "/pipeline/custom/";
export async function resolve(spec, ctx, next) {
    if (/(^|\/)shared\/menu_layout\.mjs$/.test(spec) && !ctx.parentURL?.includes("/ref/schwung/src/shared/") && !ctx.parentURL?.includes("menu_layout_compat") && !spec.startsWith("/Users/"))
        return next(pathToFileURL(STUBS + "menu_layout_compat.mjs").href, ctx);
    for (const pre of ["/data/UserData/schwung/shared/", "/data/UserData/move-anything/shared/"]) {
        if (spec.startsWith(pre)) return next(pathToFileURL(SHARED + spec.slice(pre.length)).href, ctx);
    }
    if (spec.startsWith("/data/UserData/schwung/host/")) return next(pathToFileURL(HOST + spec.slice(28)).href, ctx);
    if (spec === "os" || spec === "qjs:os") return next(pathToFileURL(STUBS + "qjs_os.mjs").href, ctx);
    if (spec === "std" || spec === "qjs:std") return next(pathToFileURL(STUBS + "qjs_std.mjs").href, ctx);
    if (/\/shared\/[^/]+\.mjs$/.test(spec) && spec.startsWith(".")) {
        try { return await next(spec, ctx); } catch {
            return next(pathToFileURL(SHARED + spec.replace(/^.*\/shared\//, "")).href, ctx);
        }
    }
    return next(spec, ctx);
}
// .js files are loaded as ES modules (QuickJS treats them as modules).
export async function load(url, ctx, next) {
    if (url.startsWith("file:") && url.endsWith(".js")) return next(url, { ...ctx, format: "module" });
    return next(url, ctx);
}
