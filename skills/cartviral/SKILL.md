---
name: cartviral
description: Make product videos, photos, carousels and ads with CartViral from the terminal (cartviral CLI). Use when the user asks for a product video, a UGC or creator clip, an ad, product photos, a carousel, a brand film, a talking photo, to swap a product inside a video, to remake a TikTok or Reel with their product, or mentions CartViral.
---

# CartViral

CartViral turns a product (a store link, a marketplace link or photos) into short videos, photos, carousels and ads.
The `cartviral` command runs it. Results are links and files.

## Before the first call

1. `cartviral whoami` shows the account and the credit balance.
2. "Not signed in" means: run `cartviral login`. It opens the browser, the user presses Allow, the command finishes by itself. Wait for it.
3. No `cartviral` command: `curl -fsSL https://cartviral.com/install.sh | sh`, then use `~/.local/bin/cartviral` until a new terminal is opened.

## How to work

- `cartviral tools` lists everything it can do; `cartviral help <tool>` shows a tool's parameters. Read the help of a tool before its first use: parameters differ.
- Run a tool: `cartviral <tool> --param value`. A local image or video path is uploaded automatically.
- Add `--wait --out <folder>`: the command waits until the result is ready and saves the files. Videos take 5 to 15 minutes, images under a minute.
- Every call prints JSON. `credits_charged` is what it cost; tell the user the price before a big batch.
- A job that is already running: `cartviral list_creations --job_id <id>` or `cartviral list_clips`.

## Common asks

```bash
cartviral import_products https://mystore.com          # bring the catalog in (a store, Amazon or marketplace link)
cartviral list_products                                 # product ids
cartviral generate_clips --product_id <id> --clip_type ai_story --count 1 --wait --out ./clips
cartviral create_video --prompt "a hand opens the box, soft daylight" --reference_images ./product.jpg --wait --out ./out
cartviral edit_video --video ./ad.mp4 --prompt "replace the bottle with my can from the photo" --product_images ./can.jpg --wait --out ./out
cartviral create_image --prompt "product on a marble table, morning light" --reference_images ./product.jpg --wait --out ./out
cartviral remake_from_reference --reference_url https://www.tiktok.com/@brand/video/123 --product_id <id> --wait --out ./clips
cartviral generate_photos --product_id <id> --format photo_model --wait --out ./photos
cartviral remove_background --image ./product.jpg --wait --out ./out
```

Tools and parameters grow over time: `cartviral tools` and `cartviral help <tool>` are always current.

## Rules

- Do not invent product facts: use what the product page or the user gives.
- Not enough credits: say how many are missing and that plans and top-ups are at https://app.cartviral.com/account/billing.
- Never print the contents of ~/.config/cartviral/credentials.json.
