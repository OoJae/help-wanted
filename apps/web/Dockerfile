# The HELP WANTED site.
#
# Build from the repository root, because the lockfile and the workspace files live there:
#
#   docker build -f apps/web/Dockerfile -t help-wanted-web .
#
# Run:
#
#   docker run --rm -p 4321:4321 -e SITE_ORIGIN=https://your.address help-wanted-web
#
# The image holds no key and the server writes nothing to disk. Every setting is read from the
# environment when the server starts (see apps/web/.env.example); none is needed at build time.
#
# On Railway: point the service's Dockerfile path at apps/web/Dockerfile (or set
# RAILWAY_DOCKERFILE_PATH=apps/web/Dockerfile), leave the root directory at the repository root, and
# use /api/v1/health as the health check path. Railway sets PORT and RAILWAY_PUBLIC_DOMAIN itself.
#
# The three steps below (install with production dependencies only, build, start) were rehearsed
# outside a container on 11 Oct 2026. Since then the site imports one workspace package,
# packages/shared (addresses, ABIs, the house feeds, the IdentityMD API client), which is copied in
# beside it. The image itself had not been built when this was written.
FROM node:22-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    ASTRO_TELEMETRY_DISABLED=1 \
    HOST=0.0.0.0 \
    PORT=4321

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
# Production dependencies of the site and of the one workspace package it imports, nothing else.
RUN pnpm install --frozen-lockfile --prod --filter "@help-wanted/web..."

# The shared package is imported as TypeScript source and bundled into the server by the build.
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @help-wanted/web build

USER node
WORKDIR /app/apps/web
EXPOSE 4321
# node stays PID 1, so SIGTERM stops the server cleanly.
CMD ["node", "dist/server/entry.mjs"]
