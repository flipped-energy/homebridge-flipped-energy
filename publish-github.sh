#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$GH_DEPLOY_KEY" > "$work/key"
chmod 600 "$work/key"
export GIT_SSH_COMMAND="ssh -i $work/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
remote=git@github.com:flipped-energy/homebridge-flipped-energy.git
identity=(-c user.name=flipped-iot-ci -c user.email=flipped-iot-ci@localhost)
git fetch -q "$remote" main
parent=$(git rev-parse FETCH_HEAD)
GIT_INDEX_FILE="$work/index" git add -A .
tree=$(GIT_INDEX_FILE="$work/index" git write-tree --prefix=homebridge-flipped-energy/)
commit=$(git "${identity[@]}" commit-tree "$tree" -p "$parent" -m "Release v$version")
notes=$(node --experimental-strip-types --no-warnings=ExperimentalWarning ../scripts/changelog-section.ts CHANGELOG.md "$version")
printf '%s\n\nnpm: [`%s@%s`](https://www.npmjs.com/package/%s/v/%s)\n' "$notes" "$name" "$version" "$name" "$version" > "$work/notes"
git "${identity[@]}" tag -a "v$version" -F "$work/notes" "$commit"
git push "$remote" "$commit:refs/heads/main" "refs/tags/v$version"
printf 'GitHub main is %s, tag v%s pushed\n' "$commit" "$version"
