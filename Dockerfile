FROM node:25-alpine

WORKDIR /app

COPY package.json .
RUN npm install

COPY . .

RUN mkdir -p downloads resources/replays && \
    chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "server.js"]
