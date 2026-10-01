#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
name=$(node -p "require('./package.json').name")
registry=https://registry.npmjs.org/
npmrc=$(mktemp)
trap 'rm -f "$npmrc"' EXIT
printf '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n' > "$npmrc"
published=$(npm view "$name" versions --json --userconfig "$npmrc" --registry "$registry")
build=$(node -e '
const base = require("node:fs").readFileSync("../VERSION", "utf8").trim()
const patches = [].concat(JSON.parse(process.argv[1])).filter((v) => v.startsWith(`${base}.`)).map((v) => Number(v.slice(base.length + 1)))
console.log(patches.length === 0 ? 0 : Math.max(...patches) + 1)
' "$published")
node --experimental-strip-types --no-warnings=ExperimentalWarning ../scripts/version.ts stamp "$build"
./build.sh
npm publish --access public --ignore-scripts --userconfig "$npmrc" --registry "$registry"
