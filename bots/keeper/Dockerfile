# The HELP WANTED keeper.
#
# Build from the repository root, because the keeper uses the shared package:
#
#   docker build -f bots/keeper/Dockerfile -t help-wanted-keeper .
#
# Run (a dry run: no key, nothing signed, nothing sent):
#
#   docker run --rm -e QUESTIONS=0x... -e JOBS_REPORT=0x... -e PAYROLL=0x... -e RPC_URL=https://... \
#     -v hw-keeper:/data help-wanted-keeper once
#
# The image holds no key. A live run takes LIVE=1 and KEEPER_PRIVATE_KEY from the environment at
# start, through your platform's secret store. The default command is `run`: a pass every
# POLL_SECONDS. For a scheduler, run `once`.
#
# The state file is /data/keeper.json and the status file /data/keeper-status.json. The state file
# must survive a restart (it holds the day's spending and any transaction in flight): on a hosting
# platform attach a persistent volume at /data (Railway refuses a Dockerfile that declares one itself).
# A live keeper refuses to start when it cannot write its state.
FROM node:22-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    STATE_PATH=/data/keeper.json \
    STATUS_PATH=/data/keeper-status.json

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY bots/keeper/package.json bots/keeper/package.json
# Production dependencies of the keeper and of what it depends on in this workspace, nothing else.
RUN pnpm install --frozen-lockfile --prod --filter "@help-wanted/keeper..."

COPY packages/shared packages/shared
COPY bots/keeper bots/keeper

RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/bots/keeper

# tsx runs the TypeScript sources directly; node stays PID 1 so SIGTERM stops the loop cleanly.
ENTRYPOINT ["node", "--import", "tsx", "src/cli.ts"]
CMD ["run"]
