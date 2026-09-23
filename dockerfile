FROM node:20-alpine

WORKDIR /app

# Install deps first for better layer caching
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src ./src

# Non-root user + scripts dir
RUN addgroup -g 1000 -S app && \
    adduser -u 1000 -S app -G app && \
    mkdir -p /scripts && \
    chown -R app:app /app /scripts
USER app

EXPOSE 5200

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:5200/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]