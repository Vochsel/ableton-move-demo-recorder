#!/usr/bin/env node
/**
 * demo.mjs — one SCORE per module drives everything: the pad lights, the knobs,
 * the module's real DSP (pipeline/audio.py), and the OLED film, which is drawn
 * from the DSP's own state read back every frame (build/trace/<id>.jsonl).
 *
 *   node pipeline/demo.mjs plan  <ids|--all>   pages + the keys to probe and to trace
 *   node pipeline/demo.mjs score <ids|--all>   build/score/<id>.json (needs build/probe)
 *   node pipeline/demo.mjs film  <ids|--all>   build/oled/<id>.js for knob-grid modules
 *                                               (needs build/trace; module-UI screens are
 *                                               filmed by film_custom.mjs --trace)
 *
 * The piece is a 12 s loop: 6 bars at 120 BPM. Every knob turn sweeps out and
 * comes back, and the screen returns to its first page, so frame 360 == frame 0
 * and the audio (rendered twice, second pass kept) wraps without a seam.
 *
 * Per-module RECIPES (data/recipes/<id>.json) override the generic performance:
 *   { "play": "drums"|"mono"|"poly"|"groove"|"single"|"plucks"|"held"|"none",
 *     "turns": [{ "key": "...", "to": <value or fraction "50%">, "page": <n> }],
 *     "pages": ["Page name", ...], "note": "free text" }
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
const CK = await imp("src/shared/param_pages/child_key.mjs");
const { fakeValue } = await imp("tools/param-pages/fake_values.mjs");
const PF = await imp("src/shared/param_format.mjs");

export const FPS = 30, DURATION = 12, BPM = 120;
export const STEP = 60 / BPM / 4;            // a 16th: 0.125 s
const NF = FPS * DURATION;
const BAR = 16 * STEP;                       // 2 s

const contracts = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "contracts.json"), "utf8"));
const byId = Object.fromEntries(contracts.map((c) => [c.id, c]));
for (const c of contracts) if (c.module_dir && !path.isAbsolute(c.module_dir)) c.module_dir = path.join(ROOT, c.module_dir);   // stored relative to the workspace
const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const loadtest = readJson(path.join(ROOT, "build", "loadtest", "result.json"), {});

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

/* ---------------- roles ---------------- */
export function roleOf(mod) {
    const lt = loadtest[mod.id] || {};
    const dspOk = lt.status === "OK";
    const text = `${mod.id} ${mod.name} ${mod.description} ${(mod.tags || []).join(" ")} ${mod.subcategory || ""}`.toLowerCase();
    const recipe = readJson(path.join(ROOT, "data", "recipes", `${mod.id}.json`), {}) || {};
    let audio = "standin", play = "groove";
    if (mod.component_type === "sound_generator") {
        audio = dspOk && lt.kind === "synth" ? "synth" : "standin";
        if (mod.subcategory === "drum-machine" || mod.pad_layout === "drums") play = "drums";
        else if (mod.subcategory === "mono-bass" || /\bmonophonic\b/.test(text)) play = "mono";
        else if (mod.subcategory === "streaming-live-input") play = "groove";
        else play = "poly";
    } else if (mod.component_type === "audio_fx") {
        audio = dspOk && lt.kind === "fx" ? "fx" : "standin";
        play = "groove";
    } else if (mod.component_type === "midi_fx") {
        audio = dspOk && lt.kind === "midifx" ? "midifx" : "standin";
        /* what a MIDI FX wants to be fed */
        if (/\barp|arpeggi/.test(text)) play = "held";
        else if (/chord/.test(text)) play = "single";
        else if (/drum|euclid|beat|groove|grids|branch/.test(text)) play = "held";
        else play = "plucks";
    }
    if (recipe.play) play = recipe.play;
    const standinDrums = audio === "midifx" && /drum|euclid|beat|grids|branch/.test(text);
    return { audio, play, dspOk, screen: mod.screen || "grid", recipe, standinDrums };
}

/* the hierarchy used to PLAN pages and knob turns: what the grid shows, or for a
 * module drawing its own screen, the ui_pages it serves to external surfaces */
function planningContract(mod) {
    const served = readJson(path.join(ROOT, "build", "contract", `${mod.id}.json`), {}) || {};
    let hier = mod.ui_hierarchy;
    if (!hier && served.ui_pages) { try { hier = JSON.parse(served.ui_pages); } catch {} }
    return { hier, cp: mod.chain_params || [] };
}

/* Child levels (drum pads, voices) declare TEMPLATE keys ("sample") that the device
 * resolves to the focused instance ("p01_sample") through child_key.mjs. */
function childResolver(hier, values = {}) {
    const byKey = new Map();
    const levels = (hier && hier.levels) || {};
    for (const lvl of Object.values(levels)) {
        if (!CK.hasChildren(lvl)) continue;
        const keys = [...(lvl.knobs || []), ...(lvl.params || [])].map((x) => (typeof x === "string" ? x : x && x.key)).filter(Boolean);
        let idx = 0;
        const ip = CK.childIndexParam(lvl);
        if (ip && values[ip] !== undefined) { const i = CK.childIndexFromWire(lvl, values[ip]); if (Number.isInteger(i) && i >= 0) idx = i; }
        for (const k of keys) byKey.set(k, () => CK.resolveChildKey(lvl, idx, k));
    }
    return (k) => (byKey.has(k) ? (byKey.get(k)() || k) : k);
}

function choosePages(mod, recipe = {}) {
    const { hier, cp } = planningContract(mod);
    if (!hier && !cp.length) return null;
    let plan;
    try { plan = planPages({ hierarchy: hier, chainParams: cp }); } catch { return null; }
    const metaIndex = buildMetaIndex({ hierarchy: hier, chainParams: cp });
    const grid = plan.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === PAGE_KNOBS && ((p.keys || []).length || p.canvas));
    if (!grid.length) return null;
    let chosen;
    if (recipe.pages && recipe.pages.length) {
        chosen = recipe.pages.map((name) => grid.find((g) => g.p.name === name)).filter(Boolean).slice(0, 3);
    }
    if (!chosen || !chosen.length) {
        /* the first page, then the richest of the rest — a custom canvas page counts as rich */
        const rest = grid.slice(1)
            .map((g) => ({ ...g, score: (g.p.keys || []).length + (g.p.canvas ? 8 : 0) + (g.p.authored === false ? -4 : 0) }))
            .sort((a, b) => b.score - a.score).slice(0, 2).sort((a, b) => a.i - b.i);
        chosen = [grid[0], ...rest];
    }
    return { pages: chosen, pageCount: plan.pages.length, metaIndex, hier, cp };
}

/* every key the module might show: contract keys, viz/canvas extra keys, and for a
 * module drawing its own screen, the string literals its UI scripts read */
function allKeys(mod, choice) {
    const keys = new Set();
    const walk = (x) => {
        if (Array.isArray(x)) { x.forEach(walk); return; }
        if (x && typeof x === "object") {
            if (typeof x.key === "string") keys.add(x.key);
            for (const k of ["extra_keys", "knobs", "params"]) if (Array.isArray(x[k])) x[k].forEach((v) => typeof v === "string" ? keys.add(v) : walk(v));
            for (const v of Object.values(x)) if (v && typeof v === "object") walk(v);
        }
    };
    if (choice) { walk(choice.hier); walk(choice.cp); }
    walk(mod.ui_hierarchy); walk(mod.chain_params);
    if (choice) for (const g of choice.pages) {
        for (const k of g.p.keys || []) keys.add(k);
        for (const v of resolveViz({ keys: g.p.keys || [], metaIndex: choice.metaIndex }).groups) for (const k of (v.extraKeys || [])) keys.add(k);
        if (g.p.canvas) { if (g.p.canvas.key) keys.add(g.p.canvas.key); for (const k of (g.p.canvas.extra_keys || g.p.canvas.extraKeys || [])) keys.add(k); }
    }
    if (mod.module_dir && fs.existsSync(mod.module_dir)) {
        for (const f of fs.readdirSync(mod.module_dir)) {
            if (!/\.(js|mjs)$/.test(f)) continue;
            const src = fs.readFileSync(path.join(mod.module_dir, f), "utf8");
            for (const m of src.matchAll(/["'`]([a-z][a-z0-9_]*(?::[a-z0-9_]+)?)["'`]/g)) if (m[1].length <= 40) keys.add(m[1]);
        }
    }
    for (const k of ["ui_hierarchy", "chain_params", "ui_pages", "state", "help", "preset_list"]) keys.delete(k);
    return [...keys].slice(0, 1500);
}

/* ---------------- music ---------------- */
const PROG = [[0, "m"], [8, "M"], [3, "M"], [10, "M"], [0, "m"], [10, "M"]];   // i VI III VII i VII
const triad = (q) => (q === "m" ? [0, 3, 7] : [0, 4, 7]);

export function makeNotes(play, R) {
    const notes = [];
    const key = [0, 2, 5, 7, 9][Math.floor(R() * 5)];
    const push = (t, dur, note, vel, part) => notes.push({ t: +t.toFixed(4), t1: +(t + dur).toFixed(4), note, vel, part });
    for (let bar = 0; bar < 6; bar++) {
        const b0 = bar * BAR;
        const [deg, q] = PROG[bar];
        const tri = triad(q);
        const root = 48 + key + deg - (deg > 6 ? 12 : 0);
        if (play === "drums" || play === "groove") {
            (bar % 2 ? [0, 7, 10] : [0, 8]).forEach((s) => push(b0 + s * STEP, STEP * 1.5, 36, s === 0 ? 118 : 100, "drums"));
            [4, 12].forEach((s) => push(b0 + s * STEP, STEP * 1.5, 38, 108, "drums"));
            for (let s = 0; s < 16; s += 2) push(b0 + s * STEP, STEP, 42, s % 4 === 0 ? 92 : 64, "drums");
            push(b0 + 14 * STEP, STEP * 1.5, 46, 80, "drums");
            if (bar === 3 || bar === 5) [13, 15].forEach((s) => push(b0 + s * STEP, STEP, 39, 96, "drums"));
            if (bar % 2 === 1) push(b0 + 3 * STEP, STEP, 37, 70, "drums");
        }
        if (play === "mono") {
            const r = root - 12;
            const arp = [0, 12, tri[2], 12 + tri[1], 0, tri[2] + 12, tri[1], 12];
            for (let s = 0; s < 16; s++) push(b0 + s * STEP, STEP * (s % 4 === 3 ? 0.95 : 0.6), r + arp[s % 8], s % 4 === 0 ? 120 : 84, "mono");
        }
        if (play === "poly" || play === "groove") {
            const voicing = [root + tri[0] + 12, root + tri[1] + 12, root + tri[2]].sort((a, b) => a - b);
            for (const [s, len] of [[0, 5], [6, 3], [10, 5]]) for (const n of voicing) push(b0 + s * STEP, len * STEP * 0.95, n, s === 0 ? 104 : 88, "chord");
            push(b0, STEP * 7, root - 12, 110, "bass");
            push(b0 + 8 * STEP, STEP * 6, root - 12, 100, "bass");
        }
        if (play === "held") for (const iv of tri) push(b0, BAR - 0.02, root + iv, 100, "held");
        if (play === "single") [0, 4, 8, 12].forEach((s, i) => push(b0 + s * STEP, STEP * 3.5, root + [0, tri[2], tri[1] + 12, tri[2]][i], 100, "lead"));
        if (play === "plucks") {
            const mel = [0, 7, 12, tri[1] + 12, 7, tri[1], 12, 7];
            [0, 2, 3, 6, 8, 10, 11, 14].forEach((s, i) => push(b0 + s * STEP, STEP * 0.7, root + mel[i], i % 3 === 0 ? 112 : 88, "lead"));
        }
    }
    return { notes, key };
}

/* Pads: drums on the left 4x4 (Move's drum rack: 36 bottom-left), melodic on a
 * fourths grid. Index convention: 0 = bottom-left (note 68), row-major upward. */
export function padFor(note, part, split, key) {
    if (part === "drums") {
        const s = note - 36;
        if (s < 0 || s > 15) return null;
        return Math.floor(s / 4) * 8 + (s % 4);
    }
    if (split) {
        const s = ((note - 48) % 16 + 16) % 16;
        return Math.floor(s / 4) * 8 + 4 + (s % 4);
    }
    /* Move's default Note layout: In-Key, one octave of scale degrees per row of
     * 8 (degrees 1-7 + the octave), the next row an octave up. The piece is in a
     * natural minor on `key`, so every note is a scale degree. */
    const k = key || 0;
    const rel = note - (36 + k);
    const oct = Math.floor(rel / 12), pc = ((rel % 12) + 12) % 12;
    const col = MINOR.indexOf(pc);
    if (col < 0) return null;
    let row = oct;
    while (row > 3) row -= 1;
    while (row < 0) row += 1;
    return row * 8 + col;
}
const MINOR = [0, 2, 3, 5, 7, 8, 10];

/* ---------------- knob turns ---------------- */
const GOOD = /cut|filt|freq|reso|res\b|decay|release|drive|dist|mix|wet|size|time|feedback|fdbk|tone|bright|color|colour|morph|timbre|harm|wave|shape|rate|depth|fm|tune|detune|env|attack|sat|crush|bit|grain|spread|width|room|amount|amt|damp|diff|chorus|warmth|speed|position|pos\b|density|pitch|q\b|glide|porta|shift|metal|bounce|hard|complex|cmplx|strum|swing/i;
const MEH = /vol|level|gain|out|pan|seed|preset|bank|midi|chan|sync|mode|voice|poly|transp|octave|key|scale|root|bpm|tempo|length|steps|learn|random|kill|save|load|sample|path|file|reset|clear|panic/i;

function pickTurns(keys, metas, R, n) {
    const cand = keys.map((k, i) => ({ k, i, m: metas[i] })).filter(({ k, i, m }) => i < 8 && k && m && m.kind !== "opaque" && m.access !== "read"
        && !/(^|_)(step|stop|play|pause|forward|rewind|back|next|prev|trigger|trig|button|action|load|save|scan|reset|panic|learn|kill|random|randomize|browse|record|rec)(_|$)/i.test(k)
        && !(m.guessed && !(m.type === "enum"))
        && m.access !== "write" && !/trigger|action|momentary|filepath/.test(String(m.type || m.kind))
        && (m.type === "enum" ? (m.options || []).length >= 2 : true));
    const w = (c) => {
        const s = `${c.k} ${c.m.label || ""} ${c.m.name || ""}`;
        let x = c.m.type === "enum" ? 0.6 : 1;
        if (GOOD.test(s)) x *= 6;
        if (MEH.test(s)) x *= 0.08;
        return x;
    };
    const out = [];
    const pool = [...cand];
    while (out.length < n && pool.length) {
        const tot = pool.reduce((a, c) => a + w(c), 0);
        let r = R() * tot, j = 0;
        for (; j < pool.length - 1; j++) { r -= w(pool[j]); if (r <= 0) break; }
        out.push(pool.splice(j, 1)[0]);
    }
    return out;
}

function numOf(raw, meta) {
    if (meta && meta.type === "enum") {
        const opts = meta.options || [];
        const n = Number(raw);
        if (String(raw).trim() !== "" && isFinite(n)) return n;
        const idx = opts.indexOf(String(raw).trim());
        return idx >= 0 ? idx : 0;
    }
    const n = parseFloat(raw);
    return isFinite(n) ? n : null;
}

/* ---------------- plan ---------------- */
function plan(mod) {
    const r = roleOf(mod);
    const choice = choosePages(mod, r.recipe);
    const pageKeys = new Set();
    if (choice) for (const g of choice.pages) {
        for (const k of g.p.keys || []) pageKeys.add(k);
        for (const v of resolveViz({ keys: g.p.keys || [], metaIndex: choice.metaIndex }).groups) for (const k of (v.extraKeys || [])) pageKeys.add(k);
    }
    const probe0 = readJson(path.join(ROOT, "build", "probe", `${mod.id}.json`), {}) || {};
    const RK = childResolver(choice && choice.hier, probe0);
    for (const k of [...pageKeys]) pageKeys.add(RK(k));
    const trace = [...new Set([...allKeys(mod, choice), ...[...pageKeys]])];
    const dir = path.join(ROOT, "build", "plan");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${mod.id}.keys.txt`), [...pageKeys].join("\n") + "\n");
    fs.writeFileSync(path.join(dir, `${mod.id}.trace.txt`), trace.join("\n") + "\n");
    fs.writeFileSync(path.join(dir, `${mod.id}.json`), JSON.stringify({ id: mod.id, ...r, recipe: undefined,
        role: ["synth", "fx", "midifx"].includes(r.audio) ? r.audio : "standin", keys: [...pageKeys], pages: choice ? choice.pages.length : 0 }));
    return { audio: r.audio, play: r.play, screen: r.screen, pages: choice ? choice.pages.map((g) => g.p.name) : [], keys: pageKeys.size, trace: trace.length };
}

/* ---------------- score ---------------- */
function score(mod) {
    const R = rng(mod.id + "/score");
    const role = roleOf(mod);
    const choice = choosePages(mod, role.recipe);
    const probe = readJson(path.join(ROOT, "build", "probe", `${mod.id}.json`), {}) || {};
    const music = makeNotes(role.play === "none" ? "none" : role.play, R);
    /* recipe "notes": [[beat, lengthBeats, note, vel], ...] repeated across the 24-beat loop */
    if (Array.isArray(role.recipe.notes) && role.recipe.notes.length) {
        const span = Math.max(1, Math.ceil(Math.max(...role.recipe.notes.map((n) => n[0] + n[1])) / 4) * 4);
        music.notes = [];
        for (let off = 0; off < 24; off += span) for (const [b, l, note, vel] of role.recipe.notes) {
            if (off + b >= 24) continue;
            const t = (off + b) * 0.5;
            music.notes.push({ t: +t.toFixed(4), t1: +Math.min(12, t + l * 0.5).toFixed(4), note, vel: vel || 100, part: role.recipe.part || "lead" });
        }
    }
    const split = music.notes.some((n) => n.part === "drums") && music.notes.some((n) => n.part !== "drums");

    const events = [], segs = [], values0 = {};
    const RK = childResolver(choice && choice.hier, probe);
    if (choice) {
        const grid = role.screen === "grid";
        const n = grid ? choice.pages.length : 1;
        const bounds = n === 1 ? [[0, 12]] : n === 2 ? [[0, 6], [6, 11.7]] : [[0, 4], [4, 8], [8, 11.7]];
        choice.pages.slice(0, n).forEach((g, pi) => {
            const [t0, t1] = bounds[pi];
            const keys = g.p.keys || [];
            const metas = keys.map((k) => choice.metaIndex.getOrGuess(k));
            keys.forEach((k, i) => {
                const rk = RK(k);
                if (probe[rk] !== undefined) { PF.learnEnumWireFormat(metas[i], probe[rk]); values0[k] = probe[rk]; }
                else if (values0[k] === undefined) values0[k] = fakeValue(k, metas[i]);
            });
            const span = t1 - t0;
            const nT = span >= 3.5 ? 2 : 1;
            /* recipe turns on this page win; otherwise pick */
            let picks = (role.recipe.turns || []).filter((t) => (t.page ?? 0) === pi)
                .map((t) => { const i = keys.indexOf(t.key); return i >= 0 ? { k: t.key, i, m: metas[i], to: t.to } : null; }).filter(Boolean);
            if (!picks.length) picks = pickTurns(keys, metas, R, nT);
            const slot = span / Math.max(1, picks.length);
            const turns = picks.map((c, j) => {
                const m = c.m;
                const base = numOf(values0[c.k], m);
                const lo = m.type === "enum" ? 0 : (typeof m.min === "number" ? m.min : 0);
                const hi = m.type === "enum" ? (m.options.length - 1) : (typeof m.max === "number" ? m.max : 1);
                const b = base === null ? lo + (hi - lo) * 0.5 : Math.max(lo, Math.min(hi, base));
                let to;
                if (c.to !== undefined) {
                    to = typeof c.to === "string" && c.to.endsWith("%") ? lo + (hi - lo) * parseFloat(c.to) / 100 : Number(c.to);
                } else if (m.type === "enum") {
                    const st = Math.max(1, Math.min(hi - lo, 1 + Math.floor(R() * 2)));
                    to = b + st <= hi ? b + st : b - st;
                } else {
                    const dir = b - lo > hi - b ? -1 : 1;
                    to = Math.max(lo, Math.min(hi, b + dir * (hi - lo) * (0.45 + R() * 0.25)));
                }
                const a = t0 + 0.3 + j * slot;
                const T = { k: c.i, key: c.k, meta: m, from: b, to, a, out: a + 0.7, hold: a + 1.05, back: a + 1.75 };
                const amt = (to - b) / Math.max(1e-9, hi - lo);
                events.push({ t: T.a - 0.08, type: "touch", knob: c.i });
                events.push({ t: T.a, t1: T.out, type: "turn", knob: c.i, amount: amt, key: c.k });
                events.push({ t: T.hold, t1: T.back, type: "turn", knob: c.i, amount: -amt, key: c.k });
                events.push({ t: T.back + 0.25, type: "release", knob: c.i });
                return T;
            });
            if (pi > 0) events.push({ t: t0, type: "jog", dir: 1 });
            segs.push({ i: g.i, name: g.p.name, t0, t1, turns });
        });
        if (n > 1) {
            events.push({ t: 11.7, type: "jog", dir: -(n - 1) });
            segs.push({ i: choice.pages[0].i, name: choice.pages[0].p.name, t0: 11.7, t1: 12, turns: [] });
        }
    }
    const valueAt = (T, t) => {
        let x = 0;
        if (t >= T.a && t < T.out) x = ease((t - T.a) / (T.out - T.a));
        else if (t >= T.out && t < T.hold) x = 1;
        else if (t >= T.hold && t < T.back) x = 1 - ease((t - T.hold) / (T.back - T.hold));
        const v = T.from + (T.to - T.from) * x;
        return T.meta.type === "enum" ? PF.formatParamForSet(Math.round(v), T.meta) : PF.formatParamForSet(v, T.meta);
    };
    const automation = [];
    for (const s of segs) for (const T of s.turns) {
        let last = null;
        for (let t = T.a; t <= T.back + 0.011; t += 0.01) {
            const v = valueAt(T, Math.min(t, T.back + 0.0001));
            if (v !== last) { automation.push({ t: +t.toFixed(4), key: RK(T.key), value: v }); last = v; }
        }
        const v0 = valueAt(T, T.back + 1);
        if (v0 !== last) automation.push({ t: +(T.back + 0.01).toFixed(4), key: RK(T.key), value: v0 });
    }
    /* recipe "automation": [[beat, key, value], ...] — raw parameter moves the module's
     * own UI would make (e.g. a scratch rate), at absolute beats in the 24-beat loop */
    for (const [beat, key, value] of (role.recipe.automation || [])) automation.push({ t: +(beat * 0.5).toFixed(4), key, value: String(value) });
    /* recipe "jog": [[beat, delta], ...] — jog-wheel moves, shown on the device and fed to a canvas */
    for (const [beat, delta] of (role.recipe.jog || [])) events.push({ t: +(beat * 0.5).toFixed(4), type: "jog", dir: delta });
    /* recipe "fullscreen": { key, from, to } (beats) — dive into a canvas param's fullscreen view */
    let fullscreen = null;
    if (role.recipe.fullscreen) {
        const f = role.recipe.fullscreen;
        fullscreen = { key: f.key, t0: f.from * 0.5, t1: f.to * 0.5 };
        events.push({ t: fullscreen.t0, type: "click" }, { t: fullscreen.t1, type: "click" });
    }
    /* recipe "padGate": { key, on, off } — a param the UI writes while a pad is held */
    if (role.recipe.padGate) {
        const g = role.recipe.padGate;
        for (const n of music.notes) { automation.push({ t: n.t, key: g.key, value: String(g.on) }, { t: n.t1, key: g.key, value: String(g.off) }); }
    }
    /* recipe "set": starting values, written at the top of the loop */
    for (const [key, value] of Object.entries(role.recipe.set || {})) { automation.push({ t: 0, key, value: String(value) }); values0[key] = String(value); }
    automation.sort((a, b) => a.t - b.t);

    if (role.audio !== "midifx") for (const nt of music.notes) {
        const pad = padFor(nt.note, nt.part, split, music.key);
        if (pad !== null) events.push({ t: nt.t, t1: nt.t1, type: "pad", pad, vel: nt.vel, note: nt.note, part: nt.part });
    }
    events.sort((a, b) => a.t - b.t);
    const out = {
        id: mod.id, role: ["synth", "fx", "midifx"].includes(role.audio) ? role.audio : "standin", play: role.play,
        screen: role.screen, key: music.key, bpm: BPM, duration: DURATION,
        notes: music.notes, automation, events, standinDrums: role.standinDrums,
        segs: segs.map((s) => ({ i: s.i, name: s.name, t0: s.t0, t1: s.t1,
            turns: s.turns.map((T) => ({ k: T.k, key: T.key, from: T.from, to: T.to, a: T.a, out: T.out, hold: T.hold, back: T.back })) })),
        values0, fullscreen,
    };
    fs.mkdirSync(path.join(ROOT, "build", "score"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "build", "score", `${mod.id}.json`), JSON.stringify(out));
    return { audio: out.role, play: role.play, screen: role.screen, pages: segs.length, turns: automation.length, notes: music.notes.length };
}

/* ---------------- film (knob-grid screens) ---------------- */
function loadTrace(id) {
    const p = path.join(ROOT, "build", "trace", `${id}.jsonl`);
    if (!fs.existsSync(p)) return null;
    const frames = [];
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); frames[o.f] = o; } catch {}
    }
    return frames.length ? frames : null;
}

/* Every canvas script the contract names (canvas_script on a param), plus canvas.js. */
async function loadCanvas(mod, choice) {
    clearWidgets();
    if (!mod.module_dir) return {};
    const names = new Set();
    const walk = (x) => {
        if (Array.isArray(x)) return x.forEach(walk);
        if (x && typeof x === "object") {
            if (typeof x.canvas_script === "string") names.add(x.canvas_script);
            Object.values(x).forEach((v) => v && typeof v === "object" && walk(v));
        }
    };
    walk(choice && choice.hier); walk(choice && choice.cp); walk(mod.ui_hierarchy); walk(mod.chain_params);
    if (fs.existsSync(path.join(mod.module_dir, "canvas.js"))) names.add("canvas.js");
    const overlays = {};
    for (const n of names) {
        const file = path.join(mod.module_dir, n);
        if (!fs.existsSync(file)) continue;
        const src = fs.readFileSync(file, "utf8");
        try {
            let ov = null;
            if (/^\s*import\s/m.test(src)) {
                /* an ES-module canvas script: load it as a module from a mirror of the
                 * device layout (modules/<category>/<id>/ beside shared/), so its relative
                 * imports of Schwung's shared code resolve as on a Move */
                const mirror = path.join(ROOT, "build", "esm", "modules", "cat", mod.id);
                fs.mkdirSync(mirror, { recursive: true });
                const shared = path.join(ROOT, "build", "esm", "shared");
                if (!fs.existsSync(shared)) fs.symlinkSync(path.join(SCH, "src", "shared"), shared);
                for (const f of fs.readdirSync(mod.module_dir)) {
                    const dst = path.join(mirror, f.replace(/\.js$/, ".mjs"));
                    if (/\.js$/.test(f) && !fs.existsSync(dst)) fs.copyFileSync(path.join(mod.module_dir, f), dst);
                }
                delete globalThis.canvas_overlay;
                await import(path.join(mirror, n.replace(/\.js$/, ".mjs")) + `?v=${Date.now()}`);
                ov = globalThis.canvas_overlay || null;
                delete globalThis.canvas_overlay;
            } else {
                const g = {};
                new Function("globalThis", src)(g);
                ov = g.canvas_overlay || g.overlay || null;
            }
            if (ov) { registerOverlayWidgets(ov); overlays[n] = ov; }
        } catch (e) { console.error(`${mod.id}: ${n} failed: ${e.message}`); }
    }
    return overlays;
}

async function film(mod) {
    const sc = readJson(path.join(ROOT, "build", "score", `${mod.id}.json`));
    if (!sc) throw new Error("no score");
    if (sc.screen !== "grid") return { skipped: "module-ui screen (film_custom.mjs --trace)" };
    const role = roleOf(mod);
    const choice = choosePages(mod, role.recipe);
    if (!choice) throw new Error("no pages");
    const trace = loadTrace(mod.id);
    const overlays = await loadCanvas(mod, choice);
    const drawCanvasPage = (ctx, band, canvas, extra) => {
        const overlay = overlays[canvas.canvas_script || canvas.script || "canvas.js"] || Object.values(overlays)[0];
        if (!overlay || typeof overlay.drawPage !== "function") return;
        try {
            overlay.drawPage(frameCtx(ctx, band), { key: canvas.key, values: (extra && extra.values) || {}, nowMs: extra.nowMs || 0, width: band.w, height: band.h });
        } catch (e) { /* a widget that throws draws nothing, as on the device */ }
    };
    const pageByIdx = Object.fromEntries(choice.pages.map((g) => [g.i, g]));
    const RKf = childResolver(choice.hier, (trace && trace[0]) || {});
    const frames = new Uint8Array(NF * 1024);
    const anim = createAnimState();
    const title = `S1 > ${String(mod.name || mod.id).toUpperCase()}`;
    const missing = new Set();
    const fs_ = sc.fullscreen ? openFullscreen(mod, choice, sc, trace) : null;
    for (let f = 0; f < NF; f++) {
        const t = f / FPS;
        if (fs_ && t >= sc.fullscreen.t0 && t < sc.fullscreen.t1) {
            const fb = H.createFramebuffer();
            fs_.frame(fb, f, t);
            const px = fb.pixels, base = f * 1024;
            for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) if (px[y * 128 + x]) frames[base + y * 16 + (x >> 3)] |= 0x80 >> (x & 7);
            continue;
        }
        const seg = sc.segs.find((s) => t >= s.t0 && t < s.t1) || sc.segs[sc.segs.length - 1];
        const g = pageByIdx[seg.i];
        const p = g.p;
        const tf = trace ? (trace[f] || {}) : {};
        /* with a trace, a key the DSP never answered stays unanswered — the
         * widget then draws its real "no answer" state, as on the device */
        const val = (k) => {
            if (tf[k] !== undefined) return tf[k];
            const rk = RKf(k);
            if (rk !== k && tf[rk] !== undefined) return tf[rk];
            if (trace) { missing.add(k); return undefined; }
            return sc.values0[k] ?? fakeValue(k, choice.metaIndex.getOrGuess(k));
        };
        const values = Object.assign({}, tf);
        delete values.f;
        for (const k of p.keys || []) values[k] = val(k);
        const { groups } = resolveViz({ keys: p.keys || [], metaIndex: choice.metaIndex });
        for (const gg of groups) for (const k of (gg.extraKeys || [])) values[k] = val(k);
        if (p.canvas) for (const k of [p.canvas.key, ...(p.canvas.extra_keys || []), ...(p.canvas.extraKeys || [])].filter(Boolean)) values[k] = val(k);
        for (const k of Object.keys(values)) if (values[k] === undefined) delete values[k];
        let touched = -1;
        for (const T of seg.turns) if (t >= T.a - 0.08 && t < T.back + 0.25) touched = T.k;
        const fb = H.createFramebuffer();
        renderPageMovy(H.drawContext(fb), {
            drawCanvasPage: (ctx, band, canvas, extra) => drawCanvasPage(ctx, band, canvas, { ...extra, values, nowMs: Math.round(t * 1000) }),
            page: p, metaIndex: choice.metaIndex, values, title,
            pageIndex: seg.i, pageCount: choice.pageCount, touched, viz: groups,
            footer: touched >= 0 ? [["MUTE", "DFLT"], ["SHFT", "FINE"]] : [["JOG", "PG"], ["SHFT", "SECT"], ["CLK", "MENU"]],
            nowMs: Math.round(t * 1000), anim,
        });
        const px = fb.pixels, base = f * 1024;
        for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) if (px[y * 128 + x]) frames[base + y * 16 + (x >> 3)] |= 0x80 >> (x & 7);
    }
    /* a film only claims to loop when its last frame really matches its first */
    let seam = 0;
    for (let k = 0; k < 1024; k++) { let x = frames[k] ^ frames[(NF - 1) * 1024 + k]; while (x) { seam += x & 1; x >>= 1; } }
    const payload = { id: mod.id, fps: FPS, frames: NF, w: 128, h: 64, kind: "param-pages", loop: seam <= 60, seam,
        pages: sc.segs.map((s) => ({ name: s.name, t0: s.t0, t1: s.t1 })), hasPages: true,
        live: !!trace, data: Buffer.from(frames).toString("base64"), events: sc.events };
    fs.mkdirSync(path.join(ROOT, "build", "oled"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "build", "oled", `${mod.id}.js`), `window.OLED=${JSON.stringify(payload)};\n`);
    return { live: !!trace, canvas: Object.keys(overlays), missingFromTrace: [...missing].slice(0, 6) };
}

/* ---------------- fullscreen canvas (VIEWS.CANVAS), emulated after shadow_ui.js ----------------
 * openCanvasPreview -> onOpen; every frame tick + onValues (extra_keys, at
 * fullscreen_live_ms) + draw; score pads and jog moves reach onMidi. getParam
 * answers from the DSP trace; setParam is recorded (the audio side gets the same
 * moves from the recipe's automation). */
function openFullscreen(mod, choice, sc, trace) {
    const key = sc.fullscreen.key;
    const meta = (choice.cp || []).find((p) => p && p.key === key) || {};
    const script = meta.canvas_script || "canvas.js";
    const file = path.join(mod.module_dir || "", script);
    if (!fs.existsSync(file)) return null;
    let fb = null, ctxDraw = null;
    const g = { Date: { now: () => nowMs } };
    let nowMs = 0, seed = 12345;
    try { new Function("globalThis", fs.readFileSync(file, "utf8"))(g); } catch (e) { console.error(`${mod.id}: ${script}: ${e.message}`); return null; }
    const ov = g.canvas_overlay;
    if (!ov) return null;
    let frameIdx = 0;
    const state = {};
    const getParam = (k) => {
        const tf = trace ? (trace[frameIdx] || {}) : {};
        if (tf[k] !== undefined) return tf[k];
        return sc.values0[k] ?? null;
    };
    const ctx = {
        width: 128, height: 64, state,
        clear() { fb.fillRect(0, 0, 128, 64, 0); },
        setPixel(x, y, v) { fb.fillRect(Math.round(x), Math.round(y), 1, 1, v ? 1 : 0); },
        drawRect(x, y, w, h, v) { x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h); const c = v ? 1 : 0;
            fb.fillRect(x, y, w, 1, c); fb.fillRect(x, y + h - 1, w, 1, c); fb.fillRect(x, y, 1, h, c); fb.fillRect(x + w - 1, y, 1, h, c); },
        fillRect(x, y, w, h, v) { fb.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h), v ? 1 : 0); },
        drawLine(x1, y1, x2, y2, v) { ctxDraw.line(Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2), v ? 1 : 0); },
        print(x, y, text, color = 1) { fb.print(Math.round(x), Math.round(y), String(text), color ? 1 : 0); },
        measureText(text) { return fb.textWidth(String(text == null ? "" : text)); },
        now() { return nowMs; },
        random() { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; },
        shiftHeld() { return false; },
        close() { return true; },
        getValue() { return getParam(key) || ""; },
        getParam, setParam() { return true; },
    };
    const call = (hook, payload) => { try { if (typeof ov[hook] === "function") return ov[hook](ctx, payload || {}); } catch (e) {} };
    let opened = false, lastLive = -1e9;
    const liveKeys = (meta.extra_keys || []).slice(0, 4), liveMs = Number(meta.fullscreen_live_ms) > 0 ? Math.max(50, Number(meta.fullscreen_live_ms)) : 0;
    const midiFor = (e) => {
        if (e.type === "pad") return [[[0x90, 68 + e.pad, e.vel || 100], e.t], [[0x80, 68 + e.pad, 0], e.t1 || e.t + 0.2]];
        if (e.type === "jog") { const d = Math.max(-63, Math.min(63, Math.round(e.dir || 1))); return [[[0xb0, 14, d > 0 ? d : 128 + d], e.t]]; }
        return [];
    };
    const midi = sc.events.flatMap(midiFor).sort((a, b) => a[1] - b[1]);
    let mi = 0;
    return {
        frame(target, f, t) {
            fb = target; ctxDraw = H.drawContext(target); frameIdx = f; nowMs = Math.round(t * 1000);
            if (!opened) { call("onOpen", { param_key: key, module_id: mod.id }); opened = true; while (mi < midi.length && midi[mi][1] < t) mi++; }
            while (mi < midi.length && midi[mi][1] <= t) { call("onMidi", { data: midi[mi][0] }); mi++; }
            if (liveMs && nowMs - lastLive >= liveMs) {
                lastLive = nowMs;
                const values = {};
                for (const k of liveKeys) values[k] = getParam(k);
                call("onValues", { values, nowMs });
            }
            call("tick", {});
            fb.fillRect(0, 0, 128, 64, 0);
            call("draw", {});
        },
    };
}

/* ---------------- cli ---------------- */
const [cmd, ...rest] = process.argv.slice(2);
if (cmd) {
    const ids = rest.includes("--all") ? contracts.map((c) => c.id) : rest.filter((a) => !a.startsWith("--"));
    const fn = { plan, score, film }[cmd];
    for (const id of ids) {
        const mod = byId[id];
        if (!mod) { console.error("unknown", id); continue; }
        try { console.log(id.padEnd(20), JSON.stringify(await fn(mod))); }
        catch (e) { console.error(`${id}: FAILED ${e.stack}`); }
    }
}
