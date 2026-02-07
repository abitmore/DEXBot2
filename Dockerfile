FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Default command is help-oriented; override in docker-compose or docker run.
CMD ["node", "dexbot.js", "help"]
