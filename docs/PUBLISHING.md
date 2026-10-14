# Publishing

Videos and posters go to a Cloudflare R2 bucket, and the gallery (`site/`) is a static page on Vercel that reads `site/modules.json`.

## One-time setup

```bash
npx wrangler login
npx wrangler r2 bucket create <bucket>
npx wrangler r2 bucket dev-url enable <bucket>        # prints https://pub-….r2.dev
vercel login && (cd site && vercel link --yes --project <name> --scope <team>)
```

Then in `mdr.config.json`:

```json
"publish": { "bucket": "<bucket>", "publicUrl": "https://pub-….r2.dev", "vercelScope": "<team>" }
```

`r2.dev` URLs are rate-limited; for real traffic, attach a custom domain to the bucket and use that as `publicUrl`.

## Publishing

```bash
bin/mdr render --all --publish     # renders in batches of 25; each batch uploads and redeploys
bin/mdr publish                    # rebuild the manifest, deploy, then HEAD every file and re-upload failures
```

Objects are written under `v2/<id>.mp4`, `v2/<id>-3d.mp4`, `v2/<id>.jpg` and `v2/<id>-3d.jpg` with `max-age=86400`. Change the prefix in `render_all.sh` and `manifest.py` together to bust caches after a re-render.

The manifest lists only modules with both videos on disk. Each entry records whether the audio is the module's own DSP or stand-ins, plus the visual audit's limitation note; the gallery's player shows both.

`site/.vercelignore` keeps `.env*` and `.vercel/` out of the deployment.
