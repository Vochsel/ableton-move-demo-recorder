# Troubleshooting

Every trap from the catalog run, with its fix. Most are already handled in the pipeline; they're here so nobody undoes the fix.

| symptom | cause | fix |
|---|---|---|
| a module is silent, but its probe works | it expects files at an absolute on-device path | mount the module at `/data/UserData/schwung/modules/<cat>/<id>`; add other paths to `EXTRA`/`EXTRA_ABS` in `audio.py` (breakbeat's breaks, sfz instruments, dr32 kits) |
| an audio FX segfaults (rc 139) on render, not on probe | `on_midi` called on an older v2 struct that has no such field | send MIDI and clock to FX only with `capabilities.midi_in` (`--fxmidi`) |
| a MIDI FX sequencer emits nothing | it never got transport start | `0xFA` goes through `process_midi` as well as `0xF8` |
| surge / minijv / osirus "serve nothing" | asked before they finished loading | the probe keeps rendering until every key answers (up to ~15 s) |
| `chain_params` cut off at exactly 4095 bytes | the probe's read buffer | the probe uses a 1 MB buffer |
| every knob turn ends in silence | resting values read before the recipe's setup | the probe applies `recipe.set` first |
| enum knob turns do nothing | wrote an index to a module that speaks names, or the reverse | learn the convention from probe or trace values (`learnEnumWireFormat`) |
| drum-rack keys read nothing (`sample`, `start`) | child template keys | resolve with `child_key.mjs` (`p01_sample`) in plan, score and film |
| a canvas widget: "Cannot use import statement outside a module" | ES-module canvas script | load it as a module from the on-device-shaped mirror `build/esm/modules/<cat>/<id>/` (needs `shared/` at `../../../shared`) |
| a canvas page is blank | its live keys (`extra_keys`/`extraKeys`) weren't passed | give the page the whole traced frame |
| `KICK_>` or other fake values on screen | a fake value used for a key the DSP didn't answer | with a trace, unanswered keys stay unanswered |
| a click at the loop point | AAC padding (12 s at 48 kHz isn't a whole number of 1024-sample frames) | encode at 64 kHz: 768,000 = 750 frames |
| the loop audio has a seam | reverb tails | render the score twice and keep the second pass |
| a `docker run … $P` mount fails in zsh | zsh doesn't word-split unquoted vars | the scripts run under bash; in zsh use `${=VAR}` or literal paths |
| "slow" flags on surge and others | wall time included container start and preset loading | measure the DSP loop in the host (`RENDER_MS`) |
| a UI fuzz run never finishes | a widget loops forever on a garbage value | per-module process with a watchdog; the hang becomes a finding |
| the gallery shows old videos | browser or CDN cache of the same URL | new object prefix (`v2/`) per re-render |
| a 3D render of 30 MB+ per 12 s | supersampling + AO | `finalize.sh` re-encodes at CRF 20 (about 13 MB) |
| a 3D render fails or is blank with "Failed to download CDN script" | three.js and GSAP were loaded from a CDN at render time | both are vendored in `compositions/flat/vendor/`; keep it that way |
