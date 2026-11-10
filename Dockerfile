# Lost N Found — production container for AWS ECS / Fargate (and any container host).
# Build:  docker build -t lost-n-found .
# Run:    docker run -p 3000:3000 -e SESSION_SECRET=... lost-n-found
FROM node:22-alpine AS base
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Dependencies first so source edits do not invalidate the install layer.
# node_modules and .env are excluded in .dockerignore.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source. Secrets are supplied as container environment variables
# by the host; .env is excluded in .dockerignore so it is never baked in.
COPY --chown=node:node server.js ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public

# The app writes local state and uploaded photos under /app when RDS/S3 are not
# configured. On Fargate this is ephemeral, so configure RDS and S3 for durable
# data (see deploy/aws/README.md).
RUN mkdir -p data public/uploads/seed && chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Direct node entrypoint so SIGTERM reaches the server for a clean store flush.
CMD ["node", "server.js"]
