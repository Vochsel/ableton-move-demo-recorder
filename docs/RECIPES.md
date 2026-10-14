# Recipes

A recipe (`data/recipes/<id>.json`) says how a module should be played and shown. Without one, the module gets a generic performance based on its role. Write one when a demo doesn't show the module doing its thing; that's most of the fixes.

`bin/mdr recipe <id>` prints the current recipe, the pages and keys the planner sees, and the last score. Keys a recipe may use are listed in `build/plan/<id>.trace.txt`.

## Schema

```jsonc
{
  "note": "why the demo looks like this (shown to reviewers)",
  "locked": true,                 // apply_review.py won't overwrite a locked recipe

  // what is played
  "play": "drums" | "mono" | "poly" | "groove" | "single" | "plucks" | "held" | "none",
  "notes": [[beat, lengthBeats, midiNote, velocity], ...],   // replaces `play`; repeated to fill the 24-beat loop
  "part": "lead",                 // pad colouring for `notes` ("drums" puts them on the drum-rack 4x4)

  // what is shown
  "pages": ["Exact page name", ...],      // up to 3, in order; the screen ends back on the first
  "turns": [{ "key": "param_key", "to": "70%" | 0.35 | 2, "page": 0 }],  // out and back; "%" is of the range
  "fullscreen": { "key": "canvas_param", "from": 2, "to": 22 },         // dive into a canvas (beats)

  // setup and gestures
  "set": { "param_key": "value" },        // written at t=0 and applied before probing
  "automation": [[beat, "param_key", "value"], ...],   // raw writes the module's own UI would make
  "jog": [[beat, delta], ...],                         // jog-wheel moves (shown, and fed to canvases)
  "padGate": { "key": "jog_gate", "on": "2", "off": "0" }   // a param held while each note is down
}
```

The loop is 24 beats (6 bars of 4/4 at 120 BPM, 12 s). Beat 0 is the downbeat. Drum notes follow GM: 36 kick, 38 snare, 42 closed hat, 46 open hat.

### `play` defaults

| play | what | used by default for |
|---|---|---|
| `drums` | kick/snare/hat groove with fills | drum machines, `pad_layout: drums` |
| `mono` | 16th-note arpeggio, two octaves | mono and bass synths |
| `poly` | chord stabs plus bass | other synths |
| `groove` | `drums` + `poly` on stand-ins | audio FX (as their input) |
| `held` | one sustained triad per bar | arpeggiators, clock-driven generators |
| `single` | one note per beat | chord generators |
| `plucks` | short sparse melody | other MIDI FX |
| `none` | nothing | modules that run off clock alone |

## Worked examples

**A chord generator** (impressive-chords). Each trigger note plays a whole chord preset, so feed single trigger notes from the base note up, and turn strum and tilt:

```json
{ "play": "single", "notes": [[0,1.8,48,110],[2,1.8,53,100],[4,1.8,51,105],[6,1.8,55,100]],
  "turns": [{"key":"strum","to":"70%","page":0},{"key":"tilt","to":"80%","page":0}] }
```

**Plays itself from clock** (breakbeat). No notes; show Complexity reshuffling the break:

```json
{ "play": "none", "pages": ["Main","Anchors","Retrig"],
  "turns": [{"key":"complexity","to":"85%","page":0},{"key":"anchor_1","to":"100%","page":1},{"key":"retrig_4x","to":"80%","page":2}] }
```

**A sampler** (granny). Point it at the sample library first:

```json
{ "play": "poly", "set": {"sample_path": "/data/UserData/UserLibrary/Samples/Schwung Demo/pad-chord.wav"},
  "turns": [{"key":"position","to":"80%","page":0}] }
```

**A full-screen canvas driven by gestures** (scratch). Enter Scratch View, baby-scratch with the jog wheel, and open the cut on pad hits. The module's UI writes `jog_rate` and `jog_gate`, so the recipe writes them too:

```json
{ "play": "plucks", "set": {"control_mode":"2","virtual_play":"1","jog_active":"1","jog_gate":"0"},
  "padGate": {"key":"jog_gate","on":"2","off":"0"},
  "jog": [[2,3],[2.5,-3]], "automation": [[2,"jog_rate",4.0],[2.5,"jog_rate",-4.0]],
  "fullscreen": {"key":"scratch_view","from":2,"to":22} }
```

## Checklist

- **Is the effect actually on?** Mix above 0, not on Bypass, the switch enabled, its depth above 0.
- **Does the turned knob do something audible in this state?** Don't turn resonance with the filter fully open, or reverb decay with mix at 0.
- **Notes that suit the module.** Single notes into a mono synth; triggers into a chord generator; held notes into an arpeggiator.
- **Never turn** volume, preset, browse, trigger, learn, randomize or kill.
- **After a change:** `bin/mdr data <id> && bin/mdr sheets <id>`, then look at the sheet.
