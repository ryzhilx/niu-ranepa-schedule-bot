
FROM node:22.14-alpine

WORKDIR /app

RUN apk add --no-cache tzdata

ENV NODE_ENV=production \
    TZ=Europe/Moscow \
    NODE_OPTIONS="--experimental-sqlite"

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p data

CMD ["node", "src/bot.js"]
