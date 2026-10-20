FROM node:18-slim
WORKDIR /app

RUN apt-get update && apt-get install -y \
    curl \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-6 \
    libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libxss1 libxtst6 xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --production

ARG CAMOUFOX_URL
RUN curl -sSL ${CAMOUFOX_URL} -o camoufox-linux.tar.gz && \
    tar -xzf camoufox-linux.tar.gz && \
    rm camoufox-linux.tar.gz && \
    chmod +x /app/camoufox-linux/camoufox

COPY dual-runtime/code/ ./

RUN mkdir -p ./auth && chown -R node:node /app

USER node

EXPOSE 7860
EXPOSE 9998

ENV CAMOUFOX_EXECUTABLE_PATH=/app/camoufox-linux/camoufox

CMD ["node", "unified-server.runtime.js"]
