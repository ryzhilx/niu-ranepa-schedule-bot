FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache tzdata

ENV NODE_ENV=production \
    TZ=Europe/Moscow \
    NODE_OPTIONS="--experimental-sqlite"

COPY package*.json ./

RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p data

CMD ["node", "src/bot.js"]
