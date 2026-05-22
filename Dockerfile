# Production image for MyTracker. Works on any container host
# (Render, Fly.io, Railway, a VPS with Docker, etc.).
#
# Node 24: the built-in node:sqlite module runs without an experimental flag.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies first so this layer caches across rebuilds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source.
COPY . .

# The SQLite database is written here. Mount a PERSISTENT volume at this
# path on your host, otherwise every account is wiped on redeploy.
VOLUME /app/data

EXPOSE 3000
CMD ["npm", "start"]
