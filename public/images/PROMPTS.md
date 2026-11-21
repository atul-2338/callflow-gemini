# Image prompts — homepage slider (3 slides)

Paste these into your image generator, then save the results over the matching filenames.
The site renders them at **1200 × 675 (16:9)** with `object-fit: cover`, so generate at
1536 × 864 (or any 16:9 size) and let the pipeline crop — no stretching either way.

**Shared style block — prepend to every prompt:**
> Professional high-resolution candid photograph, editorial trade-magazine quality, bright natural
> window light, clean modern residential setting, shallow depth of field, 16:9 landscape,
> photorealistic, no text overlays, no watermarks.

**Character (keep identical across all three):** female plumber, mid-30s, warm confident smile,
hair tied back, navy work shirt with a small gold CallFlow shield logo on the left chest,
dark work trousers, tool belt.

---

## slider-1.jpg — under-sink repair

> Candid photograph of the female plumber kneeling under a clean, well-lit residential kitchen sink,
> smiling warmly at the camera while she tightens a connection on a new white P-trap assembly with a
> wrench. Bright, clear lighting that illuminates both the plumbing work and her face. The inside of
> the cabinet behind her is slightly blurred. Gold CallFlow shield logo clearly visible on her navy
> uniform. 16:9 landscape, photorealistic.

## slider-2.jpg — water heater replacement

> Candid photograph of the same female plumber in her navy CallFlow shirt standing beside a newly
> installed tankless water heater in a tidy garage, one hand on the unit and the other holding a
> pipe wrench, looking toward the camera with a satisfied smile. Bright overhead light, clean
> concrete floor, tools laid out neatly. Gold CallFlow shield logo visible on her chest. 16:9
> landscape, photorealistic.

## slider-3.jpg — drain clearing

> Candid photograph of the same female plumber in her navy CallFlow shirt crouched in a bright,
> modern bathroom, feeding a drain snake into a floor drain, glancing up with a friendly smile.
> Clean tile, natural light from a window, tidy tool bag beside her. Gold CallFlow shield logo
> visible on her chest. 16:9 landscape, photorealistic.

---

## Saving them

1. Download the generated image.
2. Resize/crop to **1200 × 675** and compress to roughly **60–250 KB**:

   ```bash
   magick in.png -resize 1200x675^ -gravity center -extent 1200x675 -quality 82 public/images/slider-1.jpg
   ```

   (On Windows without ImageMagick: just drop the raw file in and ask me — I convert it.)
3. Overwrite `public/images/slider-1.jpg` / `-2` / `-3` (same names, `.jpg`).
4. `git add public/images/slider-*.jpg && git commit -m "images: new slider photos" && git push`

## Logo caveat

Image models usually garble small text/logos. If the shield looks wrong, generate the photo with a
**plain navy shirt** and I can composite the real `public/icon.svg` shield onto the chest so the
branding is pixel-clean.

## Alt text

Update these if the subject changes — they live in `public/index.html` on the `.cf-slide` images and
in `city-pages.js` → `photoHtml()` for the city pages.
