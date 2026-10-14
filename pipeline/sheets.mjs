#!/usr/bin/env node
/* sheets.mjs — one contact sheet per module: 6 OLED frames across the loop, with
 * a caption of what the score is doing at each (page, knob turn, notes).
 *   node pipeline/sheets.mjs [ids...] -> build/audit/sheets/<id>.png */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const H = await import(path.join(ROOT, "ref/schwung/tools/param-pages/harness.mjs"));
const OUT = path.join(ROOT, "build", "audit", "sheets");
fs.mkdirSync(OUT, { recursive: true });
const contracts = JSON.parse(fs.readFileSync(path.join(ROOT, "data/contracts.json"), "utf8"));
const ids = process.argv.slice(2).length ? process.argv.slice(2) : contracts.map((c) => c.id);
const TIMES = [0.5, 2.5, 4.5, 6.5, 8.5, 10.5];
for (const id of ids) {
    const p = path.join(ROOT, "build/oled", `${id}.js`);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, "utf8");
    const o = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
    const b = Buffer.from(o.data, "base64");
    const tmp = path.join(OUT, `.${id}`);
    fs.mkdirSync(tmp, { recursive: true });
    const inputs = [];
    for (const t of TIMES) {
        const f = Math.min(o.frames - 1, Math.round(t * 30)), fb = H.createFramebuffer();
        for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) if (b[f * 1024 + y * 16 + (x >> 3)] & (0x80 >> (x & 7))) fb.fillRect(x, y, 1, 1, 1);
        const file = path.join(tmp, `${t}.png`);
        fs.writeFileSync(file, fb.toPng(3));
        const turn = (o.events || []).find((e) => e.type === "turn" && t >= e.t && t <= (e.t1 || e.t) + 0.6);
        const notes = (o.events || []).filter((e) => e.type === "pad" && Math.abs(e.t - t) < 0.5).length;
        const label = `t=${t}s ${turn ? "turn knob" + (turn.knob + 1) + (turn.key ? " " + turn.key : "") : ""} ${notes ? notes + " notes" : ""}`.replace(/'/g, "");
        inputs.push(["-i", file, label]);
    }
    const filters = inputs.map((x, k) => `[${k}]pad=384:216:0:24:gray,drawtext=text='${x[2].replace(/:/g, "\\:")}':x=4:y=4:fontsize=14:fontcolor=white[v${k}]`).join(";");
    const stack = inputs.map((_, k) => `[v${k}]`).join("") + `xstack=inputs=6:layout=0_0|384_0|768_0|0_216|384_216|768_216[o]`;
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...inputs.flatMap((x) => [x[0], x[1]]), "-filter_complex", `${filters};${stack}`, "-map", "[o]", path.join(OUT, `${id}.png`)]);
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("sheets:", fs.readdirSync(OUT).filter((f) => f.endsWith(".png")).length);
