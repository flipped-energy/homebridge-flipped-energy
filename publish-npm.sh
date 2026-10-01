#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
./build.sh
name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
registry=https://registry.npmjs.org/
npmrc=$(mktemp)
trap 'rm -f "$npmrc"' EXIT
printf '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n' > "$npmrc"
published=$(npm view "$name@$version" version --userconfig "$npmrc" --registry "$registry") || true
if [ "$published" = "$version" ]; then
  printf '%s@%s is already on npm\n' "$name" "$version"
  exit 0
fi
npm publish --access public --ignore-scripts --userconfig "$npmrc" --registry "$registry"
