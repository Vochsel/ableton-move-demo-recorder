// node sheet.mjs <run.json|oled.js> <out.png> [times...]  — contact sheet of frames (white cell borders)
import fs from "node:fs";
import { fileURLToPath as __f2p } from "node:url";
import __path from "node:path";
const __ROOT = process.env.MDR_ROOT || __path.resolve(__path.dirname(__f2p(import.meta.url)), "../..");

const H = await import(__ROOT + "/ref/schwung/tools/param-pages/harness.mjs");
const [inp, out, ...ts] = process.argv.slice(2);
let txt = fs.readFileSync(inp, "utf8");
let r = inp.endsWith(".js") ? JSON.parse(txt.slice(txt.indexOf("=") + 1).replace(/;\s*$/, "")) : JSON.parse(txt);
const data = Buffer.from(r.frames && typeof r.frames === "string" ? r.frames : r.data, "base64");
const nf = data.length / 1024;
const times = ts.length ? ts.map(Number) : [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5].filter((t) => t * 30 < nf);
const cols = 4, rows = Math.ceil(times.length / cols), CW = 132, CH = 68;
const fb = H.createFramebuffer(cols * CW, rows * CH);
times.forEach((t, i) => {
  const f = Math.min(nf - 1, Math.round(t * 30)), ox = (i % cols) * CW + 2, oy = Math.floor(i / cols) * CH + 2;
  fb.fillRect(ox - 1, oy - 1, 130, 1, 1); fb.fillRect(ox - 1, oy + 64, 130, 1, 1);
  fb.fillRect(ox - 1, oy - 1, 1, 66, 1); fb.fillRect(ox + 128, oy - 1, 1, 66, 1);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++)
    if (data[f * 1024 + y * 16 + (x >> 3)] & (0x80 >> (x & 7))) fb.setPixel(ox + x, oy + y, 1);
});
fs.writeFileSync(out, fb.toPng(2));
