FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build


FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920

RUN apk upgrade --no-cache

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist/ dist/

ENV MCP_CC_PROXY_TRANSPORT=http \
    MCP_CC_PROXY_LISTEN_HOST=0.0.0.0 \
    MCP_CC_PROXY_LISTEN_PORT=8080 \
    MCP_CC_PROXY_LISTEN_PATH=/mcp

USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]
