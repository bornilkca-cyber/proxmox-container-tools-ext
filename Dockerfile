FROM node:20-alpine

# Set working directory
WORKDIR /workspace

# Install git and other utilities
RUN apk add --no-cache git bash curl

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Pre-compile TypeScript to catch errors early
RUN npm run compile

# Default command: run tests
CMD ["npm", "test"]

# Health check: verify node_modules are intact
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD test -d node_modules && echo "healthy" || exit 1
