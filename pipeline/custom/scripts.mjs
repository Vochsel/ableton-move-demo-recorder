/**
 * scripts.mjs — what the virtual hand does to each module, and what the
 * virtual DSP answers. Times are seconds from the moment the UI loads.
 */

const CC = 0xb0, ON = 0x90, OFF = 0x80;

/* builders: each returns schedule entries (MIDI + matching 3D-model event) */
export function jog(t, dir = 1) {
    return [{ t, msg: [CC, 14, dir > 0 ? 1 : 127], ev: { t, type: "jog", dir } }];
}
export function click(t) {
    return [{ t, msg: [CC, 3, 127], ev: { t, type: "click" } }, { t: t + 0.08, msg: [CC, 3, 0] }];
}
export function button(t, cc) {
    return [{ t, msg: [CC, cc, 127], ev: { t, type: "button", cc } }, { t: t + 0.1, msg: [CC, cc, 0] }];
}
export function knob(t, k, dur = 1.0, dir = 1, rate = 12) {
    const out = [{ t, msg: [ON, k, 127], ev: { t, type: "touch", knob: k } }];
    const n = Math.round(dur * rate);
    out.push({ t, ev: { t, t1: t + dur, type: "turn", knob: k, amount: dir * Math.min(1, n / 60) } });
    for (let i = 0; i < n; i++) out.push({ t: t + 0.02 + (i * dur) / n, msg: [CC, 71 + k, dir > 0 ? 1 : 127] });
    out.push({ t: t + dur + 0.25, msg: [OFF, k, 0], ev: { t: t + dur + 0.25, type: "release", knob: k } });
    return out;
}
export function pad(t, i, dur = 0.25, vel = 100) {
    return [{ t, msg: [ON, 68 + i, vel], ev: { t, t1: t + dur, type: "pad", pad: i } },
            { t: t + dur, msg: [OFF, 68 + i, 0] }];
}
export function step(t, i, dur = 0.15) {
    return [{ t, msg: [ON, 16 + i, 127], ev: { t, t1: t + dur, type: "step", step: i } },
            { t: t + dur, msg: [OFF, 16 + i, 0] }];
}
const flat = (...xs) => xs.flat();

/* Move's default pad layout is in fourths: pad (row r, col c) sounds
 * 9 + 5r + c semitones above C (bottom-left = A). Pick the lowest pad that
 * plays a given semitone, so scripted chords are real chords. */
export function padFor(semi) {
    for (let r = 0; r < 4; r++) { const c = semi - 9 - 5 * r; if (c >= 0 && c < 8) return r * 8 + c; }
    return Math.max(0, Math.min(31, semi - 9));
}
export function chord(t, semis, dur = 0.9) { return semis.flatMap((s) => pad(t, padFor(s), dur)); }

/* A generic session: browse, open, tweak two knobs, play the pads. */
export function defaultInput() {
    return flat(
        jog(0.5), jog(0.8), jog(1.1), click(1.6),
        knob(2.4, 0, 1.1, 1), knob(3.9, 2, 1.0, -1),
        pad(5.3, 0), pad(5.6, 4), pad(5.9, 9), pad(6.2, 13),
        pad(6.6, 16, 0.5), pad(6.6, 20, 0.5), pad(6.6, 23, 0.5),
        jog(7.6), jog(7.9), knob(8.3, 1, 1.0, 1), click(9.6),
    );
}

/* Pads-forward session for instruments / sequencers / games. */
function padSession() {
    const out = [];
    /* a C-major run, then a I-vi-IV-V of chords */
    [12, 14, 16, 17, 19, 21, 23, 24, 26, 28].forEach((s, i) => out.push(...pad(0.6 + i * 0.3, padFor(s), 0.22)));
    out.push(...knob(3.9, 0, 0.9, 1));
    [[12, 16, 19], [21, 24, 28], [17, 21, 24], [19, 23, 26]].forEach((c, i) => out.push(...chord(5.2 + i * 1.2, c, 0.9)));
    out.push(...knob(9.2, 3, 0.8, -1));
    return out;
}

/* A drum-loop-ish envelope: 8 hits per bar, decaying, with some texture. */
function loopAmp(x) {
    const beat = (x * 8) % 1, which = Math.floor(x * 8) % 8;
    const accent = [1, 0.45, 0.7, 0.4, 0.95, 0.5, 0.75, 0.55][which];
    return accent * Math.exp(-beat * 5) * (0.75 + 0.25 * Math.sin(x * 900)) + 0.04;
}
const AI_FILES = (dir) => (p, t) => {
    if (p === dir + "/cache/in.wav" && t > 1.6) return "RIFF....WAVEfmt ";
    if (p === dir + "/config.json") return JSON.stringify({ provider: "openai", openai_model: "gpt-4o-mini" });
    if (p === dir + "/secrets/openai_api_key.txt") return "sk-demo";
    return undefined;
};
const AI_HTTP = (q, a) => (o) => {
    const url = String(o.url || "");
    if (/generate_204|probe|google/.test(url) || /probe/.test(String(o.status_path || ""))) return { status: 204, body: "", delay: 0.3 };
    if (/audio\/transcriptions|stt/i.test(url) || /stt/.test(String(o.status_path || ""))) return { body: JSON.stringify({ text: q }), delay: 0.9 };
    return { body: JSON.stringify({ choices: [{ message: { content: a } }] }), delay: 1.6 };
};

/* Per-module tweaks. `param(key, t, store)` answers host_module_get_param. */
const S = {
    "guitar-tuner": {
        input: () => [],
        param: (k, t) => {
            /* a plucked string drifting into tune: A2 -> in tune -> D3 */
            const notes = [["A", 2, 110.0], ["D", 3, 146.83], ["G", 3, 196.0]];
            const n = notes[Math.min(2, Math.floor(t / 3.4))];
            const local = t % 3.4;
            const cents = Math.round(38 * Math.exp(-local * 1.3) * Math.cos(local * 3));
            const env = Math.exp(-local * 0.5);
            const midi = [45, 50, 55][Math.min(2, Math.floor(t / 3.4))];
            if (k === "freq_hz") return (n[2] * Math.pow(2, cents / 1200)).toFixed(2);
            if (k === "cents_off") return String(cents);
            if (k === "midi_note") return String(midi);
            if (k === "confidence") return local < 3.0 ? "0.9" : "0";
            if (k === "peak") return String(Math.round(env * 20000));
            if (k === "rms") return (env * 0.3).toFixed(3);
            return undefined;
        },
    },
    "waveform-editor": {
        globals: { host_tool_file_path: "/data/UserData/UserLibrary/Samples/Break 170.wav" },
        setup: (G) => { G.host_tool_file_path = "/data/UserData/UserLibrary/Samples/Break 170.wav"; },
        input: () => flat(knob(0.8, 0, 1.2, 1), knob(2.6, 1, 1.2, -1), knob(4.4, 2, 1.0, 1), jog(6.0), jog(6.3), knob(6.8, 0, 1.0, -1), pad(8.4, 0, 0.8)),
        param: (k) => {
            const FR = 124416;
            if (k === "file_info") return JSON.stringify({ name: "Break 170.wav", duration: FR / 44100, frames: FR, start: 0, end: FR });
            if (k === "sample_rate") return "44100";
            if (k === "file_path") return "/data/UserData/UserLibrary/Samples/Break 170.wav";
            const m = /^(seam_)?waveform:(\d+),(\d+)/.exec(k);
            if (m) {
                const a = +m[2], b = +m[3], n = 128, out = [];
                for (let i = 0; i < n; i++) {
                    const x = (a + (b - a) * (i + 0.5) / n) / FR, amp = Math.min(1, loopAmp(x));
                    out.push([-(amp * (0.9 + 0.1 * Math.cos(i))).toFixed(3) * 1, +(amp).toFixed(3)]);
                }
                return JSON.stringify(out);
            }
            return undefined;
        },
    },
    movy: {
        param: (k, t) => {
            if (k === "ping") return "pong 0.85.0";
            if (k === "status") { const tick = Math.floor(t * 96 * 2); return `play=1 tick=${tick} bpm=12400 trk=0 step=${Math.floor(t * 8) % 16} len=16 lstart=0 chpend=0 chgen=1 sapl=1`; }
            return undefined;
        },
        input: () => flat(knob(1.2, 0, 1.0, 1), knob(2.6, 3, 1.0, -1), step(4.0, 0), step(4.2, 4), step(4.4, 8), step(4.6, 12),
                          pad(5.2, 0), pad(5.6, 2), pad(6.0, 4), jog(6.8), jog(7.2), knob(7.8, 5, 1.0, 1), knob(9.0, 1, 0.8, -1)),
    },
    "ai-manual": {
        file: AI_FILES("/data/UserData/schwung/modules/tools/ai-manual"),
        http: AI_HTTP("How do I open Master FX?", JSON.stringify({ short: "Shift+Vol, then Menu", detailed: "Hold Shift and the Volume knob, then press Menu. You can also long-press Menu on its own." })),
        input: () => pad(1.2, 0, 2.2),
    },
    "ai-assistant": {
        file: AI_FILES("/data/UserData/schwung/modules/tools/ai-assistant"),
        http: AI_HTTP("Give me a chord progression for a sad house track", "Try Am - F - C - G at 122 BPM. Voice the F as Fmaj7 and let the G resolve up to Am on the downbeat."),
        input: () => pad(1.2, 0, 2.2),
    },
    arranger: { input: () => flat(jog(0.8), jog(1.6), jog(2.4), jog(3.2), jog(4.0, -1), jog(4.8, -1), jog(5.6, -1), jog(6.4), jog(7.2), jog(8.0, -1)) },
    dj: { input: () => flat(knob(0.8, 0, 1.0, 1), knob(2.2, 7, 1.2, -1), pad(3.8, 24, 0.3), pad(4.4, 28, 0.3), knob(5.2, 4, 1.4, 1), knob(7.0, 3, 1.0, -1), pad(8.6, 24, 0.3)) },
    mono: { input: () => flat(knob(0.8, 0, 1.0, 1), knob(2.2, 1, 1.0, 1), knob(3.6, 2, 0.9, -1), step(5.0, 0), step(5.2, 2), step(5.4, 4), step(5.6, 6), padSession().filter((e) => e.t > 6.2 && e.t < 9.8)) },
    "piano-practice": { input: () => {
        const o = flat(click(0.6), click(1.2), button(1.7, 51), button(2.1, 86));
        const sc = [12, 14, 16, 17, 19, 21, 23, 24, 23, 21, 19, 17, 14, 12];
        sc.forEach((sm, i) => o.push(...pad(2.6 + i * 0.5, padFor(sm), 0.4)));
        return o;
    } },
    "drums-practice": { input: () => {
        const o = flat(click(0.6), click(1.1), click(1.6), button(2.1, 86));
        for (let i = 0; i < 15; i++) o.push(...pad(2.8 + i * 0.5, [0, 2, 1, 2][i % 4], 0.15));
        return o;
    } },
    "kit-builder": { input: () => flat(pad(0.6, 0, 0.3), knob(1.2, 0, 1.0, 1), pad(2.6, 1, 0.3), knob(3.1, 1, 1.0, -1), pad(4.4, 2, 0.3), pad(4.9, 3, 0.3),
                                        knob(5.5, 2, 1.0, 1), pad(7.0, 8, 0.3), pad(7.4, 9, 0.3), pad(7.8, 10, 0.3), knob(8.4, 0, 1.0, -1)) },
    m8: {
        /* the M8 handshake, then the M8 painting its Launchpad grid like a song playing */
        external: () => {
            const o = [{ t: 0.4, ext: [0xf0, 0x7e, 0x7f] }, { t: 0.4, ext: [0x06, 0x01, 0xf7] }];
            const pal = [5, 9, 13, 21, 37, 45, 49, 53];
            for (let k = 0; k < 36; k++) {
                const t = 0.8 + k * 0.25, col = k % 8;
                for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
                    const on = c === col ? 3 : ((r * 3 + c * 5 + k) % 7 === 0 ? pal[(r + c) % 8] : ((r + c) % 5 === 0 ? 1 : 0));
                    o.push({ t, ext: [0x90, (r + 1) * 10 + (c + 1), on] });
                }
            }
            return o;
        },
        input: () => flat(pad(3.0, 4), pad(3.4, 9), pad(3.8, 18), jog(5.0), pad(6.0, 2), pad(6.3, 3), pad(7.5, 20, 0.6)),
    },
    "move-bitwig": {
        external: () => {
            const H = [0x7d, 0x4d, 0x42];
            const sx = (t, cmd, payload) => ({ t, ext: [0xf0, ...H, cmd, ...payload, 0xf7] });
            const txt = (t, line, s) => sx(t, 0x01, [line, ...[...s].map((c) => c.charCodeAt(0))]);
            const o = [sx(0.5, 0x7e, [2])];
            const pages = [
                ["1 Bass > Polymer", "Cut  Res  Env  Drv", "62%  18%  40%  12%", "Remote 1/4  Filter"],
                ["1 Bass > Polymer", "Cut  Res  Env  Drv", "71%  18%  40%  12%", "Remote 1/4  Filter"],
                ["2 Drums > Kit", "Kick Snr  Hat  Clp", "80%  65%  52%  44%", "Remote 1/2  Levels"],
                ["3 Keys > Phase-4", "Shp  Mod  Rate Mix", "33%  58%  1/8  70%", "Remote 2/3  Osc"],
            ];
            pages.forEach((pg, i) => pg.forEach((l, j) => o.push(txt(0.7 + i * 2.4, j, l))));
            /* clip launcher colours on the pads */
            const cols = [[127, 40, 20], [20, 90, 127], [40, 127, 60], [127, 110, 20]];
            const led = [];
            for (let i = 0; i < 32; i++) { const c = cols[Math.floor(i / 8)]; if ((i * 7) % 5 !== 0) led.push(68 + i, ...c); }
            o.push(sx(0.9, 0x04, led));
            return o;
        },
        input: () => flat(knob(1.6, 0, 1.2, 1), pad(3.4, 8), pad(3.9, 16), jog(5.6), knob(6.4, 1, 1.0, -1), jog(8.0), pad(8.8, 24)),
    },
    snake: { input: () => {
        const o = [];
        const dirs = [63, 55, 62, 54, 63, 55, 62, 54];   // arrows: right, up, left, down
        o.push(...button(0.4, 85));
        dirs.forEach((cc, i) => o.push(...button(1.2 + i * 1.1, cc)));
        return o;
    } },
    chorddex: { input: () => {
        const o = [];
        const chords = [[12, 16, 19], [21, 24, 28], [17, 21, 24, 28], [19, 23, 26, 29]];
        chords.forEach((c, i) => o.push(...chord(0.6 + i * 2.3, c, 1.9)));
        return o;
    } },

    "drums-practice-old": { input: () => {
        const o = click(0.5);
        for (let i = 0; i < 16; i++) o.push(...pad(1.2 + i * 0.5, [0, 2, 1, 2][i % 4], 0.15));
        return o;
    } },
    tb3po: { input: () => flat(button(0.4, 85), padSession()) },
    "maze_seq": { input: () => flat(button(0.4, 85), padSession()) },
    oktonik: { input: padSession },
    "chord-finder": { input: () => flat(knob(0.6, 0, 1.0, 1), jog(2.0), jog(2.3), click(2.8), padSession().map((e) => ({ ...e, t: e.t + 2.2 })).filter((e) => e.t < 10)) },
};

export function scriptFor(id) {
    const s = S[id] || {};
    return { input: s.input || defaultInput, external: s.external, param: s.param, file: s.file, http: s.http, globals: s.globals, tickHz: s.tickHz, setup: s.setup, overlay: s.overlay };
}
