#!/usr/bin/env node
/**
 * fuzz_ui.mjs — render EVERY page of every knob-grid module through Schwung's
 * renderer with random, extreme and garbage values (and its canvas widgets),
 * touching random knobs. Flags renderer exceptions, pixels drawn off the
 * 128x64 panel (silently lost on the device), and glyphs the device font
 * cannot draw.
 *
 *   node pipeline/fuzz_ui.mjs [ids...] [--iters N]   -> build/fuzz/ui-report.json/.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCH = path.join(ROOT, "ref", "schwung");
const imp = (p) => import(path.join(SCH, p));
const H = await imp("tools/param-pages/harness.mjs");
const { planPages, PAGE_KNOBS } = await imp("src/shared/param_pages/page_plan.mjs");
const { buildMetaIndex } = await imp("src/shared/param_pages/param_meta.mjs");
const { renderPageMovy } = await imp("src/shared/param_pages/render_page_movy.mjs");
const { resolveViz } = await imp("src/shared/param_pages/viz.mjs");
const { createAnimState } = await imp("src/shared/param_pages/anim_state.mjs");
const { registerOverlayWidgets, clearWidgets } = await imp("src/shared/param_pages/widget_registry.mjs");
const { frameCtx } = await imp("src/shared/param_pages/frame_ctx.mjs");

const contracts = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "contracts.json"), "utf8"));
for (const c of contracts) if (c.module_dir && !path.isAbsolute(c.module_dir)) c.module_dir = path.join(ROOT, c.module_dir);   // stored relative to the workspace
const args = process.argv.slice(2);
let iters = 6;
if (args.includes("--iters")) iters = +args[args.indexOf("--iters") + 1];
const ids = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--iters");
const mods = contracts.filter((m) => (!ids.length || ids.includes(m.id)) && m.screen === "grid");

function rng(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return () => { h = (h + 0x6d2b79f5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function randVal(meta, R, mode) {
    if (mode === "garbage") return ["", "nan", "-", "abc", "1e30", "-1e30", "éè", "[]", "{}", "999999999"][Math.floor(R() * 10)];
    if (!meta) return String(R());
    if (meta.type === "enum") {
        const n = (meta.options || []).length;
        if (mode === "extreme") return R() < 0.5 ? "0" : String(Math.max(0, n - 1));
        return R() < 0.7 ? String(Math.floor(R() * n)) : String((meta.options || [""])[Math.floor(R() * n)] || "");
    }
    const lo = typeof meta.min === "number" ? meta.min : 0, hi = typeof meta.max === "number" ? meta.max : 1;
    if (mode === "extreme") return String(R() < 0.5 ? lo : hi);
    return (lo + (hi - lo) * R()).toFixed(meta.type === "int" ? 0 : 3);
}

function loadOverlays(mod) {
    clearWidgets();
    const ov = {};
    if (!mod.module_dir || !fs.existsSync(mod.module_dir)) return ov;
    for (const f of fs.readdirSync(mod.module_dir)) {
        if (!/\.js$/.test(f)) continue;
        const src = fs.readFileSync(path.join(mod.module_dir, f), "utf8");
        if (!/canvas_overlay/.test(src)) continue;
        try { const g = {}; new Function("globalThis", src)(g); if (g.canvas_overlay) { registerOverlayWidgets(g.canvas_overlay); ov[f] = g.canvas_overlay; } }
        catch (e) { ov[f] = { error: e.message }; }
    }
    return ov;
}

import { execFileSync } from "node:child_process";
const one = args.includes("--one");
if (!one) {
    /* driver: each module in its own process, so a renderer that never returns is a finding, not a stall */
    const report = {};
    for (const mod of mods) {
        let r;
        try {
            const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--one", "--iters", String(iters), mod.id], { timeout: 60000, maxBuffer: 1 << 26 }).toString();
            r = JSON.parse(out.slice(out.lastIndexOf("@@") + 2));
        } catch (e) {
            r = { findings: [{ kind: e.code === "ETIMEDOUT" || e.signal === "SIGTERM" ? "hang" : "fuzzer-crash", detail: String(e.message).slice(0, 200) }] };
        }
        report[mod.id] = r;
        console.log(mod.id.padEnd(20), r.findings.length ? [...new Set(r.findings.map((f) => f.kind))].join(", ") : "ok");
    }
    fs.mkdirSync(path.join(ROOT, "build", "fuzz"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "build", "fuzz", "ui-report.json"), JSON.stringify(report, null, 1));
    const by = {};
    for (const [id, r] of Object.entries(report)) for (const f of r.findings) (by[f.kind] ||= []).push([id, f]);
    const md = ["# UI fuzz report", "", `${mods.length} knob-grid modules, every page, ${iters} value sets each (normal / extreme / garbage), 60 s watchdog per module.`, ""];
    for (const k of Object.keys(by).sort()) {
        md.push(`## ${k} (${new Set(by[k].map(([i]) => i)).size} modules)`);
        for (const [id, f] of by[k].slice(0, 300)) md.push(`- ${id}: ${JSON.stringify(Object.fromEntries(Object.entries(f).filter(([x]) => x !== "kind")))}`);
        md.push("");
    }
    fs.writeFileSync(path.join(ROOT, "build", "fuzz", "ui-report.md"), md.join("\n"));
    console.log("ui report: build/fuzz/ui-report.md");
    process.exit(0);
}
const report = {};
for (const mod of mods) {
    const findings = [];
    let plan;
    try { plan = planPages({ hierarchy: mod.ui_hierarchy, chainParams: mod.chain_params || [] }); }
    catch (e) { report[mod.id] = { findings: [{ kind: "plan-throws", detail: String(e.message).slice(0, 160) }] }; continue; }
    if (plan.warnings && plan.warnings.length) findings.push({ kind: "plan-warning", detail: plan.warnings.slice(0, 3).join("; ").slice(0, 200) });
    const metaIndex = buildMetaIndex({ hierarchy: mod.ui_hierarchy, chainParams: mod.chain_params || [] });
    const overlays = loadOverlays(mod);
    for (const [f, o] of Object.entries(overlays)) if (o.error) findings.push({ kind: "canvas-load-throws", file: f, detail: o.error.slice(0, 160) });
    const pages = plan.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === PAGE_KNOBS);
    for (const { p, i } of pages) {
        for (let it = 0; it < iters; it++) {
            const R = rng(`${mod.id}/${i}/${it}`);
            const mode = it === 0 ? "normal" : it === 1 ? "extreme" : it === 2 ? "garbage" : (R() < 0.5 ? "normal" : "extreme");
            const values = {};
            for (const k of p.keys || []) values[k] = randVal(metaIndex.getOrGuess(k), R, mode);
            const { groups } = resolveViz({ keys: p.keys || [], metaIndex });
            for (const g of groups) for (const k of (g.extraKeys || [])) values[k] = randVal(metaIndex.getOrGuess(k), R, mode);
            const fb = H.createFramebuffer();
            const touched = R() < 0.5 ? Math.floor(R() * Math.max(1, (p.keys || []).length)) : -1;
            try {
                renderPageMovy(H.drawContext(fb), {
                    drawCanvasPage: (ctx, band, canvas, extra) => {
                        const o = Object.values(overlays).find((x) => x && typeof x.drawPage === "function");
                        if (o) o.drawPage(frameCtx(ctx, band), { key: canvas.key, values, nowMs: it * 100, width: band.w, height: band.h });
                    },
                    page: p, metaIndex, values, title: `S1 > ${mod.name.toUpperCase()}`, pageIndex: i, pageCount: plan.pages.length,
                    touched, viz: groups, footer: [["JOG", "PG"], ["SHFT", "SECT"], ["CLK", "MENU"]], nowMs: it * 100, anim: createAnimState(),
                });
            } catch (e) {
                findings.push({ kind: mode === "garbage" ? "throws-on-garbage" : "throws", page: p.name, detail: String(e.message).slice(0, 160) });
                continue;
            }
            if (fb.clipped() > 0) findings.push({ kind: "draws-off-screen", page: p.name, mode, pixels: fb.clipped() });
            const miss = [...fb.missingGlyphs].join("");
            if (miss) findings.push({ kind: "missing-glyph", page: p.name, mode, glyphs: miss });
        }
    }
    const seen = new Set();
    report[mod.id] = { pages: pages.length, findings: findings.filter((f) => { const k = `${f.kind}|${f.page}|${f.detail || f.glyphs || ""}`; if (seen.has(k)) return false; seen.add(k); return true; }) };

}
process.stdout.write("@@" + JSON.stringify(Object.values(report)[0] || { findings: [] }));
process.exit(0);
const by = {};
for (const [id, r] of Object.entries(report)) for (const f of r.findings) (by[f.kind] ||= []).push([id, f]);
const md = ["# UI fuzz report", "", `${mods.length} knob-grid modules, every page, ${iters} value sets each (normal / extreme / garbage).`, ""];
for (const k of Object.keys(by).sort()) {
    md.push(`## ${k} (${new Set(by[k].map(([i]) => i)).size} modules)`);
    for (const [id, f] of by[k].slice(0, 200)) md.push(`- ${id}: ${JSON.stringify(Object.fromEntries(Object.entries(f).filter(([x]) => x !== "kind")))}`);
    md.push("");
}
fs.writeFileSync(path.join(ROOT, "build", "fuzz", "ui-report.md"), md.join("\n"));
console.log("ui report: build/fuzz/ui-report.md");
