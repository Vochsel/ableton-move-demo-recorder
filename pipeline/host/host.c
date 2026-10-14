/*
 * host.c — an offline Schwung host: loads one module's real dsp.so and plays
 * it a score, block by block, the way the chain does (44.1 kHz, 128 frames).
 *
 *   host probe  <kind> <so> <dir> <defaults.json|-> <keys.txt> <out.json>
 *   host render <kind> <so> <dir> <defaults.json|-> <score.txt> <out.raw> <seconds>
 *               [--input in.raw] [--synth <so> <dir> <defaults|->] [--notes out.txt]
 *
 * kind: synth | fx | midifx
 * score.txt lines (sample-timed, sorted):
 *   N <smp> <status> <d1> <d2>     MIDI to the module (or the MIDI FX)
 *   V <smp> <key> <value...>       set_param
 *   S <smp> <key> <value...>       set_param on the --synth stand-in (MIDI FX chain)
 * Clock (0xFA start + 0xF8 at 24 ppq, 120 BPM) is generated here.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include "plugin_api_v1.h"
#include "audio_fx_api_v1.h"
#include "audio_fx_api_v2.h"
#include "midi_fx_api_v1.h"

#define SR 44100
#define FB 128
#define BPM 120.0

static uint8_t g_mem[4096];
static long g_smp = 0;
static int g_logs = 0;

static void h_log(const char *m) { if (g_logs++ < 40) fprintf(stderr, "[mod] %s\n", m); }
static int h_midi(const uint8_t *m, int l) { (void)m; (void)l; return l; }
static int h_clock(void) { return MOVE_CLOCK_STATUS_RUNNING; }
static float h_bpm(void) { return (float)BPM; }
static int h_recv(void *i) { (void)i; return 0; }
static double h_beat(void) { return (double)g_smp / SR * BPM / 60.0; }
static int h_emit(void *c, const char *a, const char *b, const char *p, float s, float d, float o, int bi, int en) {
    (void)c; (void)a; (void)b; (void)p; (void)s; (void)d; (void)o; (void)bi; (void)en; return 0;
}
static void h_clear(void *c, const char *s) { (void)c; (void)s; }

static host_api_v1_t HOST = {
    .api_version = 1, .sample_rate = SR, .frames_per_block = FB,
    .mapped_memory = g_mem, .audio_out_offset = MOVE_AUDIO_OUT_OFFSET, .audio_in_offset = MOVE_AUDIO_IN_OFFSET,
    .log = h_log, .midi_send_internal = h_midi, .midi_send_external = h_midi, .get_clock_status = h_clock,
    .mod_emit_value = h_emit, .mod_clear_source = h_clear, .mod_host_ctx = NULL,
    .get_bpm = h_bpm, .midi_inject_to_move = h_midi, .slot_recv_channel = h_recv, .get_beat_position = h_beat,
};

/* ---------- a loaded component ---------- */
typedef struct {
    int kind;                 /* 0 synth, 1 fx, 2 midifx */
    plugin_api_v2_t *s2; plugin_api_v1_t *s1;
    audio_fx_api_v2_t *f2; audio_fx_api_v1_t *f1;
    midi_fx_api_v1_t *m1;
    void *inst;
} comp_t;

static char *slurp(const char *p) {
    if (!p || !strcmp(p, "-")) return NULL;
    FILE *f = fopen(p, "rb"); if (!f) return NULL;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    char *b = calloc(1, n + 1); if (fread(b, 1, n, f) != (size_t)n) {} fclose(f); return b;
}

static int load(comp_t *c, const char *kind, const char *so, const char *dir, const char *defs) {
    memset(c, 0, sizeof *c);
    void *h = dlopen(so, RTLD_NOW | RTLD_LOCAL);
    if (!h) { fprintf(stderr, "dlopen: %s\n", dlerror()); return -1; }
    char *dj = slurp(defs);
    if (!strcmp(kind, "synth")) {
        c->kind = 0;
        move_plugin_init_v2_fn i2 = (move_plugin_init_v2_fn)dlsym(h, MOVE_PLUGIN_INIT_V2_SYMBOL);
        if (i2) { c->s2 = i2(&HOST); if (!c->s2) return -2; c->inst = c->s2->create_instance(dir, dj ? dj : "{}"); return c->inst ? 0 : -3; }
        move_plugin_init_v1_fn i1 = (move_plugin_init_v1_fn)dlsym(h, MOVE_PLUGIN_INIT_SYMBOL);
        if (i1) { c->s1 = i1(&HOST); if (!c->s1) return -2; return c->s1->on_load(dir, dj ? dj : "{}") == 0 ? 0 : -3; }
        return -4;
    }
    if (!strcmp(kind, "fx")) {
        c->kind = 1;
        audio_fx_init_v2_fn i2 = (audio_fx_init_v2_fn)dlsym(h, AUDIO_FX_INIT_V2_SYMBOL);
        if (i2) { c->f2 = i2(&HOST); if (!c->f2) return -2; c->inst = c->f2->create_instance(dir, dj ? dj : "{}"); return c->inst ? 0 : -3; }
        audio_fx_init_v1_fn i1 = (audio_fx_init_v1_fn)dlsym(h, AUDIO_FX_INIT_SYMBOL);
        if (i1) { c->f1 = i1(&HOST); if (!c->f1) return -2; return c->f1->on_load(dir, dj ? dj : "{}") == 0 ? 0 : -3; }
        return -4;
    }
    c->kind = 2;
    midi_fx_init_fn im = (midi_fx_init_fn)dlsym(h, MIDI_FX_INIT_SYMBOL);
    if (!im) return -4;
    c->m1 = im((const struct host_api_v1 *)&HOST); if (!c->m1) return -2;
    c->inst = c->m1->create_instance(dir, dj ? dj : "{}");
    return c->inst ? 0 : -3;
}

static void cset(comp_t *c, const char *k, const char *v) {
    if (c->s2) c->s2->set_param(c->inst, k, v);
    else if (c->s1) c->s1->set_param(k, v);
    else if (c->f2) c->f2->set_param(c->inst, k, v);
    else if (c->f1) c->f1->set_param(k, v);
    else if (c->m1) c->m1->set_param(c->inst, k, v);
}
static int cget(comp_t *c, const char *k, char *b, int n) {
    b[0] = 0;
    if (c->s2) return c->s2->get_param(c->inst, k, b, n);
    if (c->s1) return c->s1->get_param(k, b, n);
    if (c->f2) return c->f2->get_param(c->inst, k, b, n);
    if (c->f1) return c->f1->get_param(k, b, n);
    if (c->m1) return c->m1->get_param(c->inst, k, b, n);
    return -1;
}
static int g_fxmidi = 0;
static void cmidi(comp_t *c, const uint8_t *m, int l, int src) {
    if (c->s2) c->s2->on_midi(c->inst, m, l, src);
    else if (c->s1) c->s1->on_midi(m, l, src);
    else if (c->f2 && g_fxmidi && c->f2->on_midi) c->f2->on_midi(c->inst, m, l, src);
}

static void timeout(int s) { (void)s; fprintf(stderr, "TIMEOUT\n"); _exit(9); }

static void json_str(FILE *f, const char *s) {
    fputc('"', f);
    for (; *s; s++) {
        unsigned char ch = (unsigned char)*s;
        if (ch == '"' || ch == '\\') { fputc('\\', f); fputc(ch, f); }
        else if (ch < 0x20) fprintf(f, "\\u%04x", ch);
        else fputc(ch, f);
    }
    fputc('"', f);
}

/* ---------- probe ---------- */
static void render_silence(comp_t *c, int blocks) {
    int16_t buf[FB * 2];
    for (int b = 0; b < blocks; b++) {
        memset(buf, 0, sizeof buf);
        if (c->s2) c->s2->render_block(c->inst, buf, FB);
        else if (c->s1) c->s1->render_block(buf, FB);
        else if (c->f2) c->f2->process_block(c->inst, buf, FB);
        else if (c->f1) c->f1->process_block(buf, FB);
        g_smp += FB;
    }
}

/* Some modules load asynchronously (Surge, MiniJV, Osirus) and answer nothing
 * until they are ready — on a device the component load gate waits for that.
 * So keep rendering (up to ~15 s) until every key has answered once. */
static int probe(comp_t *c, const char *keys, const char *out, const char *sets) {
    char *names[2048]; int n = 0;
    FILE *kf = fopen(keys, "r");
    if (!kf) return -1;
    char line[512];
    while (n < 2048 && fgets(line, sizeof line, kf)) {
        line[strcspn(line, "\r\n")] = 0;
        if (*line) names[n++] = strdup(line);
    }
    fclose(kf);
    /* the recipe's starting values first, so what we read is the state the demo plays from */
    if (sets) {
        FILE *sf = fopen(sets, "r");
        char sl[4096];
        while (sf && fgets(sl, sizeof sl, sf)) {
            sl[strcspn(sl, "\r\n")] = 0;
            char *sp = strchr(sl, ' ');
            if (!sp) continue;
            *sp = 0;
            cset(c, sl, sp + 1);
            render_silence(c, 8);
        }
        if (sf) fclose(sf);
    }
    char **vals = calloc(n, sizeof *vals);
    static char val[1 << 20];
    const int checkpoints[] = { 200, 600, 1200, 2400, 3600, 5200 };   /* cumulative blocks */
    int done = 0;
    for (int cp = 0; cp < 6 && !done; cp++) {
        render_silence(c, checkpoints[cp] - (int)(g_smp / FB));
        done = 1;
        for (int k = 0; k < n; k++) {
            if (vals[k]) continue;
            val[0] = 0;
            int r = cget(c, names[k], val, sizeof val);
            if (r >= 0 && val[0] && strcmp(val, "[]") != 0) vals[k] = strdup(val);
            else done = 0;
        }
        /* a module that will never answer some keys: stop once nothing is still loading */
        if (!done && cp >= 1) {
            val[0] = 0;
            if (cget(c, "is_loading", val, sizeof val) < 0 || strcmp(val, "1") != 0) {
                if (cp >= 2) break;
            }
        }
    }
    FILE *of = fopen(out, "w");
    if (!of) return -1;
    int first = 1;
    fputc('{', of);
    for (int k = 0; k < n; k++) {
        if (!vals[k]) continue;
        if (!first) fputc(',', of);
        first = 0;
        json_str(of, names[k]); fputc(':', of); json_str(of, vals[k]);
    }
    fputs("}\n", of);
    fclose(of);
    return 0;
}

/* ---------- render ---------- */
typedef struct { long smp; char type; uint8_t m[3]; char key[128]; char val[256]; } ev_t;

static ev_t *read_score(const char *p, int *n) {
    FILE *f = fopen(p, "r"); if (!f) { *n = 0; return NULL; }
    int cap = 4096; ev_t *e = calloc(cap, sizeof *e); *n = 0;
    char line[1024];
    while (fgets(line, sizeof line, f)) {
        line[strcspn(line, "\r\n")] = 0;
        if (*n == cap) { cap *= 2; e = realloc(e, cap * sizeof *e); }
        ev_t *x = &e[*n]; memset(x, 0, sizeof *x);
        x->type = line[0];
        if (x->type == 'N') {
            int a, b, cc; if (sscanf(line + 2, "%ld %d %d %d", &x->smp, &a, &b, &cc) != 4) continue;
            x->m[0] = a; x->m[1] = b; x->m[2] = cc;
        } else if (x->type == 'V' || x->type == 'S') {
            int off = 0; if (sscanf(line + 2, "%ld %127s %n", &x->smp, x->key, &off) < 2) continue;
            snprintf(x->val, sizeof x->val, "%s", line + 2 + off);
        } else continue;
        (*n)++;
    }
    fclose(f);
    return e;
}

int main(int argc, char **argv) {
    signal(SIGALRM, timeout);
    alarm(240);
    if (argc < 7) { fprintf(stderr, "usage: see header\n"); return 2; }
    const char *mode = argv[1], *kind = argv[2];
    comp_t mod, syn; int have_syn = 0;
    int r = load(&mod, kind, argv[3], argv[4], argv[5]);
    if (r) { fprintf(stderr, "LOADFAIL %d\n", r); return 3; }
    if (!strcmp(mode, "probe")) return probe(&mod, argv[6], argv[7], argc > 8 ? argv[8] : NULL) ? 4 : 0;

    const char *outp = argv[7];
    double secs = atof(argv[8]);
    const char *inp = NULL, *notes = NULL, *trace_keys = NULL, *trace_out = NULL;
    for (int i = 9; i < argc; i++) {
        if (!strcmp(argv[i], "--input") && i + 1 < argc) inp = argv[++i];
        else if (!strcmp(argv[i], "--notes") && i + 1 < argc) notes = argv[++i];
        else if (!strcmp(argv[i], "--fxmidi")) g_fxmidi = 1;
        else if (!strcmp(argv[i], "--trace") && i + 2 < argc) { trace_keys = argv[++i]; trace_out = argv[++i]; }
        else if (!strcmp(argv[i], "--synth") && i + 3 < argc) {
            if (load(&syn, "synth", argv[i + 1], argv[i + 2], argv[i + 3])) { fprintf(stderr, "SYNTHFAIL\n"); return 5; }
            have_syn = 1; i += 3;
        }
    }
    int ne; ev_t *ev = read_score(argv[6], &ne);
    FILE *in = inp ? fopen(inp, "rb") : NULL;
    FILE *out = fopen(outp, "wb");
    FILE *nf = notes ? fopen(notes, "w") : NULL;
    long total = (long)(secs * SR);
    int16_t buf[FB * 2], ib[FB * 2], sb[FB * 2];
    int ei = 0;
    const double spt = SR * 60.0 / BPM / 24.0;   /* samples per clock tick */
    long next_tick = 0;
    uint8_t start = 0xFA;
    uint8_t om[MIDI_FX_MAX_OUT_MSGS][3]; int ol[MIDI_FX_MAX_OUT_MSGS];
    cmidi(&mod, &start, 1, MOVE_MIDI_SOURCE_HOST);
    if (mod.kind == 2) {   /* a MIDI FX hears transport start through process_midi, like the clock */
        int k = mod.m1->process_midi(mod.inst, &start, 1, om, ol, MIDI_FX_MAX_OUT_MSGS);
        for (int j = 0; j < k; j++) if (have_syn) cmidi(&syn, om[j], ol[j], 0);
    }
    if (have_syn) cmidi(&syn, &start, 1, MOVE_MIDI_SOURCE_HOST);
    /* --trace: every video frame of the SECOND pass (the one kept), read every
     * listed key back from the module — the screen then shows the DSP's own state */
    char **tk = NULL; int ntk = 0; FILE *tf = NULL;
    if (trace_keys && trace_out) {
        FILE *kf = fopen(trace_keys, "r");
        char line[256];
        while (kf && fgets(line, sizeof line, kf)) {
            line[strcspn(line, "\r\n")] = 0;
            if (!*line) continue;
            tk = realloc(tk, (ntk + 1) * sizeof *tk); tk[ntk++] = strdup(line);
        }
        if (kf) fclose(kf);
        tf = fopen(trace_out, "w");
    }
    const long loop_len = total / 2;
    const double spf = SR / 30.0;
    long next_frame = 0;
    static char tval[8192];

    struct timespec ts0, ts1; clock_gettime(CLOCK_MONOTONIC, &ts0);
    for (g_smp = 0; g_smp < total; g_smp += FB) {
        long end = g_smp + FB;
        /* clock */
        while (next_tick < end) {
            uint8_t clk = 0xF8;
            if (mod.kind == 2) {
                int k = mod.m1->process_midi(mod.inst, &clk, 1, om, ol, MIDI_FX_MAX_OUT_MSGS);
                for (int j = 0; j < k; j++) { if (have_syn) cmidi(&syn, om[j], ol[j], 0); if (nf && (om[j][0] & 0xE0) == 0x80) fprintf(nf, "%ld %d %d %d\n", g_smp, om[j][0], om[j][1], om[j][2]); }
            } else cmidi(&mod, &clk, 1, MOVE_MIDI_SOURCE_HOST);
            if (have_syn) cmidi(&syn, &clk, 1, MOVE_MIDI_SOURCE_HOST);
            next_tick = (long)((double)((long)(next_tick / spt + 0.5) + 1) * spt);
        }
        /* score events due in this block */
        while (ei < ne && ev[ei].smp < end) {
            ev_t *x = &ev[ei++];
            if (x->type == 'V') cset(&mod, x->key, x->val);
            else if (x->type == 'S') { if (have_syn) cset(&syn, x->key, x->val); }
            else if (x->type == 'N') {
                if (mod.kind == 2) {
                    int k = mod.m1->process_midi(mod.inst, x->m, 3, om, ol, MIDI_FX_MAX_OUT_MSGS);
                    for (int j = 0; j < k; j++) { if (have_syn) cmidi(&syn, om[j], ol[j], 0); if (nf && (om[j][0] & 0xE0) == 0x80) fprintf(nf, "%ld %d %d %d\n", g_smp, om[j][0], om[j][1], om[j][2]); }
                } else cmidi(&mod, x->m, 3, MOVE_MIDI_SOURCE_INTERNAL);
            }
        }
        if (mod.kind == 2 && mod.m1->tick) {
            int k = mod.m1->tick(mod.inst, FB, SR, om, ol, MIDI_FX_MAX_OUT_MSGS);
            for (int j = 0; j < k; j++) { if (have_syn) cmidi(&syn, om[j], ol[j], 0); if (nf && (om[j][0] & 0xE0) == 0x80) fprintf(nf, "%ld %d %d %d\n", g_smp, om[j][0], om[j][1], om[j][2]); }
        }
        /* input audio (line-in for synths, the signal for FX) */
        memset(ib, 0, sizeof ib);
        if (in && fread(ib, sizeof(int16_t), FB * 2, in) != FB * 2) { fseek(in, 0, SEEK_SET); }
        memcpy(g_mem + MOVE_AUDIO_IN_OFFSET, ib, sizeof ib);

        memset(buf, 0, sizeof buf);
        if (mod.kind == 0) {
            if (mod.s2) mod.s2->render_block(mod.inst, buf, FB); else mod.s1->render_block(buf, FB);
        } else if (mod.kind == 1) {
            memcpy(buf, ib, sizeof buf);
            if (mod.f2) mod.f2->process_block(mod.inst, buf, FB); else mod.f1->process_block(buf, FB);
        }
        if (have_syn) {
            memset(sb, 0, sizeof sb);
            if (syn.s2) syn.s2->render_block(syn.inst, sb, FB); else syn.s1->render_block(sb, FB);
            for (int j = 0; j < FB * 2; j++) { int v = buf[j] + sb[j]; buf[j] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
        }
        fwrite(buf, sizeof(int16_t), FB * 2, out);
        if (tf) {
            while (g_smp + FB > loop_len + (long)(next_frame * spf) && next_frame < 360) {
                fprintf(tf, "{\"f\":%ld", next_frame);
                for (int k = 0; k < ntk; k++) {
                    tval[0] = 0;
                    if (cget(&mod, tk[k], tval, sizeof tval) >= 0 && tval[0]) {
                        fputc(',', tf); json_str(tf, tk[k]); fputc(':', tf); json_str(tf, tval);
                    }
                }
                fputs("}\n", tf);
                next_frame++;
            }
        }
    }
    if (tf) fclose(tf);
    clock_gettime(CLOCK_MONOTONIC, &ts1);
    fprintf(stderr, "RENDER_MS %.1f AUDIO_MS %.1f\n", (ts1.tv_sec - ts0.tv_sec) * 1e3 + (ts1.tv_nsec - ts0.tv_nsec) / 1e6, secs * 1000.0);
    fclose(out); if (in) fclose(in); if (nf) fclose(nf);
    fflush(stderr);
    _exit(0);   /* skip module destructors: some hang on teardown */
}
