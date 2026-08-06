# syntax=docker/dockerfile:1

# NexOS — self-hosted development environment
#
#   docker build -t nexos .
#   docker run --rm -p 4444:4444 -p 7681:7681 -p 7682:7682 -v "$PWD/workspace:/workspace" nexos
#
# See docker-compose.yml for a ready-to-run deployment.

FROM node:22-bookworm-slim AS runtime

# Map the standard build platform to ttyd's release asset names.
ARG TARGETARCH
ARG TTYD_VERSION=1.7.7

# Debian bookworm dropped ttyd, so we pull the static GitHub release and
# verify it against the upstream SHA256SUMS. curl/tar come from apt below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      openssh-client \
      procps \
      python3 \
      python3-pip \
      tzdata \
      jq \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) asset="ttyd.x86_64" ;; \
      arm64) asset="ttyd.aarch64" ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSLO "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/SHA256SUMS"; \
    curl -fsSLO "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/${asset}"; \
    grep -F "  ${asset}" SHA256SUMS | sha256sum -c -; \
    chmod +x "${asset}"; \
    mv "${asset}" /usr/local/bin/ttyd; \
    rm -f SHA256SUMS; \
    ttyd --version

# code-server (VS Code web). Pulled from the GitHub release tarball — the
# npm package embeds a nested vscode node_modules that trips npm 10/11's
# install walker, so the official tarball is the supported distribution.
ARG TARGETARCH
ARG CODE_SERVER_VERSION=4.117.0
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) platform="amd64" ;; \
      arm64) platform="arm64" ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-${platform}.tar.gz"; \
    curl -fsSL "$url" -o /tmp/code-server.tar.gz; \
    tar -xzf /tmp/code-server.tar.gz -C /usr/local/lib --strip-components=1; \
    rm -f /tmp/code-server.tar.gz; \
    ln -sf /usr/local/lib/bin/code-server /usr/local/bin/code-server; \
    code-server --version

# Non-root runtime user. code-server refuses to run as root, and the whole
# control plane should run unprivileged anyway. (uid/gid 1000 is taken by the
# base image's `node` user, so NexOS uses 2000.)
RUN groupadd -r nexos --gid 2000 \
    && useradd -r -g nexos --uid 2000 -m -d /home/nexos -s /bin/bash nexos

ENV NEXOS_ROOT=/opt/nexos \
    NEXOS_WORKSPACE=/workspace \
    NEXOS_STATE_DIR=/opt/nexos/state \
    NEXOS_LOG_DIR=/opt/nexos/state/logs \
    NEXOS_RUN_DIR=/opt/nexos/state/run \
    NEXOS_CONFIG_DIR=/opt/nexos/state/config \
    NEXOS_USER_DATA_DIR=/opt/nexos/state/user-data \
    NODE_ENV=development

WORKDIR /opt/nexos

# Install app deps first (better layer caching); ws is the only runtime dep.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# App source. State and local env are gitignored and mounted at runtime.
COPY . .
RUN mkdir -p /opt/nexos/state /workspace \
    && chown -R nexos:nexos /opt/nexos /workspace /home/nexos

USER nexos
WORKDIR /workspace

EXPOSE 4444 7681 7682 9876 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${NEXOS_LOG_PROXY_PORT:-7682}/health" >/dev/null || exit 1

ENTRYPOINT ["/opt/nexos/bin/entrypoint.sh"]
