FROM ghcr.io/puppeteer/puppeteer:23.11.1

USER root
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json nest-cli.json ./
COPY src ./src
COPY client ./client

RUN npm run build

RUN mkdir -p /app/.chrome-profile && chown -R pptruser:pptruser /app
USER pptruser

ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_HEADLESS=true \
    PUPPETEER_USER_DATA_DIR=/app/.chrome-profile

EXPOSE 3000
CMD ["node", "dist/main.js"]
