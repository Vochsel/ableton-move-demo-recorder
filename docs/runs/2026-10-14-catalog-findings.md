# Schwung module demos: findings

These come from rendering every catalog module headlessly: each module's released `dsp.so` runs in an ARM64 Linux container behind a small host that implements Schwung's plugin API, and each screen is drawn by Schwung's own renderer or the module's own UI code from values read back from the DSP every frame. Everything here is from that harness, not from a Move, so treat it as leads to check on hardware.

## Crashes (please check)

- **clap** (charlesvestal, Chris Johnson (Airwindows)): segfault (SIGSEGV) under a random score of notes + parameter writes (fuzz iteration 0). Repro score: `build/fuzz/clap.0.score.txt`.
- **twinsampler** (jrucho): segfault (SIGSEGV) under a random score of notes + parameter writes (fuzz iteration 0). Repro score: `build/fuzz/twinsampler.0.score.txt`.
- **mrdrums** (handcraftedcc): segfault in a 24 s render when `pad_decay_ms` is swept while eight pad samples are loaded and a beat plays. It doesn't reproduce in reduced form, so it may be a race. Repro: `build/findings/mrdrums-crash-pad_decay_ms.score.txt`.

## UI hangs

- **quilt** (kliegsablaze): its `canvas.js` widget never returns for some garbage parameter values. The drawing loops (`dots`/`dotted`: `for (x = x0; x <= x1; x += every)`) take their step from values, and NaN or 0 never terminates. On a Move this would freeze the shadow UI. Repro: `node pipeline/fuzz_ui.mjs --one --iters 3 quilt` times out.

## Display bugs

- **belt / belt-in / smack** (timncox): percent parameters show values like `2000%`, `8300%`, `5900%`. They declare a 0–100 range with unit `%`, and Schwung's renderer formats `%` as a 0–1 fraction ×100.
- **elusive-muse**: the Card canvas throws `Cannot read properties of undefined (reading 'deck')` when its value has not been read yet, so the cell draws nothing until it is.

## Performance

No module's DSP loop came close to real time. The heaviest under random parameters was NAM at 0.12× real time on an M1 Pro (a Move's CPU is slower, so leave headroom). An earlier "slower than real time" flag for surge, nam and impressive-chords was wrong: it counted container start and preset loading, not DSP time.

## Needs something the headless demo can't provide

- **airplay**: Network receiver; headless it can only show its error/settings menu.
- **arranger**: Needs a library of user MIDI clips to arrange.
- **control**: Overlays for knob CCs and pad notes are the real UI; output goes to external gear.
- **davebox**: Needs clips/transport set up via its own UI; not expressible as inputs.
- **dj**: Needs user stem files to load into decks; only pitch/xfader numbers move.
- **dr32**: Needs Move .ablpreset kits and their samples.
- **dronage-tool**: Takeover never leaves its splash headless; needs UI entry beyond available inputs.
- **jp8000**: Gearmulator JE-8086 needs the JP-8000 firmware ROM.
- **juno_control**: Requires external Roland hardware.
- **kit-builder**: Needs the user's Move sample library.
- **loopex**: Records Move tracks over Link Audio; nothing to sample headless.
- **m8**: Requires an M8 over USB; nothing to demo headless.
- **mark**: Live loop station needs recorded input via buttons.
- **midi-player**: Needs a user .mid file; no file param exposed to set.
- **minijv**: Needs the user-supplied JV-880 ROM; without it the screen is dead dashes.
- **mono**: Full-surface sequencer synth needs its own pattern/sequencer state and pad interaction to show anything.
- **move-bitwig**: Needs a Bitwig host connection.
- **movy**: Needs module chain/sequence set up through its UI; nothing to show headless.
- **nam**: Needs a user .nam model (and optional cab IR) to demonstrate anything.
- **osirus**: Gearmulator Virus needs a user-supplied firmware ROM.
- **oversmack**: Overtake looper needs live input + capture button; only parameter numbers move.
- **overwork**: Overtake build needs samples/live input and step p-locking via pads.
- **overwork-mix**: Needs the Move's live mix routed in; headless has none.
- **punchfx**: The module's whole point (Shift+pad pressure FX) isn't expressible with current inputs.
- **radiogarden**: Network radio player; nothing real to show offline.
- **rex**: Needs a ReCycle file; unless one can be generated and mounted there is nothing to slice.
- **samplerobot**: Autosampler of external gear; settings menu is all that can be shown.
- **sf2**: Needs a user .sf2 file; unless the harness mounts a generated SoundFont (as sfz does), nothing real to show.
- **sidcontrol**: Needs the SIDaster hardware; UI shown is real and responsive, which is the most that can be shown.
- **smack-in**: Standalone input build needs live mic/line audio and capture.
- **snake**: Game needs live pad steering.
- **streamrtsp**: Network receiver; nothing to stream offline.
- **twinsampler**: Needs user sample library/sessions; screen is stuck in an empty browser.
- **vocoder**: Can't show vocoding without a modulator signal on line-in (would need the harness to inject speech).
- **webstream**: Web streaming player can't play headless; screen is an empty browser + transport buttons.

## Silent when run headless (open questions for authors)

- **scratch**: `load_status` stays 0 and output is silent even with `sample_file`, `virtual_play=1`, `jog_active=1` and `jog_gate=2`. What starts playback without the UI?
- **sfz**: it finds and loads the mounted instrument (`Preset 0: Schwung Demo Keys`) but renders silence for notes 36–72.
- **eucalypso**: in `hold` mode with held notes and MIDI clock it emits no notes.
- **slicer**: with `sample_path` set it renders silence (its UI shows "No slices found").
- **dr32**: no kit loads headless, even with its bundled 9W9 samples mounted at `UserLibrary/Samples/DR32`.

## Parameter writes the DSP did not reflect back (unverified)

The fuzzer wrote in-range values from each module's own `chain_params` and read them back. These keys never reported the written value (allowing for step size, clamping and the module's enum convention). Often it's a declared range that differs from what the module accepts, or a different display scale.

- **6w6**: `sd_decay`
- **9w9**: `master_dist`
- **acid**: `a_offset`, `b_offset`
- **airplay**: `gain`
- **ambiotica**: `micro_hold`, `scatter`
- **aphex**: `mg_shape`
- **beatbank**: `pattern`, `swing`
- **bouba-kiki**: `release`, `wobble`
- **branchage**: `density_hat`
- **breakbeat**: `stretch_pitch_min`
- **busdriver**: `damp`
- **chiptune**: `noise_mode`
- **chowtape**: `mix`
- **clap**: `param_3`
- **denis**: `rnd_patch`
- **elusive-muse**: `mute`
- **essaim**: `v_octave`, `v_pan`
- **euclidrum**: `lane5_velocity`
- **filter**: `resonance`
- **fizzik**: `glide`
- **forgetful**: `loopA_volume`
- **freak**: `harmonics`
- **granny**: `active_grains`
- **granular**: `mix`
- **groovebank**: `variant`
- **hank**: `decay`
- **helm**: `filter_on`
- **hera**: `preset`
- **keydetect**: `window`
- **maze_seq_lite**: `s1_bit_flip`, `s1_reset`
- **midi-player**: `track`
- **monksynth**: `bend_range`, `glide`
- **moog**: `lfo_filter`, `lfo_pitch`, `osc3_detune`, `osc4_detune`, `preset`
- **munchi-delay**: `feedback`, `freeze`
- **mverb**: `gain`, `predelay`
- **nam**: `input_level`, `output_level`
- **nusaw**: `preset`, `volume`
- **palette**: `fx3_drift`, `rnd_patch`
- **pixel-walkers**: `hardness`, `randomize`
- **psxverb**: `reverb_level`
- **punchfx**: `volume`
- **quilt**: `a_edge`, `b_swell`, `d_noise`, `o_fast`
- **radiogarden**: `play_pause_step`, `stop_step`
- **rrverb10**: `mode`, `time`
- **ruminant**: `tone`
- **sfz**: `preset`
- **signal**: `rnd_pitch`, `rnd_voices`
- **spectra**: `frequency`
- **stereoid**: `wide`
- **streamrtsp**: `gain`
- **structor**: `rev_damp`, `rnd_filter`
- **superarp**: `random_octave_range`, `rhythm_preset`
- **superboom**: `thresh`
- **tape-echo2**: `tape_wear`
- **tapedelay**: `mix`, `stereo_width`, `tone`
- **tapescam**: `input`, `noise`, `speed`
- **tinyk**: `master_vol`, `release2`
- **trance-gate**: `release`
- **vocoder**: `attack`, `bands`
- **wayward**: `loop1_record`, `loop6_trig`
- **webstream**: `restart_step`
- **wurl**: `speaker`
