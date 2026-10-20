FROM node:24-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

ARG CAMOUFOX_URL=https://github.com/daijro/camoufox/releases/download/v135.0.1-beta.24/camoufox-135.0.1-beta.24-lin.x86_64.zip
RUN curl -fsSL "$CAMOUFOX_URL" -o /tmp/camoufox.zip \
    && (unzip -q /tmp/camoufox.zip -d /tmp/camoufox || true) \
    && test -n "$(find /tmp/camoufox -type f -name camoufox -print -quit)" \
    && mkdir -p /app/camoufox-linux \
    && find /tmp/camoufox -type f -name camoufox -exec sh -c 'cp -a "$(dirname "$1")"/. /app/camoufox-linux/' _ {} \; \
    && rm -rf /tmp/camoufox /tmp/camoufox.zip \
    && chmod +x /app/camoufox-linux/camoufox

COPY dual-runtime/code/ ./

RUN mkdir -p ./auth

USER root

EXPOSE 7860
EXPOSE 9998

ENV NODE_ENV=production \
    CAMOUFOX_EXECUTABLE_PATH=/app/camoufox-linux/camoufox

CMD ["node", "unified-server.runtime.js"]
