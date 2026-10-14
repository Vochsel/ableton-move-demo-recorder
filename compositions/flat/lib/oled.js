/* oled.js — decode the filmed 1-bit OLED frames and draw them.
 *
 * window.OLED (from oled/<id>.js) holds base64 1-bit frames, 1024 bytes each.
 * Everything is a pure function of time, so any frame can be drawn on seek.
 */
(function () {
  const LIT = [236, 246, 255];      // Move's OLED: a cool white
  const DIM = [14, 16, 20];         // unlit pixel, faintly visible through the glass

  function loadModule(id) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "oled/" + id + ".js";
      s.onload = () => {
        const o = window.OLED;
        const bin = atob(o.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        o.bytes = bytes;
        resolve(o);
      };
      s.onerror = () => reject(new Error("missing oled/" + id + ".js"));
      document.head.appendChild(s);
    });
  }

  function frameAt(o, t) {
    return Math.max(0, Math.min(o.frames - 1, Math.floor(t * o.fps + 1e-6)));
  }

  /* Draw one frame as pixel cells: `scale` px per OLED pixel, `gap` px of
   * black between cells, so it reads as a physical panel rather than a blur.
   * A film that does not loop by construction (a module's own UI) dissolves
   * into its first frame over the last half second, so the video still loops. */
  function drawCells(ctx, o, t, scale, gap, brightness) {
    const k0 = brightness == null ? 1 : brightness;
    const XF = 0.5, end = o.frames / o.fps;
    if (!o.loop && t > end - XF) {
      const a = (t - (end - XF)) / XF;
      drawFrame(ctx, o, frameAt(o, t), scale, gap, k0 * (1 - a), true);
      ctx.globalCompositeOperation = "lighter";
      drawFrame(ctx, o, 0, scale, gap, k0 * a, false);
      ctx.globalCompositeOperation = "source-over";
      return;
    }
    drawFrame(ctx, o, frameAt(o, t), scale, gap, k0, true);
  }

  function drawFrame(ctx, o, f, scale, gap, k, clear) {
    const base = f * 1024, b = o.bytes;
    const W = 128 * scale, H = 64 * scale;
    if (clear) {
      ctx.fillStyle = `rgb(${DIM[0]},${DIM[1]},${DIM[2]})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.fillStyle = `rgb(${Math.round(LIT[0] * k)},${Math.round(LIT[1] * k)},${Math.round(LIT[2] * k)})`;
    const cell = scale - gap;
    for (let y = 0; y < 64; y++) {
      const row = base + y * 16;
      for (let x = 0; x < 128; x++) {
        if (b[row + (x >> 3)] & (0x80 >> (x & 7))) ctx.fillRect(x * scale + gap / 2, y * scale + gap / 2, cell, cell);
      }
    }
  }

  /* ---------- pads + steps: driven by the score's notes ---------- */
  const PALETTES = {
    sound_generator: [[185, 140, 255], [142, 166, 255]],
    audio_fx: [[95, 224, 192], [111, 182, 255]],
    midi_fx: [[255, 179, 71], [255, 122, 107]],
    overtake: [[255, 107, 213], [125, 125, 255]],
    tool: [[244, 228, 107], [122, 240, 160]],
    utility: [[207, 214, 221], [154, 165, 177]],
  };
  const WHITE = [236, 238, 242];

  /* index convention: 0 = bottom-left pad (note 68), row-major upward */
  function padState(o, t, ctype) {
    const pal = PALETTES[ctype] || PALETTES.utility;
    const pads = o.events.filter((e) => e.type === "pad");
    const split = pads.some((e) => e.part === "drums") && pads.some((e) => e.part && e.part !== "drums");
    if (!o._padIdx) {
      /* which pads the score ever touches -> their idle colour */
      o._used = new Set(pads.map((e) => e.pad));
      o._padIdx = true;
    }
    let leds = null;
    for (const e of o.events) { if (e.type !== "leds") continue; if (e.t <= t) leds = e; else break; }
    const out = [];
    for (let i = 0; i < 32; i++) {
      const col = i % 8;
      let base = split ? (col < 4 ? pal[0] : pal[1]) : (o._used.has(i) ? pal[0] : WHITE);
      let idle = o._used.has(i) ? 0.1 : 0.04;
      if (leds) {
        const L = leds.pads[i];
        if (L && (L[1] + L[2] + L[3]) > 0) { base = [L[1], L[2], L[3]]; idle = 0.55; }
      }
      out.push({ rgb: base, level: idle });
    }
    for (const e of pads) {
      if (t < e.t - 0.005) continue;
      const end = e.t1 || e.t + 0.15;
      const v = (e.vel || 100) / 127;
      let a;
      if (t <= end) a = v;
      else a = v * Math.exp(-(t - end) * 9);
      if (a < 0.01) continue;
      const p = out[e.pad];
      if (p) p.level = Math.max(p.level, 0.16 + a * 0.84);
    }
    /* a loop: notes from the end of the bar ring into frame 0 too */
    if (o.loop !== false) for (const e of pads) {
      const tt = t + o.frames / o.fps;
      const end = e.t1 || e.t + 0.15;
      if (tt > end && tt - end < 0.6) {
        const a = ((e.vel || 100) / 127) * Math.exp(-(tt - end) * 9);
        const p = out[e.pad]; if (p && a > 0.01) p.level = Math.max(p.level, 0.16 + a * 0.84);
      }
    }
    return out;
  }

  /* the 16 step LEDs: playhead at 120 BPM, plus steps carrying a note this bar */
  function stepState(o, t) {
    const STEP = 0.125, bar = Math.floor(t / 2), cur = Math.floor(t / STEP) % 16;
    const on = new Array(16).fill(0);
    for (const e of o.events) if (e.type === "pad" && Math.floor(e.t / 2) === bar) on[Math.floor((e.t % 2) / STEP + 1e-6) % 16] = 1;
    return on.map((v, i) => (i === cur ? 1 : v ? 0.35 : 0.06));
  }

  /* Events active at time t, for knob/jog/pad animation. */
  function knobState(o, t) {
    const touched = new Array(8).fill(0);
    const angle = new Array(8).fill(0);
    let jog = 0;
    for (const e of o.events) {
      if (e.type === "turn" && e.knob < 8 && t >= e.t) {
        const x = Math.min(1, (t - e.t) / Math.max(0.001, e.t1 - e.t));
        const s = 0.5 - 0.5 * Math.cos(Math.PI * x);
        angle[e.knob] += e.amount * s * Math.PI * 1.6;
      }
      if (e.type === "touch" && e.knob < 8) {
        const rel = o.events.find((r) => r.type === "release" && r.knob === e.knob && r.t > e.t);
        const end = rel ? rel.t : e.t + 1.5;
        if (t >= e.t - 0.12 && t < end + 0.25) {
          const a = Math.min(1, (t - (e.t - 0.12)) / 0.12), d = Math.min(1, (end + 0.25 - t) / 0.25);
          touched[e.knob] = Math.max(touched[e.knob], Math.min(a, d));
        }
      }
      if (e.type === "jog" && t >= e.t) jog += Math.min(1, (t - e.t) / 0.12) * (e.dir || 1);
    }
    return { touched, angle, jog };
  }

  window.OledLib = { loadModule, frameAt, drawCells, knobState, padState, stepState, PALETTES };
})();
