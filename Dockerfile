# Code Runner MCP server: one container for Railway (or any Docker host).
# Build from the repository root:  docker build -t code-runner .
#
# Optional languages are build arguments (on Railway: service variables of the
# same name are passed to the build). Languages that are not installed still
# work for short programs through Compiler Explorer / Wandbox.
FROM node:24-bookworm-slim

ARG WITH_R=0
ARG WITH_GO=0
ARG WITH_RUST=0
ARG WITH_JAVA=0
ARG EXTRA_APT=""
ARG EXTRA_PIP=""
# REA (reverse engineering MCP server, offered as tools on /mcp), pinned. Static
# JavaScript/Electron/web-bundle/.NET analysis needs nothing else; native
# engines (Ghidra + JDK, JADX, radare2, binwalk ...) can be added via EXTRA_APT.
ARG WITH_REA=1
ARG REA_VERSION=6.2.0

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PYTHONDONTWRITEBYTECODE=1

# Runtimes and tools the code may use, plus what the sandbox needs
# (gcc builds the launcher, bubblewrap adds namespaces where the host allows them).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv python3-dev \
      build-essential bubblewrap tini ca-certificates curl wget git unzip zip xz-utils \
      sqlite3 jq file procps \
      ruby php-cli lua5.4 perl \
      fonts-dejavu-core \
    && if [ "$WITH_R" = "1" ]; then apt-get install -y --no-install-recommends r-base-core r-cran-jsonlite r-cran-ggplot2 r-cran-dplyr; fi \
    && if [ "$WITH_GO" = "1" ]; then apt-get install -y --no-install-recommends golang-go; fi \
    && if [ "$WITH_RUST" = "1" ]; then apt-get install -y --no-install-recommends rustc; fi \
    && if [ "$WITH_JAVA" = "1" ]; then apt-get install -y --no-install-recommends default-jdk-headless; fi \
    && if [ -n "$EXTRA_APT" ]; then apt-get install -y --no-install-recommends $EXTRA_APT; fi \
    && rm -rf /var/lib/apt/lists/*

# The Python stack the plugin offered through Pyodide, as real wheels.
RUN python3 -m pip install \
      numpy pandas scipy matplotlib scikit-learn pillow requests httpx beautifulsoup4 lxml \
      openpyxl xlrd pyarrow duckdb pypdf python-docx python-pptx pyyaml tabulate markdown \
      sympy seaborn plotly statsmodels faker \
    && if [ -n "$EXTRA_PIP" ]; then python3 -m pip install $EXTRA_PIP; fi

RUN if [ "$WITH_REA" = "1" ]; then npm install -g --no-audit --no-fund "rea-agents@${REA_VERSION}" && rea --version >/dev/null; fi

WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund

# implementation.js is the plugin source: the server reuses its previews,
# remote compilers and image routes from it.
COPY implementation.js ./implementation.js
COPY server ./server
RUN sh server/sandbox/build.sh && chmod -R go-w /app

# Root is needed once per run to switch to the workspace's own unix user.
# Nothing else in the server depends on it.
# Data lives on a Railway volume: the server uses the volume's mount path, whatever
# it is (RAILWAY_VOLUME_MOUNT_PATH), or DATA_DIR if set, or /data without a volume.
# (Railway rejects a Dockerfile VOLUME instruction.)
ENV NODE_ENV=production \
    PORT=8080 \
    RAILWAY_RUN_UID=0
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "server/src/index.js"]
