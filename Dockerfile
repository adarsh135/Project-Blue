# Project Blue — production image
#
# Build:  docker build -t project-blue .
# Run:    docker run -p 4000:4000 -v blue-data:/data \
#                -e BLUE_SESSION_SECRET=... -e PUBLIC_URL=https://your.domain \
#                project-blue
#
# Node 22.5+ is required because the app uses the built-in `node:sqlite`
# module; there is no native dependency to compile and no database server.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    BLUE_DATA_DIR=/data

WORKDIR /app

# express is the only runtime dependency; jsdom is a devDependency used by the
# test suite and is deliberately not installed here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# The SQLite database and the generated session secret both live under
# BLUE_DATA_DIR, so a single volume persists the whole installation.
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 4000

# /api/status is unauthenticated by design and reports engine health, which
# makes it the right liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "server/index.js"]
