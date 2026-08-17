#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="$root/apps/omdsh/lib/bin.js"
prefix="$(npm prefix -g)"
target="$prefix/bin/omdsh"

if ! command -v npm >/dev/null 2>&1; then
  printf 'install-local: npm is required\n' >&2
  exit 1
fi

pnpm --dir "$root" build
if [[ ! -f "$bin" ]]; then
  printf 'install-local: missing %s after build\n' "$bin" >&2
  exit 1
fi

npm uninstall --global @agi-fans/oh-my-dsh @vanducng/oh-my-dsh >/dev/null 2>&1 || true
mkdir -p "$prefix/bin"
ln -sfn "$bin" "$target"
chmod +x "$bin"

printf 'omdsh -> %s\n' "$(readlink "$target")"
"$target" --version
