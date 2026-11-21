#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ulimit -v 8388608
cases=(claude-fixtures codex-fixtures exchanges fake-im fixture-hygiene hold im-buttons input-history local panels pi-driver pi-fixtures qq-scan render session-processes temp-dirs terminal-select ticks topology-model transcript tui-anthropic-env unread plugin-sdk plugin-loader plugin-agent plugin-im plugin-env)
files=()
for name in "${cases[@]}"; do
  file="test/$name.test.ts"
  [[ -f "$file" ]] || file="${file}x"
  [[ -f "$file" ]]
  files+=("./$file")
done
# Isolate process-local registries and RSS measurements across suites (as bun test --parallel does locally).
for file in "${files[@]}"; do
  timeout 3m bun --config=bunfig.ci.toml test "$file"
done
timeout 2m bun scripts/plugin-conformance.ts --check-docs
export RHODIUM_TEST_DETACHED=1 RHODIUM_TEST_EXE="$PWD/dist/rhodium"
test -x "$RHODIUM_TEST_EXE"
test -x dist/rh-hold
timeout 2m bun --config=bunfig.ci.toml test ./test/plugin-e2e.test.ts
