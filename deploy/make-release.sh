#!/usr/bin/env bash
# Run from the repo on a development machine. Builds what a Proxmox node installs and pushes it to the
# `release` branch, which holds only install.sh, bossmox.tgz and its checksum.
set -euo pipefail

npm test >/dev/null
VERSION=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain)" ] || { echo "Commit first, so the release matches a commit." >&2; exit 1; }

WORK=$(mktemp -d)
trap 'git worktree remove --force "$WORK/tree" 2>/dev/null || true; rm -rf "$WORK"' EXIT
tar -czf "$WORK/bossmox.tgz" dist/src public deploy package.json node_modules/ws

git fetch -q origin release 2>/dev/null || true
if git rev-parse -q --verify origin/release >/dev/null; then
  git worktree add -q -B release "$WORK/tree" origin/release
else
  git worktree add -q --detach "$WORK/tree"
  git -C "$WORK/tree" checkout -q --orphan release
  git -C "$WORK/tree" rm -rfq .
fi
cp deploy/install.sh "$WORK/bossmox.tgz" "$WORK/tree/"
(cd "$WORK/tree" && sha256sum bossmox.tgz > bossmox.tgz.sha256)
git -C "$WORK/tree" add install.sh bossmox.tgz bossmox.tgz.sha256
git -C "$WORK/tree" -c user.name="Rocky Lott" -c user.email="41306447+twogunrock@users.noreply.github.com" commit -q -m "Release $VERSION"
git -C "$WORK/tree" push -q origin release
echo "Released $VERSION"
