#!/usr/bin/env bash
# Attach this version's tarball to the release that was just created.
#
# Split out of the shell one-liner: the credential helper and the GitHub calls each need their own exit status to be
# readable, and a single `&&` chain turns any of them into "no output at all".
set -euo pipefail
# The tarball sits at the package root, one level up from this script.
cd "$(dirname "$0")/.."

TAG="${1:-v0.5.0}"
FILE="dsh-foreman-node-${TAG#v}.tgz"
REPO="niechao136/dsh-foreman-node"
GCM="/c/Program Files/Git/mingw64/bin/git-credential-manager.exe"

[ -f "$FILE" ] || { echo "missing $FILE — run npm pack first" >&2; exit 1; }

TOK=$(printf 'protocol=https\nhost=github.com\npath=%s.git\n\n' "$REPO" | "$GCM" get | awk -F= '/^password=/{print $2}' | tr -d '\r')
[ -n "$TOK" ] || { echo "no GitHub credential" >&2; exit 1; }

api() { curl -sS -m 60 -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" "$@"; }

ID=$(api "https://api.github.com/repos/$REPO/releases/tags/$TAG" | python -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "release $TAG id=$ID"

curl -sS -m 300 -X POST -H "Authorization: Bearer $TOK" -H "content-type: application/octet-stream" \
  --data-binary @"$FILE" \
  "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=$(basename "$FILE")" |
  python -c "import json,sys; d=json.load(sys.stdin); print(d.get('browser_download_url') or d)"

# The asset is only proof of publishing if it is the same bytes npm took.
api "https://api.github.com/repos/$REPO/releases/tags/$TAG" |
  python -c "import json,sys; d=json.load(sys.stdin); print('assets:', [a['name'] for a in d['assets']])"
