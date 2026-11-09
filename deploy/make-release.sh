#!/usr/bin/env bash
# Run from the repo on a development machine. Builds the files a GitHub release carries, in out/<version>/:
#   install.sh, update-bossmox.sh, bossmox.tgz and bossmox.tgz.sha256
# The install and update one-liners download these from the latest release. It then prints the command that
# makes the release as a draft, which the maintainer reads over and publishes.
#
# Usage: deploy/make-release.sh [label]     label defaults to "preview"; use "" for a full release.
set -euo pipefail

LABEL=${1-preview}
npm test >/dev/null
[ -z "$(git status --porcelain)" ] || { echo "Commit first, so the release matches a commit." >&2; exit 1; }
BASE=$(node -p 'require("./package.json").version')
COMMIT=$(git rev-parse --short HEAD)
# Says what it is, when it was built and from which commit: 0.1.0-preview.20261109.abc1234
VERSION="$BASE${LABEL:+-$LABEL}.$(date -u +%Y%m%d).$COMMIT"
TAG="v$BASE${LABEL:+-$LABEL}"

OUT="out/$VERSION"
rm -rf "$OUT"
mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
echo "$VERSION" > "$WORK/VERSION"
tar -czf "$OUT/bossmox.tgz" dist/src public deploy package.json node_modules/ws LICENSE -C "$WORK" VERSION
cp deploy/install.sh deploy/update-bossmox.sh "$OUT/"
(cd "$OUT" && sha256sum bossmox.tgz > bossmox.tgz.sha256)

echo "Built $VERSION in $OUT"
echo "To make the draft release (read it over on GitHub, then publish):"
echo "  gh release create $TAG --repo bossmox/bossmox --draft ${LABEL:+--prerelease }--title \"BossMox $BASE${LABEL:+ $LABEL}\" --notes-file docs/release-notes/$TAG.md $OUT/install.sh $OUT/update-bossmox.sh $OUT/bossmox.tgz $OUT/bossmox.tgz.sha256"
