# CartViral CLI

Product videos, creator (UGC) clips, photos, carousels and ads for e-commerce, from a terminal.
Built for people and for AI agents that work in a terminal: Claude Code, Codex, Cursor.

It runs the same tools as the CartViral connector for Claude and ChatGPT, on your CartViral account and credits.

## Install

```bash
curl -fsSL https://cartviral.com/install.sh | sh
```

Open a new terminal window after it, or use the full path `~/.local/bin/cartviral` right away.

Or without installing, with Node.js 18+:

```bash
npx -y github:artemecom/cartviral-cli login
```

## Sign in

```bash
cartviral login
```

Your browser opens CartViral. Press **Allow** and the command finishes by itself.
No account yet? The same page lets you create one: the free start gives credits to try it, no card.

On a server or in CI, use an API key (CartViral menu: Claude & ChatGPT):

```bash
cartviral login --key cv_live_...
# or
export CARTVIRAL_API_KEY=cv_live_...
```

## Use

```bash
cartviral tools                      # everything it can do
cartviral help create_video          # a tool's parameters
cartviral whoami                     # account and credits

cartviral import_products https://mystore.com
cartviral list_products
cartviral generate_clips --product_id <id> --clip_type ai_story --wait --out ./clips
cartviral create_video --prompt "a hand opens the box, soft daylight" --reference_images ./product.jpg --wait --out ./out
cartviral edit_video --video ./ad.mp4 --prompt "replace the bottle with my can from the photo" --product_images ./can.jpg --wait --out ./out
cartviral remake_from_reference --reference_url https://www.tiktok.com/@brand/video/123 --product_id <id> --wait --out ./clips
```

- A local image or video path is uploaded for you.
- `--wait` waits for the result (videos take 5 to 15 minutes); `--out <folder>` saves the files.
- Every call prints JSON, so an agent can read it.
- The tool list comes from the server: new CartViral tools appear without updating the CLI.

## For AI agents

```bash
cartviral skill install        # adds the CartViral skill to Claude Code (~/.claude/skills/cartviral)
# or
npx skills add artemecom/cartviral-cli
```

Then ask in plain words: "make a creator video for my product https://...".

## Where things are kept

- Sign-in: `~/.config/cartviral/credentials.json`, readable only by you. `cartviral logout` removes it.
- Connected apps and API keys can be revoked in CartViral: Claude & ChatGPT in the menu.

## Links

- Guide: https://cartviral.com/mcp
- Connector for Claude and ChatGPT (no terminal): https://app.cartviral.com/account/agents
- Support: support@cartviral.com
