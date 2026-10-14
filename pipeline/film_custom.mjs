#!/usr/bin/env node
/**
 * film_custom.mjs — film the catalog modules that draw their OWN screen
 * (tools, overtakes, chain UIs), or whose parameter contract is only served by
 * their DSP at runtime.
 *
 *   node pipeline/film_custom.mjs <id> [<id> ...]
 *   node pipeline/film_custom.mjs --all-none      every contracts.json module with source "none"
 *
 * Three ways in, best first:
 *   module-ui    the module's real ui.js / ui_chain.js runs against a headless
 *                Move host (pipeline/custom/runner.mjs), driven by a scripted
 *                hand (pipeline/custom/scripts.mjs)
 *   param-pages  the contract was recovered from the DSP binary
 *                (pipeline/extract_so_contracts.py) and filmed by film.mjs
 *   info         neither is possible: a name / description / author card in
 *                the host's own header + footer chrome
 * Every film opens with the real picker scrolling to the module (1.8s).
 *
 * Output: build/oled/<id>.js in film.mjs's format, plus `kind` and, for the
 * module-ui films, `leds` events: {t, type:"leds", pads:[[idx,r,g,b] x32]}
 * (absolute pad colours, idx 0 = bottom-left pad, note 68) and `pad` / `step`
 * / `button` events alongside jog / click / touch / turn / release.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCH = path.join(ROOT, "ref", "schwung");
const OUT = path.join(ROOT, "build", "oled");
const H = await import(path.join(SCH, "tools/param-pages/harness.mjs"));
const { drawChainPicker } = await import(path.join(SCH, "src/shared/chain_editor_chrome.mjs"));
const ML = await import(path.join(SCH, "src/shared/menu_layout.mjs"));
/* film.mjs runs its own CLI when it sees arguments; hide ours while importing. */
const ARGV = process.argv.slice(2);
process.argv.length = 2;
const { film } = await import(path.join(ROOT, "pipeline", "film.mjs"));

const FPS = 30, DURATION = 12, NF = FPS * DURATION, PICKER_END = ARGV.includes("--trace") ? 0 : +(process.env.PICKER_END ?? 1.8);
const PICKER_F = Math.round(PICKER_END * FPS);
const contracts = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "contracts.json"), "utf8"));
for (const c of contracts) if (c.module_dir && !path.isAbsolute(c.module_dir)) c.module_dir = path.join(ROOT, c.module_dir);   // stored relative to the workspace
const PALETTE = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "led-palette.json"), "utf8"));

/* Modules filmed through their DSP-recovered contract with the host's own
 * param-page renderer. (cw78 / sophie ship a ui_chain.js too, but it needs a
 * newer host than the snapshot here and only reports "unsupported page".) */
const VIA_CONTRACT = new Set(["cw78", "sophie", "clementine-xt", "trance-gate"]);

const SLOT_HEADER = {
    sound_generator: "S1 > Synth", audio_fx: "S1 > FX1", midi_fx: "S1 > MIDI FX",
    overtake: "Tools", tool: "Tools", utility: "Tools",
};

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

/* Same picker as film.mjs: the real chain picker, cursor stepping down to the module. */
function pickerPlan(mod) {
    const peers = contracts
        .filter((m) => SLOT_HEADER[m.component_type] === SLOT_HEADER[mod.component_type])
        .map((m) => ({ id: m.id, name: m.name }))
        .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
    const at = peers.findIndex((p) => p.id === mod.id);
    const start = Math.max(0, at - 5);
    const entries = [{ id: "__list_filter__", name: "List", value: "All", clickVerb: "LIST" }];
    if (start === 0) entries.push({ id: "", name: "None" });
    for (const p of peers.slice(start, Math.min(peers.length, at + 4))) entries.push(p);
    const target = entries.findIndex((e) => e.id === mod.id);
    const from = Math.max(1, target - 5);
    return { entries, target, from };
}

function filmPicker(mod, frames, events) {
    const { entries, target, from } = pickerPlan(mod);
    const stepEvery = 0.18, steps = target - from;
    const clickAt = Math.min(PICKER_END - 0.2, 0.35 + steps * stepEvery + 0.25);
    for (let s = 1; s <= steps; s++) events.push({ t: 0.35 + s * stepEvery, type: "jog", dir: 1 });
    events.push({ t: clickAt, type: "click" });
    for (let f = 0; f < PICKER_F; f++) {
        const t = f / FPS, fb = H.createFramebuffer();
        bindGlobals(fb); clear_screen();
        const k = Math.max(0, Math.min(steps, Math.floor((t - 0.35) / stepEvery)));
        drawChainPicker({ fillRect: fb.fillRect, print: fb.print, textWidth: fb.textWidth }, {
            headerLeft: SLOT_HEADER[mod.component_type] || "Tools",
            entries, index: t < 0.35 ? from : from + k, currentId: t >= clickAt ? mod.id : null,
            emptyMessage: "No modules available",
        });
        pack(fb, frames, f);
    }
}

function pack(fb, frames, f) {
    const px = fb.pixels, base = f * 1024;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++)
        if (px[y * 128 + x]) frames[base + y * 16 + (x >> 3)] |= 0x80 >> (x & 7);
}

const rgb = (idx) => {
    for (let i = idx | 0; i >= 0; i--) if (PALETTE[i]) {
        const h = PALETTE[i];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return [0, 0, 0];
};

function uiEntry(id) {
    const d = path.join(ROOT, "ref", "modules", id, id);
    if (!fs.existsSync(d)) return null;
    let m = {};
    try { m = JSON.parse(fs.readFileSync(path.join(d, "module.json"), "utf8")); } catch {}
    const cands = [m.ui, "ui.js", "ui_overtake.js", m.ui_chain, "ui_chain.js"].filter(Boolean);
    for (const f of cands) if (fs.existsSync(path.join(d, f))) return path.join(d, f);
    return null;
}

/* The info card: the host's header and footer, the catalog description wrapped
 * in the device font, the author on the last line. */
function filmInfo(mod, frames) {
    const fb0 = H.createFramebuffer();
    const words = String(mod.description || "").split(/\s+/).filter(Boolean);
    const lines = []; let cur = "";
    for (const w of words) {
        const next = cur ? cur + " " + w : w;
        if (fb0.textWidth(next) <= 122) cur = next; else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    const rows = 4, lineH = 9, top = 13;
    const overflow = Math.max(0, lines.length - rows);
    for (let f = PICKER_F; f < NF; f++) {
        const t = f / FPS - PICKER_END, fb = H.createFramebuffer();
        bindGlobals(fb); clear_screen();
        ML.drawMenuHeader(mod.name, mod.version ? "v" + mod.version : "");
        /* long descriptions scroll a row at a time, the way a help page reads */
        const off = overflow ? Math.min(overflow, Math.max(0, Math.floor((t - 2.2) / 1.6))) : 0;
        lines.slice(off, off + rows).forEach((l, i) => fb.print(3, top + i * lineH, l, 1));
        ML.drawMenuFooter([`BY: ${String(mod.author || "").slice(0, 18)}`]);
        pack(fb, frames, f);
    }
}

function write(mod, frames, events, extra) {
    fs.mkdirSync(OUT, { recursive: true });
    events.sort((a, b) => a.t - b.t);
    const payload = {
        id: mod.id, fps: FPS, frames: NF, w: 128, h: 64,
        events, pages: extra.pages || [], hasPages: !!extra.hasPages, kind: extra.kind,
        ...(extra.loop !== undefined ? { loop: extra.loop } : {}),
        ...(extra.traced !== undefined ? { traced: extra.traced } : {}),
        data: Buffer.from(frames).toString("base64"),
    };
    fs.writeFileSync(path.join(OUT, `${mod.id}.js`), `window.OLED=${JSON.stringify(payload)};\n`);
}

function filmOne(id) {
    const mod = contracts.find((m) => m.id === id);
    if (!mod) throw new Error("unknown module " + id);
    const soPath = path.join(ROOT, "data", "so-contracts", `${id}.json`);

    if (VIA_CONTRACT.has(id) && fs.existsSync(soPath)) {
        const so = JSON.parse(fs.readFileSync(soPath, "utf8"));
        const res = film({ ...mod, ...so, source: "dsp" });
        write(mod, res.frames, res.events, { pages: res.pages, hasPages: res.hasPages, kind: "param-pages" });
        return { id, kind: "param-pages", note: res.pages.map((p) => p.name).join(" / ") };
    }

    const frames = new Uint8Array(NF * 1024);
    const events = [];
    if (PICKER_END > 0) filmPicker(mod, frames, events);

    const entry = uiEntry(id);
    if (entry) {
        const tmp = path.join(os.tmpdir(), `oled-${id}-${process.pid}.json`);
        try {
            execFileSync(process.execPath, ["--import", "./register.mjs", "runner.mjs", id, entry, tmp, String(DURATION - PICKER_END)],
                         { cwd: path.join(ROOT, "pipeline", "custom"), stdio: ["ignore", "ignore", "pipe"], timeout: 300000 });
            const r = JSON.parse(fs.readFileSync(tmp, "utf8"));
            fs.unlinkSync(tmp);
            const body = Buffer.from(r.frames, "base64");
            if (!r.loadErr && r.hasUi && r.litBytesAvg > 8) {
                body.copy(Buffer.from(frames.buffer), PICKER_F * 1024, 0, Math.min(body.length, (NF - PICKER_F) * 1024));
                for (const e of r.events) {
                    const o = { ...e, t: +(e.t + PICKER_END).toFixed(3) };
                    if (e.t1 !== undefined) o.t1 = +(e.t1 + PICKER_END).toFixed(3);
                    events.push(o);
                }
                for (const l of r.ledEvents) events.push({
                    t: +(l.t + PICKER_END).toFixed(3), type: "leds",
                    pads: l.pads.map((c, i) => [i, ...rgb(c)]),
                });
                write(mod, frames, events, { kind: "module-ui", pages: [{ name: "Module UI", t0: PICKER_END, t1: DURATION }] });
                return { id, kind: "module-ui", note: `${path.basename(entry)} chg=${r.changes} leds=${r.ledEvents.length}` + (r.errs.length ? ` errs=${r.errs.length}` : "") };
            }
            var why = r.loadErr ? "load error" : !r.hasUi ? "no tick()" : "blank screen";
        } catch (e) {
            var why = "runner failed: " + String(e.message).split("\n")[0];
        }
    }
    filmInfo(mod, frames);
    write(mod, frames, events, { kind: "info" });
    return { id, kind: "info", note: entry ? why : "no UI script in release (DSP-only / standalone binary)" };
}

/* ---------------------------------------------------------------------------
 * --trace: film a module's own screen against its REAL DSP state.
 *
 * Reads are served from build/trace/<id>.jsonl (the offline host reads every
 * key back from the running dsp.so once per video frame of the kept loop), the
 * contract strings from build/contract/<id>.json, and a chain module is played
 * the score its audio is rendered from (build/score/<id>.json): pads, knob
 * touches/turns and the jog become Move MIDI into its ui_chain.js. Tools and
 * overtakes keep their scripted sessions (they are not chain slots), with the
 * trace served when one exists. No picker; 3 s of preroll so the screen is
 * settled at frame 0.
 */
const CHAIN_TYPES = new Set(["sound_generator", "audio_fx", "midi_fx"]);
const B = (...p) => path.join(ROOT, "build", ...p);

function uiEntryFor(mod) {
    const dirs = [mod.module_dir, path.join(ROOT, "ref", "modules", mod.id, mod.id)].filter((d) => d && fs.existsSync(d));
    for (const d of dirs) {
        let m = {};
        try { m = JSON.parse(fs.readFileSync(path.join(d, "module.json"), "utf8")); } catch {}
        const cands = CHAIN_TYPES.has(mod.component_type)
            ? [m.ui_chain, "ui_chain.js", m.ui, "ui.js"]                    /* what the shadow UI loads for a chain slot */
            : [m.ui, "ui.js", "ui_overtake.js", m.ui_chain, "ui_chain.js"];
        for (const f of cands.filter(Boolean)) if (fs.existsSync(path.join(d, f))) return path.join(d, f);
    }
    return null;
}

function filmTraced(id) {
    const mod = contracts.find((m) => m.id === id);
    if (!mod) throw new Error("unknown module " + id);
    const frames = new Uint8Array(NF * 1024);
    const entry = uiEntryFor(mod);
    const trace = B("trace", `${id}.jsonl`), score = B("score", `${id}.json`);
    const hasTrace = fs.existsSync(trace), hasScore = fs.existsSync(score);
    const drive = CHAIN_TYPES.has(mod.component_type) && hasScore;
    if (entry) {
        const tmp = path.join(os.tmpdir(), `oled-${id}-${process.pid}.json`);
        try {
            execFileSync(process.execPath, ["--import", "./register.mjs", "runner.mjs", id, entry, tmp, String(DURATION)], {
                cwd: path.join(ROOT, "pipeline", "custom"), stdio: ["ignore", "ignore", "pipe"], timeout: 600000,
                env: { ...process.env, TRACE: hasTrace ? trace : "", SCORE: hasScore ? score : "",
                       CONTRACT: B("contract", `${id}.json`), PROBE: B("probe", `${id}.json`),
                       DRIVE_SCORE: drive ? "1" : "0", PREROLL: process.env.PREROLL || "3" },
            });
            const r = JSON.parse(fs.readFileSync(tmp, "utf8"));
            fs.unlinkSync(tmp);
            if (!r.loadErr && r.hasUi && r.litBytesAvg > 8) {
                Buffer.from(r.frames, "base64").copy(Buffer.from(frames.buffer), 0, 0, NF * 1024);
                const events = r.events.slice();
                for (const l of r.ledEvents) events.push({ t: +l.t.toFixed(3), type: "leds", pads: l.pads.map((c, i) => [i, ...rgb(c)]) });
                const loop = r.loopDiff < 48;
                write(mod, frames, events, { kind: "module-ui", loop, traced: !!r.traced,
                                             pages: [{ name: "Module UI", t0: 0, t1: DURATION }] });
                return { id, kind: "module-ui", traced: r.traced, scoreDriven: r.scoreDriven, loop,
                         note: `${path.basename(entry)} chg=${r.changes} loopDiff=${r.loopDiff} leds=${r.ledEvents.length}` + (r.errs.length ? ` errs=${r.errs.length}: ${r.errs[0]}` : "") };
            }
            var why = r.loadErr ? "load error: " + r.loadErr : !r.hasUi ? "no tick()" : `blank screen (lit ${r.litBytesAvg.toFixed(1)})` + (r.errs.length ? ` errs: ${r.errs[0]}` : "");
        } catch (e) {
            var why = "runner failed: " + String(e.message).split("\n")[0];
        }
    }
    filmInfo(mod, frames);
    write(mod, frames, [], { kind: "info", loop: true });
    return { id, kind: "info", note: entry ? why : "no UI script in release" };
}

const argv = ARGV;
if (argv.includes("--trace")) {
    const tids = argv.filter((a) => !a.startsWith("--"));
    const list = tids.length ? tids : contracts.filter((m) => m.screen === "module-ui").map((m) => m.id);
    const rp = B("film_trace_report.json");
    const report = fs.existsSync(rp) ? Object.fromEntries(JSON.parse(fs.readFileSync(rp, "utf8")).map((r) => [r.id, r])) : {};
    for (const id of list) {
        const t0 = Date.now();
        let r;
        try { r = filmTraced(id); } catch (e) { r = { id, kind: "FAILED", note: e.message }; }
        report[id] = r;
        console.log(`${id.padEnd(16)} ${r.kind.padEnd(10)} trace=${r.traced ? "y" : "n"} score=${r.scoreDriven ? "y" : "n"} loop=${r.loop ? "y" : "n"} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${r.note || ""}`);
    }
    /* separate from film_custom_report.json on purpose: that file's ids are read
     * as "custom" (stand-in audio) by demo.mjs; chain modules must keep their DSP */
    fs.writeFileSync(rp, JSON.stringify(Object.values(report), null, 1));
    process.exit(0);
}
const ids = argv.includes("--all-none")
    ? contracts.filter((m) => m.source === "none").map((m) => m.id)
    : argv.filter((a) => !a.startsWith("--"));
const report = [];
for (const id of ids) {
    const t0 = Date.now();
    let r;
    try { r = filmOne(id); } catch (e) { r = { id, kind: "FAILED", note: e.message }; }
    report.push(r);
    console.log(`${id.padEnd(16)} ${r.kind.padEnd(12)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${r.note || ""}`);
}
fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "build", "film_custom_report.json"), JSON.stringify(report, null, 1));
