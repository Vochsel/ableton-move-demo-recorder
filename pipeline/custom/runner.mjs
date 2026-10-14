/**
 * runner.mjs — run one module's real UI script against a headless Move host.
 *
 *   node --import ./register.mjs runner.mjs <id> <ui-file> <out.json> [seconds]
 *
 * One module per process: UI scripts own globalThis, so they are never mixed.
 * Time is virtual (frame clock); Date.now / performance.now / Math.random are
 * replaced so a run is reproducible frame for frame.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scriptFor } from "./scripts.mjs";

import { fileURLToPath as __f2p } from "node:url";
import __path from "node:path";
const __ROOT = process.env.MDR_ROOT || __path.resolve(__path.dirname(__f2p(import.meta.url)), "../..");

const [id, uiFile, outFile, secsArg] = process.argv.slice(2);
const SECS = parseFloat(secsArg || "10.2");
/* Trace mode (film_custom.mjs --trace): reads are served from the module's
 * REAL DSP state, recorded per video frame by the offline host
 * (build/trace/<id>.jsonl); the contract strings come from the live probe
 * (build/contract/<id>.json); input is the score the audio actually plays
 * (build/score/<id>.json). PREROLL lets the UI settle (contract read, staggered
 * value reads) before frame 0, so the film starts on a settled screen and loops. */
const readJson = (p) => { try { return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null; } catch { return null; } };
const TRACE = (() => {
    const p = process.env.TRACE;
    if (!p || !fs.existsSync(p)) return null;
    const rows = [];
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); rows[o.f | 0] = o; } catch {}
    }
    for (let i = 1; i < rows.length; i++) if (!rows[i]) rows[i] = rows[i - 1];
    return rows.length ? rows : null;
})();
const CONTRACT = readJson(process.env.CONTRACT);
const PROBE = readJson(process.env.PROBE);
const SCORE = readJson(process.env.SCORE);
const DRIVE_SCORE = process.env.DRIVE_SCORE === "1";
const PREROLL = parseFloat(process.env.PREROLL || "0");
const FPS = 30;
/* Overtake/tool UIs tick on the audio block clock (~344/s, docs/API.md);
 * shadow_ui paces overtake mode at up to 500 Hz. */
let TICK_HZ = 344;
const NF = Math.round(SECS * FPS);

const H = await import(__ROOT + "/ref/schwung/tools/param-pages/harness.mjs");

/* ---- deterministic clock & dice ---- */
globalThis.__vtime = 0;
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const RealDate = Date;
class VDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(T0 + globalThis.__vtime * 1000); }
    static now() { return T0 + Math.floor(globalThis.__vtime * 1000); }
}
globalThis.Date = VDate;
globalThis.performance = { now: () => globalThis.__vtime * 1000 };
let seed = 0x9e3779b9 ^ [...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
Math.random = () => {
    seed += 0x6d2b79f5; let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const timers = [];
globalThis.setTimeout = (fn, ms) => { timers.push({ at: globalThis.__vtime + (ms || 0) / 1000, fn }); return timers.length; };
globalThis.clearTimeout = (h) => { if (timers[h - 1]) timers[h - 1].fn = null; };
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

/* ---- display ---- */
const fb = H.createFramebuffer();
const hctx = H.drawContext(fb);
const drawRect = (x, y, w, h, c) => {
    if (w <= 0 || h <= 0) return;
    fb.fillRect(x, y, w, 1, c); fb.fillRect(x, y + h - 1, w, 1, c);
    fb.fillRect(x, y, 1, h, c); fb.fillRect(x + w - 1, y, 1, h, c);
};
const G = globalThis;
G.clear_screen = () => fb.fillRect(0, 0, 128, 64, 0);
G.print = (x, y, text, color = 1) => fb.print(x, y, String(text ?? ""), color);
G.set_pixel = (x, y, v = 1) => fb.setPixel(x, y, v);
G.fill_rect = (x, y, w, h, v = 1) => fb.fillRect(x, y, w, h, v);
G.draw_rect = (x, y, w, h, v = 1) => drawRect(x, y, w, h, v);
G.text_width = (t) => fb.textWidth(String(t ?? ""));
G.line = hctx.line; G.draw_line = hctx.line;
G.fill_circle = hctx.fillCircle; G.draw_circle = hctx.drawCircle;
/* port of js_display_draw_arc (src/host/js_display.c) */
G.draw_arc = (cx, cy, r, start, sweep, value = 1) => {
    cx |= 0; cy |= 0; r |= 0;
    if (r < 0) return; if (r === 0) { fb.setPixel(cx, cy, value); return; }
    sweep = Math.min(360, sweep | 0); if (sweep <= 0) return;
    const st = (((start | 0) % 360) + 360) % 360;
    const plot = (dx, dy) => {
        if (sweep < 360) {
            let a = Math.atan2(dx, -dy) * 180 / Math.PI; if (a < 0) a += 360;
            let d = a - st; if (d < 0) d += 360; if (d > sweep) return;
        }
        fb.setPixel(cx + dx, cy + dy, value);
    };
    for (let dy = -r; dy <= r; dy++) { const dx = Math.floor(Math.sqrt(r * r - dy * dy) + 0.5); plot(dx, dy); if (dx) plot(-dx, dy); }
    for (let dx = -r; dx <= r; dx++) { const dy = Math.floor(Math.sqrt(r * r - dx * dx) + 0.5); plot(dx, dy); if (dy) plot(dx, -dy); }
};
G.draw_image = () => 0;
G.set_font = () => 0;
G.get_font_height = () => 8;
G.display = {
    clear: G.clear_screen, drawText: G.print, fillRect: G.fill_rect, drawRect: G.draw_rect,
    drawLine: hctx.line, setPixel: G.set_pixel, flush() {}, width: 128, height: 64,
};
G.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
const realErr = (...a) => process.stderr.write(a.join(" ") + "\n");

/* ---- LEDs ---- */
const padLed = new Array(32).fill(0);
let ledsDirty = false;
function onInternalSend(msg) {
    const a = Array.from(msg || []);
    const [type, status, note, value] = a.length >= 4 ? a : [0, a[0], a[1], a[2]];
    if (((status & 0xf0) === 0x90) && note >= 68 && note <= 99) {
        const i = note - 68;
        if (padLed[i] !== value) { padLed[i] = value; ledsDirty = true; }
    }
    return true;
}

/* ---- params & module script hooks ---- */
const vfs = new Map();
const vfsRead = (p) => {
    p = String(p);
    if (vfs.has(p)) { const v = vfs.get(p); return v === undefined ? null : v; }
    const f = script.file ? script.file(p, globalThis.__vtime) : undefined;
    if (f !== undefined && f !== null) return f;
    /* the module's own installed files, and the host's shared dir */
    let local = null;
    const m = /^\/data\/UserData\/(?:schwung|move-anything)\/modules\/(?:[^/]+\/)?([^/]+)\/(.+)$/.exec(p);
    if (m && m[1] === id) local = path.join(MODDIR, m[2]);
    const sh = /^\/data\/UserData\/schwung\/shared\/(.+)$/.exec(p);
    if (sh) local = path.join(__ROOT + "/ref/schwung/src/shared", sh[1]);
    if (local && fs.existsSync(local) && fs.statSync(local).isFile()) return fs.readFileSync(local, "utf8");
    return null;
};
const MODDIR = path.dirname(path.resolve(uiFile));
const store = Object.create(null);
const script = scriptFor(id);
if (script.tickHz) TICK_HZ = script.tickHz;
/* A DSP-served contract (pipeline/extract_so_contracts.py) answers the
 * hierarchy / params reads, and fake_values answers each param, exactly as
 * tools/param-pages previews do. */
const soPath = `${__ROOT}/data/so-contracts/${id}.json`;
const SO = fs.existsSync(soPath) ? JSON.parse(fs.readFileSync(soPath, "utf8")) : null;
const { fakeValue } = await import(__ROOT + "/ref/schwung/tools/param-pages/fake_values.mjs");
const cpByKey = new Map((SO?.chain_params || []).map((p) => [p.key, p]));
const CONTRACT_KEYS = new Set(["ui_hierarchy", "chain_params", "ui_pages"]);
const UI_STATE = /(^|_)(ui|focus|page|pages|select|selected|sel|view|cursor|current|cur|active|edit|lane|pad|voice)(_|$)/i;
const AUTOMATED = new Set(((SCORE && SCORE.automation) || []).map((a) => String(a.key).replace(/^[a-z0-9_]+:(?=[a-z])/i, "")));
const bareKey = (k) => k.replace(/^(synth|fx\d*|audio_fx\d*|midi_fx\d*|mfx\d*|master_fx\d*):/i, "").replace(/:effective$/, "");
const traceVal = (k) => {
    if (!TRACE) return undefined;
    const f = Math.max(0, Math.min(TRACE.length - 1, Math.floor((globalThis.__vtime - PREROLL) * FPS + 1e-6)));
    const row = TRACE[f];
    return row && row[k] !== undefined ? row[k] : undefined;
};
const getParam = (key) => {
    key = String(key);
    if (TRACE || CONTRACT) {
        const bare = bareKey(key);
        if (CONTRACT && CONTRACT_KEYS.has(bare)) {
            /* the chain host answers a key the plugin does not serve as served-and-empty */
            return CONTRACT[bare] !== undefined ? CONTRACT[bare] : "";
        }
        /* UI state the module writes itself (focus, page, selected pad...) never
         * reached the offline DSP, so its own write wins for keys the score does
         * not automate; everything the audio was driven by comes from the trace. */
        let v = traceVal(key); if (v === undefined) v = traceVal(bare);
        const uiState = v === undefined || UI_STATE.test(bare);
        if (uiState && !AUTOMATED.has(bare)) {
            if (key in store) return store[key];
            if (bare in store) return store[bare];
        }
        if (v !== undefined) return v;
    }
    if (script.param) { const v = script.param(key, Math.max(0, globalThis.__vtime - PREROLL), store); if (v !== undefined) return v; }
    if (PROBE) { const bare = bareKey(key); if (PROBE[key] !== undefined) return PROBE[key]; if (PROBE[bare] !== undefined) return PROBE[bare]; }
    if (key in store) return store[key];
    if (SO) {
        const bare = key.replace(/^[a-z0-9_]+:(?=[a-z])/i, "").replace(/:effective$/, "");
        if (bare in store) return store[bare];
        if (bare === "ui_hierarchy") return SO.ui_hierarchy ? JSON.stringify(SO.ui_hierarchy) : null;
        if (bare === "chain_params") return JSON.stringify(SO.chain_params || []);
        const p = cpByKey.get(bare);
        if (p) {
            const meta = { ...p, min: p.type === "enum" ? 0 : p.min, max: p.type === "enum" ? (p.options || []).length - 1 : p.max };
            return fakeValue(bare, meta);
        }
    }
    return null;
};
const setParam = (key, val) => { store[key] = String(val); return true; };

const used = new Set();
const STUB_RET = {
    host_module_get_param: (k) => getParam(k),
    host_module_set_param: setParam,
    host_module_set_param_blocking: setParam,
    shadow_get_param: (slot, k) => getParam(k),
    shadow_set_param: (slot, k, v) => setParam(k, v),
    shadow_set_param_timeout: (slot, k, v) => setParam(k, v),
    host_read_file: (p) => vfsRead(p),
    host_file_exists: (p) => vfsRead(p) != null,
    host_write_file: (p, data) => { vfs.set(String(p), String(data)); return true; },
    host_remove_file: (p) => { vfs.delete(String(p)); return true; },
    host_unlink: (p) => { vfs.delete(String(p)); return true; },
    host_ensure_dir: () => true,
    host_http_request_background: (o) => {
        /* answered later by the module script's fake server, like curl in the background */
        const r = script.http ? script.http(o, globalThis.__vtime) : null;
        if (!r) return false;
        timers.push({ at: globalThis.__vtime + (r.delay ?? 1.2), fn: () => {
            if (o.response_path) vfs.set(o.response_path, r.body ?? "");
            if (o.status_path) vfs.set(o.status_path, JSON.stringify({ http_status: r.status ?? 200, curl_exit: 0 }));
        } });
        return true;
    },
    move_midi_internal_send: onInternalSend,
    move_midi_external_send: () => true,
    move_midi_inject_to_move: () => true,
    host_speaker_active: () => true,
    host_line_in_connected: () => false,
    host_get_refresh_rate: () => 11,
    host_get_volume: () => 70,
    host_get_setting: () => null,
    host_is_module_loaded: () => true,
    host_get_current_module: () => ({ id }),
    host_get_module_metadata: () => null,
    host_list_modules: () => [],
    host_get_move_info: () => ({ tempo: 120, root: 0, scale: "Major", time_signature: [4, 4], playing: true }),
    host_sampler_is_recording: () => false,
    shadow_get_shift_held: () => false,
    shadow_get_display_mode: () => 1,
    shadow_get_ui_slot: () => 0,
    shadow_get_slots: () => [],
    shadow_get_move_ui_mode: () => 0,
    host_get_tempo: () => 120,
    host_get_bpm: () => 120,
    host_get_device_ip: () => "192.168.1.42",
};
Object.assign(STUB_RET, script.globals || {});
const PREFIX = /^(host_|shadow_|move_|js_|schwung_)/;
const stubProto = new Proxy(Object.getPrototypeOf(G), {
    has(t, k) { return (typeof k === "string" && PREFIX.test(k)) || Reflect.has(t, k); },
    get(t, k, r) {
        if (typeof k === "string" && PREFIX.test(k) && !Reflect.has(t, k)) {
            used.add(k);
            return STUB_RET[k] || (() => null);
        }
        return Reflect.get(t, k, r);
    },
});
Object.setPrototypeOf(G, stubProto);
for (const [k, fn] of Object.entries(STUB_RET)) G[k] = fn;
if (script.setup) script.setup(G, store);

/* ---- load the UI ---- */
let loadErr = null;
try { await import(pathToFileURL(path.resolve(uiFile)).href); }
catch (e) { loadErr = String(e && e.stack || e).split("\n").slice(0, 3).join(" | "); }

const cu = G.chain_ui;   /* chain-slot UIs register one object instead of globals */
const ui = cu ? { init: cu.init, tick: cu.tick, midi: cu.onMidiMessageInternal }
              : { init: G.init, tick: G.tick, midi: G.onMidiMessageInternal };
if (cu && !script.tickHz) TICK_HZ = 60;   /* the shadow UI's own 60 Hz loop */
const errs = [];
const safe = (what, fn) => { try { fn(); } catch (e) { if (errs.length < 8) errs.push(`${what}: ${String(e && e.message || e)}`); } };

/* ---- drive ---- */
/* The score's gestures as Move MIDI: pads (note 68+i), knob touch (note 0-7)
 * with relative turns on CC 71-78, the jog on CC 14. */
function scoreSchedule(score) {
    const out = [];
    let evs = score.events;
    if (!evs) {   // derive pads from notes when the score carries no gesture list
        evs = (score.notes || []).map((n) => {
            let pad = null;
            if (n.part === "drums") { const s = n.note - 36; if (s >= 0 && s < 16) pad = Math.floor(s / 4) * 8 + (s % 4); }
            else { let x = n.note; while (x < 48) x += 12; while (x > 70) x -= 12;
                   for (let r = 0; r < 4 && pad === null; r++) { const c = x - (48 + 5 * r); if (c >= 0 && c < 8) pad = r * 8 + c; } }
            return pad === null ? null : { t: n.t, t1: n.t1, type: "pad", pad, vel: n.vel, note: n.note };
        }).filter(Boolean);
    }
    for (const e of evs) {
        if (e.type === "pad" && e.pad >= 0 && e.pad < 32) {
            out.push({ t: e.t, msg: [0x90, 68 + e.pad, Math.max(1, Math.min(127, e.vel || 100))], ev: e });
            out.push({ t: Math.max(e.t + 0.02, e.t1 || e.t + 0.2), msg: [0x80, 68 + e.pad, 0] });
        } else if (e.type === "touch" && e.knob >= 0 && e.knob < 8) {
            out.push({ t: e.t, msg: [0x90, e.knob, 127], ev: e });
        } else if (e.type === "release" && e.knob >= 0 && e.knob < 8) {
            out.push({ t: e.t, msg: [0x80, e.knob, 0], ev: e });
        } else if (e.type === "turn" && e.knob >= 0 && e.knob < 8) {
            out.push({ t: e.t, ev: e });
            const n = Math.max(1, Math.round(Math.abs(e.amount || 0) * 64));
            const dur = Math.max(0.05, (e.t1 || e.t + 0.5) - e.t);
            for (let i = 0; i < n; i++) out.push({ t: e.t + (i + 0.5) * dur / n, msg: [0xb0, 71 + e.knob, (e.amount || 0) >= 0 ? 1 : 127] });
        } else if (e.type === "jog") {
            out.push({ t: e.t, ev: e });
            const n = Math.max(1, Math.abs(e.dir || 1));
            for (let i = 0; i < n; i++) out.push({ t: e.t + i * 0.04, msg: [0xb0, 14, (e.dir || 1) > 0 ? 1 : 127] });
        } else {
            out.push({ t: e.t, ev: e });
        }
    }
    return out;
}
const sched = (DRIVE_SCORE && SCORE) ? scoreSchedule(SCORE) : script.input();   // [{t, msg:[s,d1,d2]} | {t, ev:{...}} | {t, ext:[...]}]
if (script.external && !(DRIVE_SCORE && SCORE)) sched.push(...script.external());
for (const s of sched) s.t += PREROLL;
sched.sort((a, b) => a.t - b.t);
const frames = new Uint8Array(NF * 1024);
const events = [];
const ledEvents = [];
let si = 0, ticks = 0;
if (!loadErr && ui.init) safe("init", () => ui.init());
for (let f = -Math.round(PREROLL * FPS); f < NF; f++) {
    const t = f / FPS + PREROLL;   /* virtual time; frame 0 is at PREROLL */
    globalThis.__vtime = t;
    while (si < sched.length && sched[si].t <= t) {
        const s = sched[si++];
        if (s.ev) events.push(s.ev);   /* ev.t is already film time (schedule t carries the preroll) */
        if (s.msg && ui.midi) safe("midi", () => ui.midi(Uint8Array.from(s.msg)));
        if (s.ext && G.onMidiMessageExternal) safe("ext", () => G.onMidiMessageExternal(Uint8Array.from(s.ext)));
    }
    for (const tm of timers) if (tm.fn && tm.at <= t) { const fn = tm.fn; tm.fn = null; safe("timer", fn); }
    const want = Math.floor((t + 1 / FPS) * TICK_HZ);
    while (ticks < want) { ticks++; globalThis.__vtime = ticks / TICK_HZ; if (ui.tick) safe("tick", () => ui.tick()); }
    if (script.overlay) script.overlay(G, Math.max(0, t - PREROLL));
    if (f < 0) continue;   /* preroll: let the UI settle, record nothing */
    if (ledsDirty || (f === 0 && padLed.some((v) => v))) {
        ledsDirty = false;
        ledEvents.push({ t: t - PREROLL, pads: padLed.slice() });
    }
    const px = fb.pixels, base = f * 1024;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++)
        if (px[y * 128 + x]) frames[base + y * 16 + (x >> 3)] |= 0x80 >> (x & 7);
}
const evOut = events;
let lit = 0, changes = 0;
for (let f = 0; f < NF; f++) {
    for (let i = 0; i < 1024; i++) { const b = frames[f * 1024 + i]; if (b) lit += 1; }
    if (f && Buffer.compare(Buffer.from(frames.subarray(f * 1024, f * 1024 + 1024)), Buffer.from(frames.subarray((f - 1) * 1024, f * 1024)))) changes++;
}
fs.writeFileSync(outFile, JSON.stringify({
    id, loadErr, errs, used: [...used].sort(), hasUi: !!ui.tick, frames: Buffer.from(frames).toString("base64"),
    events: evOut, ledEvents, traced: !!TRACE, scoreDriven: !!(DRIVE_SCORE && SCORE),
    loopDiff: (() => { let d = 0; for (let i = 0; i < 1024; i++) { let x = frames[i] ^ frames[(NF - 1) * 1024 + i]; while (x) { d += x & 1; x >>= 1; } } return d; })(), litBytesAvg: lit / NF, changes, missing: [...fb.missingGlyphs].join(""),
}));
process.exit(0);
