FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    TERM=xterm-256color

# ── Locale + base packages ────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        locales \
        bash bash-completion \
        curl wget git \
        jq \
        build-essential ca-certificates gnupg \
        unzip zip tar gzip xz-utils \
        less man-db sudo tmux watch \
        python3 python3-pip python3-venv python3-dev \
        postgresql-client \
        redis-tools \
        httpie \
        ripgrep \
        fd-find \
        netcat-openbsd \
        dnsutils \
        iputils-ping \
        lsof \
        procps \
    && locale-gen en_US.UTF-8 \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# ── bat ───────────────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends bat \
    && ln -sf /usr/bin/batcat /usr/local/bin/bat \
    && rm -rf /var/lib/apt/lists/*

# ── lsd ───────────────────────────────────────────────────────────────────────
RUN set -eux; \
    DPKG_ARCH=$(dpkg --print-architecture); \
    LSD_VER=$(curl -fsSL "https://api.github.com/repos/lsd-rs/lsd/releases/latest" \
              | jq -r .tag_name | tr -d 'v'); \
    curl -fsSL "https://github.com/lsd-rs/lsd/releases/download/v${LSD_VER}/lsd_${LSD_VER}_${DPKG_ARCH}.deb" \
         -o /tmp/lsd.deb \
    && dpkg -i /tmp/lsd.deb \
    && rm /tmp/lsd.deb

# ── yq ────────────────────────────────────────────────────────────────────────
RUN set -eux; \
    DPKG_ARCH=$(dpkg --print-architecture); \
    case "$DPKG_ARCH" in \
        amd64) YQ_ARCH="amd64" ;; \
        arm64) YQ_ARCH="arm64" ;; \
        *) echo "Unsupported arch: $DPKG_ARCH" && exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${YQ_ARCH}" \
         -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq

# ── Node.js (LTS) ─────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g npm@latest \
    && rm -rf /var/lib/apt/lists/*

# ── k6 (binary — skips flaky apt/GPG setup) ──────────────────────────────────
RUN set -eux; \
    DPKG_ARCH=$(dpkg --print-architecture); \
    case "$DPKG_ARCH" in \
        amd64) K6_ARCH="amd64" ;; \
        arm64) K6_ARCH="arm64" ;; \
        *) echo "Unsupported arch: $DPKG_ARCH" && exit 1 ;; \
    esac; \
    K6_VERSION="v0.55.0"; \
    curl -fsSL "https://github.com/grafana/k6/releases/download/${K6_VERSION}/k6-${K6_VERSION}-linux-${K6_ARCH}.tar.gz" \
        | tar -xz -C /tmp; \
    mv "/tmp/k6-${K6_VERSION}-linux-${K6_ARCH}/k6" /usr/local/bin/k6; \
    chmod +x /usr/local/bin/k6; \
    k6 version

# ── Neovim (latest release) ───────────────────────────────────────────────────
# ── k6 ────────────────────────────────────────────────────────────────────────
RUN set -eux; \
    DPKG_ARCH=$(dpkg --print-architecture); \
    case "$DPKG_ARCH" in \
        amd64) K6_ARCH="amd64" ;; \
        arm64) K6_ARCH="arm64" ;; \
        *) echo "Unsupported arch: $DPKG_ARCH" && exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/neovim/neovim/releases/latest/download/nvim-linux-${NVIM_ARCH}.tar.gz" \
         | tar -xz -C /opt \
    && ln -sf "/opt/nvim-linux-${NVIM_ARCH}/bin/nvim" /usr/local/bin/nvim

# ── LazyVim starter config ────────────────────────────────────────────────────
RUN git clone https://github.com/LazyVim/starter /root/.config/nvim \
    && rm -rf /root/.config/nvim/.git

# ── Shell conveniences ────────────────────────────────────────────────────────
RUN cat >> /root/.bashrc << 'EOF'

# lsd aliases
alias ll="lsd -la"
alias l="lsd -l"
alias lt="lsd --tree"

# bat instead of cat
alias cat="bat --paging=never"

# Poll a health endpoint every 2s
# usage: healthcheck http://my-service:8000/health
healthcheck() {
    watch -n 2 "curl -s $1 | jq ."
}

# Tail logs for a compose service
# usage: logs order-service
logs() {
    docker compose -f /workspace/compose.yml logs -f "$1"
}

# Quick redis inspection
# usage: rkeys queue:*
rkeys() {
    redis-cli -u "$REDIS_URL" keys "$1"
}

# Peek at the head of a Redis list without consuming it
# usage: rpeek queue:order_dispatch
rpeek() {
    redis-cli -u "$REDIS_URL" lrange "$1" 0 4
}
EOF
    K6_VER=$(curl -fsSL "https://api.github.com/repos/grafana/k6/releases/latest" \
             | jq -r .tag_name); \
    curl -fsSL "https://github.com/grafana/k6/releases/download/${K6_VER}/k6-${K6_VER}-linux-${K6_ARCH}.tar.gz" \
         | tar -xz -C /tmp \
    && mv "/tmp/k6-${K6_VER}-linux-${K6_ARCH}/k6" /usr/local/bin/k6 \
    && rm -rf "/tmp/k6-${K6_VER}-linux-${K6_ARCH}"

# ── Shell conveniences ────────────────────────────────────────────────────────
COPY .bashrc_extras /tmp/.bashrc_extras
RUN cat /tmp/.bashrc_extras >> /root/.bashrc

WORKDIR /workspace

CMD ["sleep", "infinity"]