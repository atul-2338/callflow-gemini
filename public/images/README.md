# Images — replace these files, keep the names

The site uses **local** JPEGs only — nothing hotlinks an external URL. Slides 1–4 are your real
photos, already resized to 1200 × 675 and compressed to 67–81 KB. To swap any photo,
**overwrite the file with the same name** and the pages pick it up automatically. No HTML edits.

| Filename | Placeholder shows | Swap in | Used on |
|---|---|---|---|
| `slider-1.jpg` | “Female plumber · under-sink repair” | Your female plumber under a sink | Homepage slider, slide 1 |
| `slider-2.jpg` | “Water heater swap · garage job site” | Job-site water heater shot | Homepage slider, slide 2 |
| `slider-3.jpg` | “Drain clearing · bathroom job site” | Job-site drain/bathroom shot | Homepage slider, slide 3 |
| `slider-4.jpg` | “Job site, tools ready” | Any extra job-site shot | Homepage slider, slide 4 |
| `plumber-austin.jpg` | “Plumber on an Austin job” | Wide female-plumber / job-site hero | `/austin` and all six `/austin/<city>` pages |

## How to swap

```bash
# copy your photos in, keeping these exact names
copy slider-1.jpg public\images\slider-1.jpg     # Windows
# or:  cp slider-1.jpg public/images/slider-1.jpg   (macOS/Linux)

git add public/images/*.jpg
git commit -m "images: swap in real plumber photos"
git push
```

## Format rules

- **1200 × 675 (16:9), JPEG, under ~250 KB.** The markup declares `width="1200" height="675"` and
  the CSS uses `aspect-ratio: 16 / 9`, so the box is reserved before the photo loads — **no layout
  shift**. A different aspect ratio will crop (the CSS uses `object-fit: cover`), not stretch.
- Compress before committing: `magick photo.jpg -resize 1200x675^ -gravity center -extent 1200x675 -quality 82 photo.jpg`
- Using `.webp`? Rename the files **and** update the four `src` paths in `public/index.html`
  (slider) and `photoHtml()` in `city-pages.js` (city pages).

## If a file is missing or misnamed

The `<img>` hides itself (`onerror`) and the navy/gold gradient behind it shows — no broken-image
icon and no layout jump. Nothing 500s.

## Where the alt text lives (update it if the photo changes)

- Homepage slider: `public/index.html` → `alt="..."` on the three `cf-slide` images.
- City pages: `city-pages.js` → `photoHtml()` → the `alt` string, which is built per city
  (`Plumber repairing a leaking pipe under a kitchen sink in {City}, TX`).
