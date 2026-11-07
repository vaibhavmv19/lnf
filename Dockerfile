# Lost N Found — Node.js server (npm start -> node server.js)
FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# The app listens on process.env.PORT (default 3000)
EXPOSE 3000
CMD ["npm", "start"]
