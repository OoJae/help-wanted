# The HELP WANTED runner.
#
# Build from the repository root, because the runner uses the shared package:
#
#   docker build -f bots/runner/Dockerfile -t help-wanted-runner .
#
# Run (a dry run: no key, nothing signed, nothing sent):
#
#   docker run --rm -e WORK_ORDERS=0x... -e RPC_URL=https://... -v hw-runner:/data help-wanted-runner once
#
# The image holds no key. A live run takes LIVE=1, START_BLOCK and RUNNER_PRIVATE_KEY from the
# environment at start, through your platform's secret store.
#
# The store is /data/runner.json. It must survive a restart: attach a persistent volume at /data
# (`docker run -v hw-runner:/data`, or the hosting platform's own volume; Railway refuses a
# Dockerfile that declares one itself). A live runner refuses to start when it cannot write its
# store.
FROM node:22-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    STORE_PATH=/data/runner.json

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY bots/runner/package.json bots/runner/package.json
# Production dependencies of the runner and of what it depends on in this workspace, nothing else.
RUN pnpm install --frozen-lockfile --prod --filter "@help-wanted/runner..."

COPY packages/shared packages/shared
COPY bots/runner bots/runner

RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/bots/runner

# tsx runs the TypeScript sources directly; node stays PID 1 so SIGTERM stops the loop cleanly.
ENTRYPOINT ["node", "--import", "tsx", "src/cli.ts"]
CMD ["run"]
