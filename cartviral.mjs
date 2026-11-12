#!/usr/bin/env node
/**
 * CartViral CLI: everything the CartViral connector can do, from a terminal.
 * One file, no dependencies, Node 18+.
 *
 * It is a thin client of the same server tools the Claude / ChatGPT connector uses (POST /mcp, tools/list and
 * tools/call), so a tool added on the server appears here without a new release:
 *
 *   cartviral login                      sign in in the browser (or: cartviral login --key cv_live_...)
 *   cartviral tools                      what CartViral can do
 *   cartviral help create_video          a tool's parameters
 *   cartviral create_video --prompt "..." --wait --out ./videos
 *
 * Sign-in: OAuth 2.1 with PKCE and a loopback return address, like any desktop app. The tokens stay in
 * ~/.config/cartviral/credentials.json (0600). CARTVIRAL_API_KEY or --key use an API key instead.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const VERSION = "1.0.0";
const BASE = (process.env.CARTVIRAL_URL || "https://app.cartviral.com").replace(/\/$/, "");
const SITE = "https://cartviral.com";
const DIR = process.env.CARTVIRAL_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "cartviral");
const CRED = path.join(DIR, "credentials.json");
const LOCK = path.join(DIR, "credentials.lock");
const TOOLS_CACHE = path.join(DIR, "tools.json");
const MEDIA_EXT = { ".jpg": 8, ".jpeg": 8, ".png": 8, ".webp": 8, ".mp4": 60, ".mov": 60, ".webm": 60 }; // MB the server takes
const GLOBAL_FLAGS = new Set(["json", "wait", "out", "key", "timeout", "args", "help", "no_browser", "quiet", "project", "version"]);
const SWITCHES = new Set(["json", "wait", "help", "no_browser", "quiet", "project", "version"]); // never take a value

const err = (...a) => process.stderr.write(a.join(" ") + "\n");
const out = (s) => process.stdout.write(s + "\n");
const pretty = (v) => JSON.stringify(v, null, 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Fail extends Error {}
const fail = (msg) => {
  throw new Fail(msg);
};

// ------------------------------------------------------------------ credentials

function readCred() {
  try {
    return JSON.parse(fs.readFileSync(CRED, "utf8"));
  } catch {
    return null;
  }
}

function writeCred(c) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CRED}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CRED);
}

/** One process at a time refreshes the token: a refresh token works once, a second use would end the sign-in. */
async function withLock(fn) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(LOCK).mtimeMs;
      } catch {
        continue;
      }
      if (age > 30_000 || Date.now() - t0 > 40_000) {
        try {
          fs.rmdirSync(LOCK);
        } catch {
          /* another process took it */
        }
        continue;
      }
      await sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmdirSync(LOCK);
    } catch {
      /* already gone */
    }
  }
}

async function postForm(url, fields) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(fields) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

async function refresh(force = false) {
  return withLock(async () => {
    const c = readCred();
    if (!c || c.type !== "oauth") return c;
    if (!force && c.access_expires_at - Date.now() > 60_000) return c; // another process already refreshed it
    const { ok, body } = await postForm(`${c.base}/oauth/token`, { grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: c.client_id });
    if (!ok || !body.access_token) {
      fail(`The sign-in on this computer has expired${body.error_description ? ` (${body.error_description})` : ""}. Run: cartviral login`);
    }
    const next = { ...c, access_token: body.access_token, refresh_token: body.refresh_token || c.refresh_token, access_expires_at: Date.now() + (body.expires_in || 3600) * 1000 };
    writeCred(next);
    return next;
  });
}

/** The bearer for a call: --key, CARTVIRAL_API_KEY, or the saved sign-in (refreshed when it is about to end). */
async function bearer(flags) {
  const key = flags.key || process.env.CARTVIRAL_API_KEY;
  if (key) return { token: String(key), oauth: false };
  let c = readCred();
  if (!c) fail("Not signed in. Run: cartviral login   (it opens the browser; or cartviral login --key <API key>)");
  if (c.base && c.base !== BASE) fail(`This computer is signed in to ${c.base}, not ${BASE}. Run: cartviral login`);
  if (c.type === "key") return { token: c.key, oauth: false };
  if (c.access_expires_at - Date.now() < 60_000) c = await refresh();
  return { token: c.access_token, oauth: true };
}

// ------------------------------------------------------------------ the server

async function rpc(method, params, flags, retry = true) {
  const auth = await bearer(flags);
  let res;
  try {
    res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": `cartviral-cli/${VERSION}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (e) {
    fail(`Could not reach ${BASE}: ${e.cause?.code || e.message}`);
  }
  if (res.status === 401) {
    if (auth.oauth && retry) {
      await refresh(true);
      return rpc(method, params, flags, false);
    }
    fail(auth.oauth ? "The sign-in on this computer is no longer valid. Run: cartviral login" : "This API key is not valid. Create a new one in CartViral: Claude & ChatGPT in the menu.");
  }
  if (res.status === 429) fail("Too many calls: at most 120 a minute. Wait a little and try again.");
  const body = await res.json().catch(() => null);
  if (!body) fail(`The server answered ${res.status} without JSON.`);
  if (body.error) fail(body.error.message || "The server refused the call.");
  return body.result;
}

async function tools(flags, fresh = false) {
  if (!fresh) {
    try {
      const c = JSON.parse(fs.readFileSync(TOOLS_CACHE, "utf8"));
      if (c.base === BASE && Date.now() - c.at < 3600_000) return c.tools;
    } catch {
      /* no cache */
    }
  }
  const { tools: list } = await rpc("tools/list", {}, flags);
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOOLS_CACHE, JSON.stringify({ base: BASE, at: Date.now(), tools: list }));
  } catch {
    /* the cache is optional */
  }
  return list;
}

async function call(name, args, flags) {
  const res = await rpc("tools/call", { name, arguments: args }, flags);
  const data = res.structuredContent ?? res;
  if (res.isError) fail(typeof data?.result === "string" ? data.result : data?.error || res.content?.[0]?.text || "The tool reported an error.");
  return data;
}

// ------------------------------------------------------------------ arguments

function parseArgv(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") || a === "--") {
      rest.push(a);
      continue;
    }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    k = k.replace(/-/g, "_");
    const vals = v !== undefined ? [v] : [];
    if (v === undefined && !SWITCHES.has(k)) while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) vals.push(argv[++i]);
    (flags[k] ||= []).push(...(vals.length ? vals : [true]));
  }
  return { flags, rest };
}

const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

/** Flags -> the tool's arguments by its schema. A local image or video file is uploaded and replaced by its link. */
async function buildArgs(tool, flags, rest, g) {
  const props = tool.inputSchema?.properties || {};
  const required = tool.inputSchema?.required || [];
  let args = {};
  if (flags.args) {
    try {
      args = JSON.parse(one(flags.args));
    } catch {
      fail("--args must be a JSON object, for example --args '{\"prompt\":\"...\"}'");
    }
  }
  const yesNo = /^(true|false|1|0|yes|no)$/i;
  for (const [k, raw] of Object.entries(flags)) {
    // a yes/no parameter takes no value: the word after it is a plain argument (--mute ./clip.mp4)
    const p = props[k] || (k.startsWith("no_") ? props[k.slice(3)] : null);
    if (p?.type !== "boolean") continue;
    rest.push(...raw.filter((x) => x !== true && !yesNo.test(x)));
    flags[k] = raw.filter((x) => x === true || yesNo.test(x));
    if (!flags[k].length) flags[k] = [true];
  }
  if (rest.length) {
    const first = required.find((k) => !(k in args) && !(k in flags)) || Object.keys(props)[0];
    if (!first) fail(`${tool.name} takes no arguments.`);
    flags[first] = [...(flags[first] || []), ...rest];
  }
  for (const [k, raw] of Object.entries(flags)) {
    if (GLOBAL_FLAGS.has(k) && !(k in props)) continue;
    const neg = k.startsWith("no_") && k.slice(3) in props && props[k.slice(3)].type === "boolean";
    const name = neg ? k.slice(3) : k;
    const p = props[name];
    if (!p) fail(`${tool.name} has no parameter --${k}. It takes: ${Object.keys(props).map((x) => `--${x}`).join(", ") || "nothing"}.`);
    const vals = raw.filter((x) => x !== true);
    if (p.type === "boolean") args[name] = neg ? false : vals.length ? !/^(false|0|no)$/i.test(vals[0]) : true;
    else if (!vals.length) fail(`--${k} needs a value.`);
    else if (p.type === "integer" || p.type === "number") {
      const n = Number(vals[vals.length - 1]);
      if (!Number.isFinite(n)) fail(`--${k} must be a number.`);
      args[name] = n;
    } else if (p.type === "array") args[name] = vals;
    else if (p.type === "object") {
      try {
        args[name] = JSON.parse(vals.join(" "));
      } catch {
        fail(`--${k} must be JSON.`);
      }
    } else args[name] = vals.join(" ");
  }
  if (tool.name !== "upload_media") {
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === "string") args[k] = await localToLink(v, g);
      else if (Array.isArray(v)) args[k] = await Promise.all(v.map((x) => (typeof x === "string" ? localToLink(x, g) : x)));
    }
  }
  const missing = required.filter((k) => args[k] === undefined);
  if (missing.length) fail(`${tool.name} needs ${missing.map((k) => `--${k}`).join(", ")}. See: cartviral help ${tool.name}`);
  return args;
}

function localFile(v) {
  if (/^(https?:|data:)/i.test(v) || v.length > 1000 || /\n/.test(v)) return null;
  const ext = path.extname(v).toLowerCase();
  if (!(ext in MEDIA_EXT)) return null;
  const p = path.resolve(v.replace(/^~(?=\/)/, os.homedir()));
  try {
    return fs.statSync(p).isFile() ? { p, ext } : null;
  } catch {
    return null;
  }
}

async function upload(file, g) {
  const f = localFile(file);
  if (!f) fail(`Not a local image or video: ${file} (${Object.keys(MEDIA_EXT).join(" ")})`);
  const mb = fs.statSync(f.p).size / 1048576;
  if (mb > MEDIA_EXT[f.ext]) fail(`${path.basename(f.p)} is ${mb.toFixed(1)} MB; the limit is ${MEDIA_EXT[f.ext]} MB.`);
  if (!g.quiet) err(`uploading ${path.basename(f.p)} (${mb.toFixed(1)} MB)`);
  const res = await call("upload_media", { data_base64: fs.readFileSync(f.p).toString("base64") }, g);
  if (!res.url) fail("The upload returned no link.");
  return res.url;
}

async function localToLink(v, g) {
  return localFile(v) ? upload(v, g) : v;
}

// ------------------------------------------------------------------ waiting and downloading

const FINAL = new Set(["done", "error", "cancelled", "failed"]);
const SET_LISTS = { generate_photos: ["list_photo_sets", "photo_sets"], generate_carousel: ["list_carousels", "carousels"], generate_static_ads: ["list_static_ads", "static_ads"] };

/** What to poll for a started job, from the result of the call that started it. */
function pollPlan(toolName, res) {
  if (res.job_id) return { tool: "list_creations", args: { job_id: res.job_id }, pick: (d) => d.jobs || [] };
  const jobs = res.queued_jobs || (res.queued_job ? [res.queued_job] : null);
  if (jobs?.length) return { tool: "list_clips", args: { limit: 50 }, pick: (d) => (d.clips || []).filter((c) => jobs.includes(c.job_id)), want: jobs.length };
  if (res.queued_set) {
    const [tool, key] = SET_LISTS[toolName] || [];
    if (tool) return { tool, args: { limit: 50 }, pick: (d) => (d[key] || Object.values(d).find(Array.isArray) || []).filter((s) => s.set_id === res.queued_set), want: 1 };
  }
  return null;
}

async function waitFor(plan, g) {
  const limit = Number(one(g.timeout)) > 0 ? Number(one(g.timeout)) * 1000 : 40 * 60_000;
  const t0 = Date.now();
  let last = "";
  for (;;) {
    const items = plan.pick(await call(plan.tool, plan.args, g));
    const state = items.map((i) => i.status).join(",");
    if (state !== last && !g.quiet) err(`${Math.round((Date.now() - t0) / 1000)} s: ${state || "starting"}`);
    last = state;
    if (items.length >= (plan.want || 1) && items.every((i) => FINAL.has(i.status))) return items;
    if (Date.now() - t0 > limit) fail(`Still not finished after ${Math.round(limit / 60000)} min. Check later: cartviral ${plan.tool}${plan.args.job_id ? ` --job_id ${plan.args.job_id}` : ""}`);
    await sleep(Date.now() - t0 < 60_000 ? 5000 : 12_000);
  }
}

/** Result links worth saving: download and zip links first, plain result links when there are none. */
function resultLinks(v, found = { strong: [], weak: [] }) {
  if (Array.isArray(v)) v.forEach((x) => resultLinks(x, found));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string" && /^https?:\/\//.test(x)) {
        if (/download|zip_url$/.test(k)) found.strong.push(x);
        else if (/(^|_)url$/.test(k) && k !== "stream_url") found.weak.push(x);
      } else resultLinks(x, found);
    }
  }
  return found;
}

const EXT_OF = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/zip": ".zip", "image/gif": ".gif" };

async function download(url, dir, n, g) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) fail(`Could not download ${url}: ${res.status}`);
  const cd = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get("content-disposition") || "");
  let name = cd ? decodeURIComponent(cd[1]) : path.basename(new URL(res.url).pathname);
  if (!path.extname(name)) name += EXT_OF[(res.headers.get("content-type") || "").split(";")[0]] || "";
  name = name.replace(/[^\w.\-]+/g, "_").slice(-120) || `cartviral-${n}`;
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, name);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${path.basename(name, path.extname(name))}-${i}${path.extname(name)}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  if (!g.quiet) err(`saved ${file}`);
  return file;
}

async function saveAll(data, dir, g) {
  const { strong, weak } = resultLinks(data);
  const zips = strong.filter((u) => /\.zip(\?|$)/i.test(u));
  const links = [...new Set(zips.length ? zips : strong.length ? strong : weak)]; // a set's zip already holds its images
  const files = [];
  for (const [i, u] of links.entries()) files.push(await download(u, dir, i + 1, g));
  return files;
}

// ------------------------------------------------------------------ sign-in

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* the link is printed anyway */
  }
}

const PAGE = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>CartViral</title><body style="font:16px -apple-system,Segoe UI,sans-serif;background:#0b0d10;color:#f2f4f7;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px;padding:24px"><h1 style="font-size:22px;margin:0 0 8px">${title}</h1><p style="color:#9aa3ad;margin:0">${text}</p></div></body>`;

async function login(flags) {
  if (flags.key) {
    const key = String(one(flags.key));
    const acc = await call("get_account", {}, { key });
    writeCred({ type: "key", key, base: BASE });
    return acc;
  }
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(12).toString("hex");
  const server = http.createServer();
  await new Promise((ok, no) => server.once("error", no).listen(0, "127.0.0.1", ok));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  try {
    const reg = await fetch(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: `CartViral CLI (${os.hostname().replace(/\.local$/, "").slice(0, 30)})`, redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    }).catch((e) => fail(`Could not reach ${BASE}: ${e.cause?.code || e.message}`));
    const client = await reg.json().catch(() => ({}));
    if (!reg.ok || !client.client_id) fail(`Sign-in could not start: ${client.error_description || reg.status}`);
    const meta = await fetch(`${BASE}/.well-known/oauth-protected-resource`).then((r) => r.json()).catch(() => ({}));
    const url = `${BASE}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, scope: "mcp", resource: meta.resource || `${BASE}/mcp` })}`;
    err("Opening CartViral in your browser to sign in. Press Allow there.");
    err(`If the browser did not open, open this link:\n${url}\n`);
    if (!flags.no_browser && !process.env.CARTVIRAL_NO_BROWSER) openBrowser(url);
    const code = await new Promise((ok, no) => {
      const timer = setTimeout(() => no(new Fail("Nobody pressed Allow within 10 minutes. Run cartviral login again.")), 10 * 60_000);
      server.on("request", (req, res) => {
        const u = new URL(req.url, redirect);
        if (u.pathname !== "/callback") return res.writeHead(404).end();
        const good = u.searchParams.get("state") === state && u.searchParams.get("code");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(good ? PAGE("CartViral is connected", "You can close this tab and go back to the terminal.") : PAGE("Not connected", u.searchParams.get("error_description") || "Access was not allowed. Run cartviral login again."));
        clearTimeout(timer);
        good ? ok(good) : no(new Fail(u.searchParams.get("error") === "access_denied" ? "Access was not allowed in the browser." : `Sign-in failed: ${u.searchParams.get("error_description") || u.searchParams.get("error") || "wrong answer"}`));
      });
    });
    const { ok, body } = await postForm(`${BASE}/oauth/token`, { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier });
    if (!ok || !body.access_token) fail(`Sign-in failed at the last step: ${body.error_description || body.error || "no token"}`);
    writeCred({ type: "oauth", base: BASE, client_id: client.client_id, access_token: body.access_token, refresh_token: body.refresh_token, access_expires_at: Date.now() + (body.expires_in || 3600) * 1000 });
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
  return call("get_account", {}, {});
}

// ------------------------------------------------------------------ the skill for agents

const SKILL = `---
name: cartviral
description: Make product videos, photos, carousels and ads with CartViral from the terminal (cartviral CLI). Use when the user asks for a product video, a UGC or creator clip, an ad, product photos, a carousel, a brand film, a talking photo, to swap a product inside a video, to remake a TikTok or Reel with their product, or mentions CartViral.
---

# CartViral

CartViral turns a product (a store link, a marketplace link or photos) into short videos, photos, carousels and ads.
The \`cartviral\` command runs it. Results are links and files.

## Before the first call

1. \`cartviral whoami\` shows the account and the credit balance.
2. "Not signed in" means: run \`cartviral login\`. It opens the browser, the user presses Allow, the command finishes by itself. Wait for it.
3. No \`cartviral\` command: \`curl -fsSL https://cartviral.com/install.sh | sh\`, then use \`~/.local/bin/cartviral\` until a new terminal is opened.

## How to work

- \`cartviral tools\` lists everything it can do; \`cartviral help <tool>\` shows a tool's parameters. Read the help of a tool before its first use: parameters differ.
- Run a tool: \`cartviral <tool> --param value\`. A local image or video path is uploaded automatically.
- Add \`--wait --out <folder>\`: the command waits until the result is ready and saves the files. Videos take 5 to 15 minutes, images under a minute.
- Every call prints JSON. \`credits_charged\` is what it cost; tell the user the price before a big batch.
- A job that is already running: \`cartviral list_creations --job_id <id>\` or \`cartviral list_clips\`.

## Common asks

\`\`\`bash
cartviral import_products https://mystore.com          # bring the catalog in (a store, Amazon or marketplace link)
cartviral list_products                                 # product ids
cartviral generate_clips --product_id <id> --clip_type ai_story --count 1 --wait --out ./clips
cartviral create_video --prompt "a hand opens the box, soft daylight" --reference_images ./product.jpg --wait --out ./out
cartviral edit_video --video ./ad.mp4 --prompt "replace the bottle with my can from the photo" --product_images ./can.jpg --wait --out ./out
cartviral create_image --prompt "product on a marble table, morning light" --reference_images ./product.jpg --wait --out ./out
cartviral remake_from_reference --reference_url https://www.tiktok.com/@brand/video/123 --product_id <id> --wait --out ./clips
cartviral generate_photos --product_id <id> --format photo_model --wait --out ./photos
cartviral remove_background --image ./product.jpg --wait --out ./out
\`\`\`

Tools and parameters grow over time: \`cartviral tools\` and \`cartviral help <tool>\` are always current.

## Rules

- Do not invent product facts: use what the product page or the user gives.
- Not enough credits: say how many are missing and that plans and top-ups are at https://app.cartviral.com/account/billing.
- Never print the contents of ~/.config/cartviral/credentials.json.
`;

function installSkill(flags) {
  const root = flags.project ? path.join(process.cwd(), ".claude") : path.join(os.homedir(), ".claude");
  const dir = path.join(root, "skills", "cartviral");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL);
  return path.join(dir, "SKILL.md");
}

// ------------------------------------------------------------------ commands

const USAGE = `CartViral ${VERSION}: product videos, photos and ads from the terminal.

  cartviral login                 sign in in the browser (press Allow there)
  cartviral login --key <key>     sign in with an API key instead (servers, CI)
  cartviral whoami                the account and its credits
  cartviral tools                 everything CartViral can do
  cartviral help <tool>           a tool's parameters
  cartviral <tool> --param value  run a tool; a local image or video path is uploaded for you
  cartviral upload <file>         store a local image or video, prints its link
  cartviral download <link> ...   save result files (--out <folder>)
  cartviral skill install         teach Claude Code to use CartViral (--project: only this folder)
  cartviral update                get the newest version (installs made with install.sh)
  cartviral logout                forget the sign-in on this computer

Options for any tool:
  --wait            wait until the result is ready (videos take 5 to 15 minutes)
  --out <folder>    with --wait: save the result files there
  --args '{...}'    the tool's arguments as JSON
  --timeout <sec>   how long --wait may take (default 2400)
  --quiet           no progress lines

Example:
  cartviral create_video --prompt "a hand opens the box, soft daylight" --reference_images ./product.jpg --wait --out ./out

Guide: ${SITE}/mcp`;

function firstSentence(s) {
  const t = String(s || "").replace(/\s+/g, " ");
  const m = /^(.{20,150}?[.!?])(\s|$)/.exec(t);
  return m ? m[1] : t.slice(0, 150);
}

function describe(tool) {
  const props = tool.inputSchema?.properties || {};
  const req = new Set(tool.inputSchema?.required || []);
  const lines = [`${tool.name}: ${tool.title || ""}`.trim(), "", String(tool.description || "").trim(), ""];
  const keys = Object.keys(props);
  if (!keys.length) lines.push("No parameters.");
  for (const k of keys) {
    const p = props[k];
    const type = p.type === "array" ? `${p.items?.type || "value"} ...` : p.enum ? p.enum.join(" | ") : p.type || "value";
    const extra = [req.has(k) ? "required" : null, p.default !== undefined ? `default ${JSON.stringify(p.default)}` : null, p.minimum !== undefined || p.maximum !== undefined ? `${p.minimum ?? ""}..${p.maximum ?? ""}` : null].filter(Boolean).join(", ");
    lines.push(`  --${k} <${type}>${extra ? `  (${extra})` : ""}`);
    if (p.description) lines.push(`      ${String(p.description).replace(/\s+/g, " ")}`);
  }
  lines.push("", `Run: cartviral ${tool.name}${[...req].map((k) => ` --${k} ...`).join("")} [--wait --out <folder>]`);
  return lines.join("\n");
}

async function main() {
  const { flags, rest } = parseArgv(process.argv.slice(2));
  const g = { key: one(flags.key), quiet: Boolean(flags.quiet), timeout: flags.timeout };
  const cmd = (rest.shift() || (flags.version ? "version" : "help")).replace(/-/g, "_");
  const asJson = Boolean(flags.json);

  if (cmd === "version") return out(VERSION);
  if (cmd === "help" && !rest.length) return out(USAGE);
  if (cmd === "login") {
    const acc = await login({ key: flags.key, no_browser: Boolean(flags.no_browser) });
    try {
      fs.rmSync(TOOLS_CACHE, { force: true });
    } catch {
      /* optional */
    }
    return out(asJson ? pretty(acc) : `Signed in as ${acc.email}. Plan: ${acc.plan ?? "free"}. Credits: ${acc.credits?.total ?? acc.credits ?? "?"}.\nNext: cartviral tools`);
  }
  if (cmd === "logout") {
    const c = readCred();
    if (c?.type === "oauth") await postForm(`${c.base}/oauth/revoke`, { token: c.refresh_token, client_id: c.client_id }).catch(() => {});
    fs.rmSync(CRED, { force: true });
    fs.rmSync(TOOLS_CACHE, { force: true });
    return out("Signed out on this computer.");
  }
  if (cmd === "update") {
    const self = fs.realpathSync(process.argv[1]);
    if (/node_modules/.test(self)) return out("Installed with npm. Update with: npm i -g cartviral@latest   (npx -y cartviral@latest always runs the newest)");
    const res = await fetch(`${SITE}/cli/cartviral.mjs`).catch(() => null);
    const text = res?.ok ? await res.text() : "";
    const v = /const VERSION = "([\d.]+)"/.exec(text)?.[1];
    if (!v || !text.startsWith("#!/usr/bin/env node")) fail(`Could not download the new version from ${SITE}/cli/cartviral.mjs`);
    if (v === VERSION) return out(`Already the newest version (${VERSION}).`);
    fs.writeFileSync(`${self}.new`, text, { mode: 0o755 });
    fs.renameSync(`${self}.new`, self);
    return out(`Updated ${VERSION} -> ${v}.`);
  }
  if (cmd === "skill") {
    if (rest[0] === "print") return out(SKILL.trimEnd());
    if (rest[0] !== "install") fail("Use: cartviral skill install [--project]");
    return out(`The CartViral skill is installed: ${installSkill({ project: Boolean(flags.project) })}\nStart a new Claude Code session and ask for a product video.`);
  }
  if (cmd === "download") {
    if (!rest.length) fail("Use: cartviral download <link> [<link> ...] [--out <folder>]");
    const files = [];
    for (const [i, u] of rest.entries()) files.push(await download(u, String(one(flags.out) || "."), i + 1, g));
    return out(asJson ? pretty({ files }) : files.join("\n"));
  }
  if (cmd === "upload") {
    if (!rest.length) fail("Use: cartviral upload <file>");
    const links = [];
    for (const f of rest) links.push(await upload(f, g));
    return out(asJson ? pretty({ links }) : links.join("\n"));
  }
  if (cmd === "whoami") {
    const acc = await call("get_account", {}, g);
    return out(asJson ? pretty(acc) : `${acc.email}\nPlan: ${acc.plan ?? "free"}\nCredits: ${acc.credits?.total ?? acc.credits ?? "?"}`);
  }

  const list = await tools(g);
  if (cmd === "tools") {
    if (asJson) return out(pretty(list.map((t) => ({ name: t.name, title: t.title, description: t.description }))));
    const w = Math.max(...list.map((t) => t.name.length));
    return out(`${list.map((t) => `  ${t.name.padEnd(w)}  ${t.title || firstSentence(t.description)}`).join("\n")}\n\nParameters of a tool: cartviral help <tool>`);
  }
  const find = (n) => list.find((t) => t.name === String(n || "").replace(/-/g, "_"));
  if (cmd === "help") {
    const t = find(rest[0]) || (await tools(g, true)).find((x) => x.name === String(rest[0]).replace(/-/g, "_"));
    if (!t) fail(`No tool called ${rest[0]}. See: cartviral tools`);
    return out(asJson ? pretty(t) : describe(t));
  }
  const name = cmd === "call" ? String(rest.shift() || "").replace(/-/g, "_") : cmd;
  const tool = find(name) || (await tools(g, true)).find((t) => t.name === name);
  if (!tool) fail(`cartviral has no command or tool "${name}". See: cartviral tools`);
  if (flags.help) return out(describe(tool));

  delete flags.json;
  const args = await buildArgs(tool, flags, rest, g);
  let data = await call(tool.name, args, g);
  const plan = flags.wait ? pollPlan(tool.name, data) : null;
  if (plan) {
    if (!g.quiet) err("started, waiting for the result (Ctrl+C stops the waiting, not the job)");
    const items = await waitFor(plan, g);
    data = { ...data, results: items };
    delete data.next;
    if (flags.out) data.files = await saveAll(items, String(one(flags.out)), g);
    const bad = items.filter((i) => i.status !== "done");
    out(pretty(data));
    if (bad.length) fail(`${bad.length} of ${items.length} did not finish: ${bad.map((b) => b.error || b.status).join("; ")}`);
    return;
  }
  if (flags.out && !flags.wait) data.files = await saveAll(data, String(one(flags.out)), g);
  out(pretty(data));
}

main().catch((e) => {
  err(e instanceof Fail ? `cartviral: ${e.message}` : `cartviral: unexpected error: ${e?.stack || e}`);
  process.exit(1);
});
