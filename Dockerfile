# journalctl must be at least as new as the host's systemd (259 on Ubuntu 26.04) or it can't read the journal files,
# so the runtime is the host's own release with the bun binary copied in. systemd is installed only for journalctl;
# nothing runs it.
FROM oven/bun:1.4.2-debian AS bun

FROM ubuntu:26.04
RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8090
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8090/healthz || exit 1
CMD ["bun", "src/server.ts"]
