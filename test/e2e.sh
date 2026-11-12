#!/bin/bash
# End-to-end test of the CLI against a local copy of the app (the real server code and a test database).
#   APP=<cartviral-app checkout> DB=<test sqlite> CARTVIRAL_URL=http://127.0.0.1:3491 bash test/e2e.sh
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $HERE/cartviral.mjs"
export CARTVIRAL_CONFIG_DIR="$(mktemp -d)"
export CARTVIRAL_NO_BROWSER=1
TMP="$(mktemp -d)"
pass=0; failn=0
ok() { if [ "$1" = "0" ]; then pass=$((pass+1)); echo "  ok $2"; else failn=$((failn+1)); echo "  FAIL $2"; fi; }
approve() { (cd "$APP" && DATABASE_URL="file:$DB" WEB_SESSION_SECRET=cli-e2e npx tsx scripts/cli-e2e-approve.ts "$1" ${2:-} 2>&1 | grep -E "APPROVED|REFUSED|NO REDIRECT|Error" | tail -1); }
login() { # $1 = deny?
  $CLI login > "$TMP/login.out" 2> "$TMP/login.err" &
  pid=$!
  for _ in $(seq 1 40); do grep -q "oauth/authorize" "$TMP/login.err" 2>/dev/null && break; perl -e 'select(undef,undef,undef,0.25)'; done
  url=$(grep -o "http[^ ]*oauth/authorize[^ ]*" "$TMP/login.err" | head -1)
  echo "  approve: $(approve "$url" ${1:-})"
  wait $pid; return $?
}

echo "not signed in"
$CLI whoami > /dev/null 2> "$TMP/e"; [ $? -ne 0 ] && grep -q "cartviral login" "$TMP/e"; ok $? "whoami without a sign-in says to run login"

echo "login in the browser"
login; ok $? "login finishes after Allow"
grep -q "Signed in as cli-e2e@example.com" "$TMP/login.out"; ok $? "login prints the account"
[ "$(stat -f %Lp "$CARTVIRAL_CONFIG_DIR/credentials.json" 2>/dev/null || stat -c %a "$CARTVIRAL_CONFIG_DIR/credentials.json")" = "600" ]; ok $? "credentials file is private (600)"

echo "commands"
$CLI whoami | grep -q "cli-e2e@example.com"; ok $? "whoami"
$CLI whoami --json | grep -q '"total"'; ok $? "whoami --json"
n=$($CLI tools | grep -c "^  [a-z_]* ")
[ "$n" -ge 30 ]; ok $? "tools lists the server's tools ($n)"
$CLI --json tools | grep -q '"create_video"'; ok $? "a switch before the command does not swallow it"
$CLI help create_video | grep -q -- "--prompt"; ok $? "help <tool> shows parameters"
$CLI help create-video | grep -q -- "--prompt"; ok $? "dashes work in tool names"
$CLI list_products --limit 3 | grep -q "{"; ok $? "a read tool runs and prints JSON"
$CLI list_creations --limit 2 | grep -q '"jobs"'; ok $? "list_creations"
$CLI create_video --nonsense 1 > /dev/null 2> "$TMP/e"; grep -q "has no parameter --nonsense" "$TMP/e"; ok $? "an unknown parameter is named"
$CLI create_video > /dev/null 2> "$TMP/e"; grep -q "needs --" "$TMP/e"; ok $? "a missing required parameter is named"
$CLI nope > /dev/null 2> "$TMP/e"; grep -q 'no command or tool "nope"' "$TMP/e"; ok $? "an unknown command is named"

echo "upload a local file"
python3 - "$TMP/p.png" <<'PY'
import struct, zlib, sys
w = h = 64
raw = b"".join(b"\x00" + bytes([(x * 4) % 256, (y * 4) % 256, 120]) * 1 for y in range(h) for x in range(1))
rows = b"".join(b"\x00" + b"".join(bytes([(x * 4) % 256, (y * 4) % 256, 120]) for x in range(w)) for y in range(h))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
PY
link=$($CLI upload "$TMP/p.png" 2> "$TMP/e"); echo "$link" | grep -q "^https\?://.*/u/"; ok $? "upload prints a /u/ link (${link:-$(cat "$TMP/e")})"
$CLI upload "$TMP/nope.png" > /dev/null 2> "$TMP/e"; grep -q "Not a local image or video" "$TMP/e"; ok $? "a missing file is refused before any call"

echo "the sign-in refreshes itself"
python3 - "$CARTVIRAL_CONFIG_DIR/credentials.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p)); c["access_expires_at"] = 0; json.dump(c, open(p, "w"))
PY
old=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['refresh_token'])" "$CARTVIRAL_CONFIG_DIR/credentials.json")
$CLI whoami | grep -q "cli-e2e@example.com"; ok $? "an expired access token is refreshed"
new=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['refresh_token'])" "$CARTVIRAL_CONFIG_DIR/credentials.json")
[ "$old" != "$new" ]; ok $? "the refresh token rotated"
python3 - "$CARTVIRAL_CONFIG_DIR/credentials.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p)); c["access_expires_at"] = 0; json.dump(c, open(p, "w"))
PY
for i in 1 2 3 4 5 6; do ($CLI whoami > "$TMP/par$i" 2>&1; echo $? > "$TMP/parc$i") & done; wait
bad=0; for i in 1 2 3 4 5 6; do [ "$(cat "$TMP/parc$i")" = "0" ] || bad=$((bad+1)); done
[ "$bad" = "0" ]; ok $? "6 commands at once with an expired token all work (one refresh, no lost sign-in)"
$CLI whoami | grep -q "cli-e2e@example.com"; ok $? "the sign-in is still alive after that"

echo "the skill"
(cd "$TMP" && $CLI skill install --project > /dev/null && grep -q "^name: cartviral" "$TMP/.claude/skills/cartviral/SKILL.md"); ok $? "skill install --project writes SKILL.md"

echo "logout, a refused sign-in, an API key"
$CLI logout > /dev/null; $CLI whoami > /dev/null 2>&1; [ $? -ne 0 ]; ok $? "logout forgets the sign-in"
login deny; [ $? -ne 0 ] && grep -q "not allowed" "$TMP/login.err"; ok $? "pressing Deny ends login with a clear message"
CARTVIRAL_API_KEY=cv_live_wrong $CLI whoami > /dev/null 2> "$TMP/e"; grep -q "API key is not valid" "$TMP/e"; ok $? "a wrong API key is named"

echo; echo "$pass passed, $failn failed"; [ "$failn" = "0" ]
