#!/usr/bin/env bash
# Real end-to-end check against BotConnector Cloud. Needs BOTCONNECTOR_API_KEY.
set -euo pipefail
BCCLI_HOME="$(mktemp -d)"
export BCCLI_HOME
out=$(node dist/cli.js -p "Reply with exactly the word: pong" --model bc-cloud/glm-5.3-flash)
echo "model said: $out"
echo "$out" | grep -qi pong
