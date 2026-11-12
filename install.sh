#!/bin/sh
# CartViral CLI installer:  curl -fsSL https://cartviral.com/install.sh | sh
# Puts one file into ~/.cartviral and a `cartviral` command into ~/.local/bin. Needs Node.js 18 or newer.
set -e
SRC="${CARTVIRAL_CLI_URL:-https://cartviral.com/cli/cartviral.mjs}"
HOME_DIR="$HOME/.cartviral"
BIN_DIR="${CARTVIRAL_BIN_DIR:-$HOME/.local/bin}"

if ! command -v node >/dev/null 2>&1; then
  echo "CartViral needs Node.js 18 or newer, and it is not installed."
  echo "Install it from https://nodejs.org (the LTS button), then run this line again."
  exit 1
fi
MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo "CartViral needs Node.js 18 or newer; this computer has $(node -v)."
  echo "Update it from https://nodejs.org, then run this line again."
  exit 1
fi

mkdir -p "$HOME_DIR" "$BIN_DIR"
if command -v curl >/dev/null 2>&1; then curl -fsSL "$SRC" -o "$HOME_DIR/cartviral.mjs.new"; else wget -qO "$HOME_DIR/cartviral.mjs.new" "$SRC"; fi
head -1 "$HOME_DIR/cartviral.mjs.new" | grep -q "^#!/usr/bin/env node" || { echo "The download from $SRC is not the CartViral CLI. Nothing was installed."; rm -f "$HOME_DIR/cartviral.mjs.new"; exit 1; }
mv "$HOME_DIR/cartviral.mjs.new" "$HOME_DIR/cartviral.mjs"
chmod +x "$HOME_DIR/cartviral.mjs"
ln -sf "$HOME_DIR/cartviral.mjs" "$BIN_DIR/cartviral"

echo "CartViral $("$BIN_DIR/cartviral" --version) is installed: $BIN_DIR/cartviral"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    # put the folder on PATH for new terminals (once), like other installers do
    case "${SHELL:-}" in
      */zsh) RC="$HOME/.zshrc" ;;
      */bash) RC="$HOME/.bashrc"; [ "$(uname)" = "Darwin" ] && RC="$HOME/.bash_profile" ;;
      *) RC="$HOME/.profile" ;;
    esac
    LINE="export PATH=\"$BIN_DIR:\$PATH\""
    grep -qsF "$BIN_DIR" "$RC" || printf '\n# CartViral CLI\n%s\n' "$LINE" >> "$RC"
    echo
    echo "Open a new terminal window so the cartviral command is found (added to $RC)."
    echo "In this window the full path works right now: $BIN_DIR/cartviral"
    ;;
esac
echo
echo "Next:"
echo "  cartviral login            sign in in the browser"
echo "  cartviral skill install    teach Claude Code to use it"
echo "  cartviral tools            what it can do"
