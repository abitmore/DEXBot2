FROM node:20-bookworm-slim

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --ignore-scripts

COPY --chown=node:node . .
RUN npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force \
    && mkdir -p /app/profiles /app/market_adapter/data /app/market_adapter/state \
    && chown -R node:node /app/profiles /app/market_adapter/data /app/market_adapter/state

USER node

# Default command starts credential daemon and all active bots interactively.
# Run with: docker run -it -v ./profiles:/app/profiles <image>
# For a specific bot: docker run -it ... <image> node dist/unlock-start.js <bot-name>
CMD ["node", "dist/unlock-start.js"]
