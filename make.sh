cat > make-script-manager.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT="script-manager"
rm -rf "$ROOT"
mkdir -p "$ROOT/src/public"

# ---------- package.json ----------
cat > "$ROOT/package.json" <<'PKG'
{
  "name": "script-manager",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js"
  },
  "dependencies": {
    "cookie-parser": "^1.4.6",
    "express": "^4.21.0",
    "express-rate-limit": "^7.4.0"
  },
  "engines": {
    "node": ">=20"
  }
}
PKG

# ---------- Dockerfile ----------
cat > "$ROOT/Dockerfile" <<'DOCKER'
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

RUN addgroup -g 1000 -S app && \
    adduser -u 1000 -S app -G app && \
    mkdir -p /scripts && \
    chown -R app:app /app /scripts
USER app

EXPOSE 5200

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:5200/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "src/server.js"]
DOCKER

# ---------- docker-compose.yml ----------
cat > "$ROOT/docker-compose.yml" <<'COMPOSE'
services:
  script-manager:
    build: .
    container_name: script-manager
    restart: unless-stopped
    ports:
      - "5200:5200"
    environment:
      APP_USER: "admin"
      APP_PASS: "change-me-please"
      SECRET_KEY: "generate-a-long-random-string-here"
      SESSION_HOURS: "12"
      SCRIPTS_DIR: "/scripts"
      ALLOW_CREATE: "true"
      ALLOW_DELETE: "true"
      RUN_TIMEOUT: "300"
      # TRUSTED_IPS: "192.168.1.10,192.168.1.11"
    volumes:
      - /DATA/scripts:/scripts
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
COMPOSE

# ---------- .dockerignore ----------
cat > "$ROOT/.dockerignore" <<'IGNORE'
node_modules
npm-debug.log
.git
.gitignore
*.md
IGNORE

# ---------- .gitignore ----------
cat > "$ROOT/.gitignore" <<'GIT'
node_modules/
npm-debug.log
.env
GIT

# ---------- README.md ----------
cat > "$ROOT/README.md" <<'README'
# Script Manager

A tiny web GUI for creating, editing, and running shell scripts on a host,
authenticated via environment variables. Designed for CasaOS custom install.

## Quick start

```bash
docker compose up -d --build