FROM node:20-alpine AS builder
WORKDIR /app/mcp
COPY mcp/package*.json ./
RUN npm install
COPY mcp .
RUN npm run build

FROM node:20-alpine
WORKDIR /app/mcp
COPY mcp/package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/mcp/dist ./dist

EXPOSE 3002
CMD ["node", "dist/index.js"]
