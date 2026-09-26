#!/usr/bin/env bash
# Push the current branch and wait for its ci.yml run. Prints CI PASS/FAIL.
set -euo pipefail
branch=$(git branch --show-current)
sha=$(git rev-parse HEAD)
git push -q -u origin "$branch"
id=""
for _ in $(seq 1 60); do
  id=$(gh run list --branch "$branch" --commit "$sha" --workflow ci.yml --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  [ -n "$id" ] && break
  sleep 5
done
[ -n "$id" ] || { echo "CI run not found for $sha"; exit 2; }
if gh run watch "$id" --exit-status --interval 10 >/dev/null; then
  echo "CI PASS ($id)"
else
  gh run view "$id" --log-failed | tail -120
  echo "CI FAIL ($id)"
  exit 1
fi
