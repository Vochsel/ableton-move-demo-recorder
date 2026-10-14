import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath as __f2p } from "node:url";
import __path from "node:path";
const __ROOT = process.env.MDR_ROOT || __path.resolve(__path.dirname(__f2p(import.meta.url)), "../..");

register("./loader.mjs", pathToFileURL(__ROOT + "/pipeline/custom/"));
