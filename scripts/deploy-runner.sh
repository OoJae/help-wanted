#!/usr/bin/env bash
# Deploys the runner bot (bots/runner) to Railway from this folder, without going through GitHub.
#
#   bash scripts/deploy-runner.sh
#
# The first run creates the service in the Railway project this folder is linked to (see
# scripts/deploy-web.sh, which links it), points it at bots/runner/Dockerfile and gives it a
# persistent volume at /data for the runner's store. Later runs deploy again to the same service.
# Only what the runner's Dockerfile copies is uploaded: the workspace files, packages/shared and
# bots/runner, without any .env file or local store.
#
# No key is set here. The service starts as a dry run. To go live, set RUNNER_PRIVATE_KEY and
# LIVE=1 on the service yourself, in Railway's Variables page (bots/runner/README.md, "Going live").
#
# Needs the Railway CLI, signed in (`railway login`), and rsync.
#
#   RAILWAY_SERVICE   the service's name (default: runner)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="${RAILWAY_SERVICE:-runner}"

cd "$ROOT"
command -v railway >/dev/null || { echo "the Railway CLI is not installed" >&2; exit 1; }
railway whoami >/dev/null 2>&1 || { echo "not signed in: run 'railway login' first" >&2; exit 1; }
railway status >/dev/null 2>&1 || { echo "this folder is not linked to a Railway project: run scripts/deploy-web.sh first" >&2; exit 1; }

# Read the list first: with pipefail, a grep that stops at its first match can fail the pipe.
SERVICES="$(railway service list 2>/dev/null || true)"
if ! grep -qw "$SERVICE" <<<"$SERVICES"; then
  echo "== creating the service '$SERVICE'"
  railway add --service "$SERVICE"
  echo "== set its Dockerfile path to bots/runner/Dockerfile and attach a volume at /data before it can run live"
fi

# What the Dockerfile copies, and nothing else.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
CTX="$STAGE/help-wanted-runner"
mkdir -p "$CTX/bots" "$CTX/packages"
cp package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json "$CTX/"
rsync -a --exclude node_modules --exclude data --exclude test --exclude '.env' --exclude '.env.*' \
  --exclude '*.KILL' bots/runner "$CTX/bots/"
rsync -a --exclude node_modules --exclude dist --exclude test --exclude scripts \
  --exclude fixtures --exclude vectors packages/shared "$CTX/packages/"
if grep -rqsE "RUNNER_PRIVATE_KEY=0x[0-9a-fA-F]{64}|KEEPER_PRIVATE_KEY=0x[0-9a-fA-F]{64}" "$CTX"; then
  echo "refusing to upload: a file in the upload holds a private key" >&2
  exit 1
fi
echo "== uploading $(find "$CTX" -type f | wc -l | tr -d ' ') files and building"

railway up "$CTX" --path-as-root --service "$SERVICE" --ci
