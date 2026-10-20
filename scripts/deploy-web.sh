#!/usr/bin/env bash
# Deploys the site (apps/web) to Railway from this folder, without going through GitHub.
#
#   bash scripts/deploy-web.sh
#
# The first run creates a Railway project and a service in it; later runs deploy again to the
# same service. Only what the site's Dockerfile copies is uploaded: the workspace files,
# apps/web and packages/shared. The site holds no key, so there is no secret to set.
#
# Needs the Railway CLI, signed in (`railway login`), and rsync.
#
#   RAILWAY_PROJECT_NAME   the project to create on the first run (default: help-wanted)
#   RAILWAY_WORKSPACE      the workspace to create it in (needed when not run from a terminal)
#   RAILWAY_SERVICE        the service's name (default: web)
#   REPO_URL               the repository the site links to
#   GIT_COMMIT             the commit to stamp (default: the public commit with this tree, else HEAD)
#   ALLOW_DIRTY=1          deploy uncommitted changes too (otherwise the script refuses)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_NAME="${RAILWAY_PROJECT_NAME:-help-wanted}"
SERVICE="${RAILWAY_SERVICE:-web}"
REPO_URL="${REPO_URL:-https://github.com/OoJae/help-wanted}"

cd "$ROOT"
command -v railway >/dev/null || { echo "the Railway CLI is not installed" >&2; exit 1; }
railway whoami >/dev/null 2>&1 || { echo "not signed in: run 'railway login' first" >&2; exit 1; }

if ! railway status >/dev/null 2>&1; then
  echo "== creating the Railway project '$PROJECT_NAME' and linking this folder to it"
  if [ -n "${RAILWAY_WORKSPACE:-}" ]; then
    railway init --name "$PROJECT_NAME" --workspace "$RAILWAY_WORKSPACE"
  else
    railway init --name "$PROJECT_NAME"
  fi
fi

# Read the list first: with pipefail, a grep that stops at its first match can fail the pipe. A list
# that cannot be read stops the script: guessing that the service is missing would try to create it.
if ! SERVICES="$(railway service list --json 2>/dev/null)" || [ -z "$SERVICES" ]; then
  echo "could not read this project's services from Railway; try again in a moment" >&2
  exit 1
fi
if ! jq -e --arg s "$SERVICE" 'any(.[]; .name == $s)' >/dev/null <<<"$SERVICES"; then
  echo "== creating the service '$SERVICE'"
  railway add --service "$SERVICE" --variables "REPO_URL=$REPO_URL"
fi

# Only committed source goes live, so the commit the site names is the code it runs.
BUILT_FROM=(apps/web packages/shared package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json railway.toml)
if [ -n "$(git status --porcelain -- "${BUILT_FROM[@]}")" ] && [ "${ALLOW_DIRTY:-}" != 1 ]; then
  echo "refusing to deploy: what the site is built from has uncommitted changes" >&2
  echo "(commit them first, or set ALLOW_DIRTY=1 to deploy them anyway)" >&2
  exit 1
fi

# The commit /api/v1/status names: GIT_COMMIT when set, else the public commit with this exact
# tree (origin/main or the local public-main), else HEAD.
COMMIT="${GIT_COMMIT:-}"
if [ -z "$COMMIT" ]; then
  TREE="$(git rev-parse 'HEAD^{tree}')"
  for ref in origin/main public-main; do
    if git rev-parse -q --verify "$ref" >/dev/null && [ "$(git rev-parse "$ref^{tree}")" = "$TREE" ]; then
      COMMIT="$(git rev-parse "$ref")"
      break
    fi
  done
fi
COMMIT="${COMMIT:-$(git rev-parse HEAD)}"
echo "== stamping commit $COMMIT"
railway variable set "GIT_COMMIT=$COMMIT" --service "$SERVICE" --skip-deploys >/dev/null

# What the Dockerfile copies, and nothing else.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
CTX="$STAGE/help-wanted-web"
mkdir -p "$CTX/apps" "$CTX/packages"
cp package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json railway.toml "$CTX/"
rsync -a --exclude node_modules --exclude dist --exclude .astro --exclude .shots --exclude test \
  --exclude '.env' --exclude '.env.*' apps/web "$CTX/apps/"
rsync -a --exclude node_modules --exclude dist --exclude test --exclude scripts \
  --exclude fixtures --exclude vectors packages/shared "$CTX/packages/"
echo "== uploading $(find "$CTX" -type f | wc -l | tr -d ' ') files and building"

railway up "$CTX" --path-as-root --service "$SERVICE" --ci

echo "== the site's address"
railway domain --service "$SERVICE"
