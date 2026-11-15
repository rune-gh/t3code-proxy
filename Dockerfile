# syntax=docker/dockerfile:1

# Web panel: platform independent, so build it once on the build host.
FROM --platform=$BUILDPLATFORM oven/bun:1 AS web
WORKDIR /src/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

# Go binary, built natively for the target with CGO so dynamic library
# plugins keep working on Linux.
FROM golang:1.26-bookworm AS builder
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist/index.html internal/managementasset/embedded/management.html
ARG VERSION=dev
ARG COMMIT=none
ARG BUILD_DATE=unknown
RUN CGO_ENABLED=1 go build -trimpath -buildvcs=false \
      -ldflags="-s -w -X 'main.Version=${VERSION}' -X 'main.Commit=${COMMIT}' -X 'main.BuildDate=${BUILD_DATE}'" \
      -o /out/t3code-proxy ./cmd/server

FROM debian:bookworm-slim
ARG VERSION=dev
ARG COMMIT=none
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="t3code-proxy" \
      org.opencontainers.image.description="One always-on hub for your Claude and Codex subscriptions, exposed as an OpenAI/Claude-compatible API" \
      org.opencontainers.image.source="https://github.com/rune-oai/t3code-proxy" \
      org.opencontainers.image.url="https://github.com/rune-oai/t3code-proxy" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --no-create-home --home-dir /data --shell /usr/sbin/nologin t3code \
 && mkdir -p /data /usr/share/t3code-proxy \
 && chown 10001:10001 /data

COPY --from=builder /out/t3code-proxy /usr/local/bin/t3code-proxy
COPY config.example.yaml config.hub.example.yaml /usr/share/t3code-proxy/

# Everything mutable lives in /data: config.yaml, the auth dir (the default
# ~/.t3code-proxy resolves to /data/.t3code-proxy), logs/, and the quota
# history database next to the config. Mount one volume there.
ENV TZ=UTC \
    HOME=/data
WORKDIR /data
VOLUME ["/data"]
USER 10001:10001

EXPOSE 8317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8317/healthz >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/t3code-proxy"]
CMD ["-config", "/data/config.yaml"]
