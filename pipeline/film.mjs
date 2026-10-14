#!/usr/bin/env node
/**
 * film.mjs — film one (or every) catalog module's OLED through Schwung's own
 * renderer: the chain picker scrolling to the module, then its real parameter
 * pages with knobs being turned.
 *
 *   node pipeline/film.mjs <id> [--png DIR]     one module
 *   node pipeline/film.mjs --all                 every module in data/contracts.json
 *
 * Output: build/oled/<id>.js — `window.OLED = { id, fps, frames, w, h, data, events }`
 * where data is base64 of 1-bit packed frames (1024 bytes each, row-major, MSB first)
 * and events drive the 3D model's knobs, jog wheel and pads.
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
const { fakeValue } = await imp("tools/param-pages/fake_values.mjs");
const { drawChainPicker } = await imp("src/shared/chain_editor_chrome.mjs");

export const FPS = 30;
export const DURATION = 12;
const NFRAMES = FPS * DURATION;
const PICKER_END = 1.8;          // seconds the picker is on screen
const OUT = path.join(ROOT, "build", "oled");

const contracts = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "contracts.json"), "utf8"));

/* Deterministic PRNG per module so every render of a module is identical. */
function rng(seedStr) {
    let h = 2166136261;
    for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return () => {
        h += 0x6d2b79f5;
        let t = h;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));

const SLOT_HEADER = {
    sound_generator: "S1 > Synth", audio_fx: "S1 > FX1", midi_fx: "S1 > MIDI FX",
    overtake: "Tools", tool: "Tools", utility: "Tools",
};

/* Install the device's global drawing verbs over a framebuffer (the picker
 * path draws through globals, exactly as on the device). */
function bindGlobals(fb) {
    const hctx = H.drawContext(fb);
    globalThis.clear_screen = () => fb.fillRect(0, 0, 128, 64, 0);
    globalThis.fill_rect = fb.fillRect;
    globalThis.print = fb.print;
    globalThis.text_width = fb.textWidth;
    globalThis.set_pixel = fb.setPixel;
    globalThis.line = hctx.line;
    return hctx;
}

/* Picker: the real chain picker, the cursor stepping down to the module. */
function pickerPlan(mod) {
    const peers = contracts
        .filter((m) => (SLOT_HEADER[m.component_type] === SLOT_HEADER[mod.component_type]))
        .map((m) => ({ id: m.id, name: m.name }))
        .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
    const at = peers.findIndex((p) => p.id === mod.id);
    /* Show a window of the list ending a few rows past the target, so the
     * cursor visibly travels ~5 rows. */
    const start = Math.max(0, at - 5);
    const entries = [{ id: "__list_filter__", name: "List", value: "All", clickVerb: "LIST" }];
    if (start === 0) entries.push({ id: "", name: "None" });
    for (const p of peers.slice(start, Math.min(peers.length, at + 4))) entries.push(p);
    const target = entries.findIndex((e) => e.id === mod.id);
    const from = Math.max(1, target - 5);
    return { entries, target, from };
}

function choosePages(mod) {
    if (!mod.ui_hierarchy && !(mod.chain_params || []).length) return null;
    let plan;
    try {
        plan = planPages({ hierarchy: mod.ui_hierarchy, chainParams: mod.chain_params });
    } catch (e) {
        return null;
    }
    const metaIndex = buildMetaIndex({ hierarchy: mod.ui_hierarchy, chainParams: mod.chain_params });
    const all = plan.pages.map((p, i) => ({ p, i }));
    const grid = all.filter(({ p }) => p.kind === PAGE_KNOBS && (p.keys || []).length);
    if (!grid.length) return null;
    /* The first page, then the richest of the rest (authored ones preferred),
     * keeping their original order so the jog moves forward. */
    const rest = grid.slice(1)
        .map((g) => ({ ...g, score: (g.p.keys.length) + (g.p.authored === false ? -4 : 0) }))
        .sort((a, b) => b.score - a.score).slice(0, 2)
        .sort((a, b) => a.i - b.i);
    return { pages: [grid[0], ...rest], pageCount: plan.pages.length, metaIndex };
}

function fmt(meta, v) {
    if (!meta) return v.toFixed(3);
    if (meta.type === "int" || meta.type === "enum") return String(Math.round(v));
    return v.toFixed(3);
}

/* Turnable keys only: numbers and enums the knob actually drives. */
function turnable(meta) {
    if (!meta || meta.kind === "opaque") return false;
    if (meta.access === "read") return false;
    if (meta.type === "enum") return (meta.options || []).length >= 2;
    return typeof meta.min === "number" || meta.guessed;
}

export function film(mod) {
    const R = rng(mod.id);
    const choice = choosePages(mod);
    const events = [];
    const frames = new Uint8Array(NFRAMES * 1024);
    const title = `S1 > ${String(mod.name || mod.id).toUpperCase()}`;

    /* ---- the schedule ---- */
    const { entries, target, from } = pickerPlan(mod);
    const stepEvery = 0.18;
    const pickerSteps = target - from;
    const clickAt = Math.min(PICKER_END - 0.2, 0.35 + pickerSteps * stepEvery + 0.25);
    for (let s = 1; s <= pickerSteps; s++) events.push({ t: 0.35 + s * stepEvery, type: "jog", dir: 1 });
    events.push({ t: clickAt, type: "click" });

    const segs = [];   // { page, t0, t1, turns:[{k, t0, t1, from, to}] }
    if (choice) {
        const n = choice.pages.length;
        const span = (DURATION - PICKER_END) / n;
        choice.pages.forEach((g, pi) => {
            const t0 = PICKER_END + pi * span;
            const t1 = t0 + span;
            const keys = g.p.keys;
            const metas = keys.map((k) => choice.metaIndex.getOrGuess(k));
            const cand = keys.map((k, i) => i).filter((i) => turnable(metas[i]) && i < 8);
            const turns = [];
            const nTurns = Math.min(cand.length, span > 3 ? 3 : 2);
            const pool = [...cand];
            const slot = (span - 0.5) / Math.max(1, nTurns);
            for (let j = 0; j < nTurns; j++) {
                const k = pool.splice(Math.floor(R() * pool.length), 1)[0];
                const m = metas[k];
                const lo = m.type === "enum" ? 0 : (typeof m.min === "number" ? m.min : 0);
                const hi = m.type === "enum" ? (m.options.length - 1) : (typeof m.max === "number" ? m.max : 1);
                const base = parseFloat(fakeValue(keys[k], m));
                let to;
                if (m.type === "enum") {
                    const steps = Math.max(1, Math.min(hi - lo, 1 + Math.floor(R() * 3)));
                    to = base + steps <= hi ? base + steps : base - steps;
                } else {
                    const room = (hi - lo);
                    const dir = base - lo > hi - base ? -1 : 1;
                    to = base + dir * room * (0.3 + R() * 0.4);
                    to = Math.max(lo, Math.min(hi, to));
                }
                const ta = t0 + 0.35 + j * slot;
                turns.push({ k, key: keys[k], meta: m, t0: ta, t1: ta + Math.min(1.4, slot * 0.7), from: base, to });
                events.push({ t: ta, type: "touch", knob: k });
                events.push({ t: ta, t1: ta + Math.min(1.4, slot * 0.7), type: "turn", knob: k,
                              amount: (to - base) / Math.max(1e-9, hi - lo) });
                events.push({ t: ta + Math.min(1.4, slot * 0.7) + 0.35, type: "release", knob: k });
            }
            if (pi > 0) events.push({ t: t0, type: "jog", dir: 1 });
            segs.push({ g, t0, t1, turns, metas });
        });
    }

    /* ---- render ---- */
    const anim = createAnimState();
    for (let f = 0; f < NFRAMES; f++) {
        const t = f / FPS;
        const fb = H.createFramebuffer();
        const hctx = bindGlobals(fb);
        clear_screen();
        if (t < PICKER_END || !choice) {
            const steps = Math.max(0, Math.min(pickerSteps, Math.floor((t - 0.35) / stepEvery)));
            const index = t < 0.35 ? from : from + steps;
            drawChainPicker({ fillRect: fb.fillRect, print: fb.print, textWidth: fb.textWidth }, {
                headerLeft: SLOT_HEADER[mod.component_type] || "Tools",
                entries, index, currentId: t >= clickAt ? mod.id : null,
                emptyMessage: "No modules available",
            });
        } else {
            const seg = segs.find((s) => t >= s.t0 && t < s.t1) || segs[segs.length - 1];
            const p = seg.g.p;
            const values = {};
            for (const k of p.keys) values[k] = fakeValue(k, choice.metaIndex.getOrGuess(k));
            const { groups } = resolveViz({ keys: p.keys, metaIndex: choice.metaIndex });
            for (const g of groups) for (const k of (g.extraKeys || [])) {
                if (values[k] === undefined) values[k] = fakeValue(k, choice.metaIndex.getOrGuess(k));
            }
            let touched = -1;
            for (const tr of seg.turns) {
                const x = (t - tr.t0) / (tr.t1 - tr.t0);
                if (t >= tr.t0) {
                    const v = tr.from + (tr.to - tr.from) * ease(x);
                    values[tr.key] = fmt(tr.meta, tr.meta.type === "enum" ? Math.round(v) : v);
                }
                if (t >= tr.t0 && t < tr.t1 + 0.35) touched = tr.k;
            }
            renderPageMovy(hctx, {
                page: p, metaIndex: choice.metaIndex, values, title,
                pageIndex: seg.g.i, pageCount: choice.pageCount, touched, viz: groups,
                footer: touched >= 0 ? [["MUTE", "DFLT"], ["SHFT", "FINE"]]
                                     : [["JOG", "PG"], ["SHFT", "SECT"], ["CLK", "MENU"]],
                nowMs: Math.round(t * 1000), anim,
            });
        }
        /* pack */
        const px = fb.pixels;
        const base = f * 1024;
        for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
            const on = px[y * 128 + x];
            if (on) frames[base + y * 16 + (x >> 3)] |= 0x80 >> (x & 7);
        }
    }
    events.sort((a, b) => a.t - b.t);
    return { frames, events, hasPages: !!choice,
             pages: choice ? segs.map((s) => ({ name: s.g.p.name, t0: s.t0, t1: s.t1 })) : [] };
}

function write(mod, res) {
    fs.mkdirSync(OUT, { recursive: true });
    const payload = {
        id: mod.id, fps: FPS, frames: NFRAMES, w: 128, h: 64,
        events: res.events, pages: res.pages, hasPages: res.hasPages,
        data: Buffer.from(res.frames).toString("base64"),
    };
    fs.writeFileSync(path.join(OUT, `${mod.id}.js`), `window.OLED=${JSON.stringify(payload)};\n`);
}

/* ---- cli ---- */
const argv = process.argv.slice(2);
if (argv.length) {
    const ids = argv.includes("--all") ? contracts.map((m) => m.id) : argv.filter((a) => !a.startsWith("--") && !/^\//.test(a));
    const pngDir = argv.includes("--png") ? argv[argv.indexOf("--png") + 1] : null;
    for (const id of ids) {
        const mod = contracts.find((m) => m.id === id);
        if (!mod) { console.error("unknown module", id); continue; }
        const t0 = Date.now();
        let res;
        try { res = film(mod); } catch (e) { console.error(`${id}: FAILED ${e.stack}`); continue; }
        write(mod, res);
        if (pngDir) {
            fs.mkdirSync(pngDir, { recursive: true });
            for (const sec of [0.5, 1.5, 3, 5, 7, 9, 11]) {
                const f = Math.round(sec * FPS), fb = H.createFramebuffer();
                for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++)
                    if (res.frames[f * 1024 + y * 16 + (x >> 3)] & (0x80 >> (x & 7))) fb.fillRect(x, y, 1, 1, 1);
                fs.writeFileSync(path.join(pngDir, `${id}-${String(sec).replace(".", "_")}.png`), fb.toPng(4));
            }
        }
        console.log(`${id.padEnd(20)} pages=${res.pages.length} events=${res.events.length} ${Date.now() - t0}ms`);
    }
}
