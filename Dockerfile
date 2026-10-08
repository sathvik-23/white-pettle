# ════════════════════════════════════════════════════════════════════════════
#  White Petal — ONE image, ONE target.
#
#  Single target on purpose: `gcloud builds submit --tag` cannot pass
#  `--target` (PerfStaq had to hand-write infra/cloudbuild.yaml for exactly
#  that reason). The `deps` stage below is an intermediate, never a target —
#  a plain `docker build .` produces the runtime image.
#
#      docker build -t whitepetal .
#      docker run --rm -p 8080:8080 whitepetal     # → http://localhost:8080
#
#  node:22-bookworm-slim, not alpine. Alpine would save ~25 MB compressed, and
#  `pg` is pure JavaScript so musl would not break it — but the saving is a
#  rounding error (≈$0.0025/month of Artifact Registry storage; Cloud Run
#  streams images, so cold starts barely notice), while glibc keeps this
#  image identical to PerfStaq's base and to the CI runner the tests ran on.
#  Pinned to the major that CI tests (`node-version: 22` in ci.yml); the
#  point of pinning is that production runs what the tests ran on.
# ════════════════════════════════════════════════════════════════════════════

# ── Dependencies ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# MANIFESTS ONLY, so a source edit does not invalidate the install layer.
# `COPY . .` here is the single most common way a 2-second rebuild turns into
# a full reinstall on every commit.
COPY package.json package-lock.json ./

# `npm ci`, not `npm install`: it FAILS on a lockfile that disagrees with
# package.json instead of quietly resolving something nobody tested.
# --omit=dev keeps test tooling out of production.
#
# Deliberately NO `RUN --mount=type=cache`. `gcloud builds submit --tag`
# (bootstrap.sh) runs the CLASSIC docker builder, which rejects --mount as a
# syntax error — PerfStaq's cloudbuild.yaml has to force DOCKER_BUILDKIT=1 on
# every step for exactly this. The cache mount would only help when the
# lockfile changes; the GitHub Actions layer cache (type=gha) already skips
# this whole step when it does not. The npm cache is dropped in the same
# layer so it never ships.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# tini as PID 1. Without it, `node` IS PID 1, and the kernel gives PID 1 no
# default signal handlers — SIGTERM is silently ignored unless the app
# installs a handler. Cloud Run then waits the full 10 s before SIGKILL, and
# with request-based billing the graceful-shutdown window IS BILLED, on every
# scale-down. ~1 MB to make every shutdown take milliseconds instead.
# Unpinned on purpose (hadolint DL3008): Debian replaces package versions on
# point releases, so a pinned `tini=x.y` breaks the build months later for no
# gain — tini has had no behaviour change in years.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Owned by root, read-only to the `node` user that runs the server: a
# compromised process cannot rewrite its own code. The app writes nothing to
# disk (state is Postgres; Cloud Run's filesystem is ephemeral RAM anyway).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# EXPLICIT runtime directories, not `COPY . .`: dev.mjs, *.command, test/,
# docs/, infra/ and vercel.json are not part of the server, and .dockerignore
# is the second lock rather than the only one.
#
# IF YOU ADD A NEW TOP-LEVEL RUNTIME DIRECTORY (e.g. `migrations/` outside
# server/), ADD IT HERE. The deploy job's container smoke test fails the
# deploy if the image cannot boot, so forgetting is loud, not silent.
COPY server/ ./server/
COPY api/    ./api/
COPY public/ ./public/

USER node

# Cloud Run injects PORT=8080 and refuses a service that sets PORT itself;
# the server reads $PORT. EXPOSE is documentation for `docker run -P`.
EXPOSE 8080

# Ignored by Cloud Run (it uses the startup probe in infra/terraform/run.tf),
# used by docker compose to order startup and show (healthy). Same endpoint
# on purpose: two health paths are how the two come to disagree.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.mjs"]
