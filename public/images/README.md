# Image drop-zone

Drop these **four local files** here (do not hotlink external URLs — the pages reference
same-origin paths only):

| File | Used on | Recommended size | Notes |
|---|---|---|---|
| `slider-1.jpg` | Homepage slider, slide 1 | 1200 × 675 (16:9) | plumber under a sink / leak repair |
| `slider-2.jpg` | Homepage slider, slide 2 | 1200 × 675 (16:9) | water heater replacement |
| `slider-3.jpg` | Homepage slider, slide 3 | 1200 × 675 (16:9) | drain clearing |
| `plumber-austin.jpg` | `/austin` + all `/austin/<city>` pages | 1200 × 675 (16:9) | one generic Austin plumbing photo |

## Adding them

```bash
# from the repo root, after copying the files into public/images/
git add public/images/*.jpg
git commit -m "images: add homepage slider + Austin plumbing photo"
git push
```

## Rules that keep the pages fast and stable

- **16:9 / 1200×675.** The markup already declares `width="1200" height="675"` and the CSS uses
  `aspect-ratio: 16 / 9`, so the box is reserved before the image loads — no layout shift (CLS 0).
- **Keep each file under ~250 KB.** Resize/compress first (`squoosh.app` or
  `magick photo.jpg -resize 1200x675 -quality 82 photo.jpg`).
- **JPEG (or rename to `.webp` and update the `src` in `public/index.html` and `city-pages.js`).**
- **Missing file?** The image hides itself (`onerror`) and the gold/navy gradient in
  `.cf-slide` / `.photo-figure` shows instead, so a not-yet-added photo never renders as a broken
  icon and never shifts the layout.
- Files here are **committed** (the repo `.gitignore` only excludes the database, `.env`,
  `node_modules` and logs).
