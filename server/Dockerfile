FROM node:20-alpine

# ffmpeg for MP4 fast-start optimization (moves moov atom to front of file
# so browsers can start streaming without downloading the whole file first)
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

RUN mkdir -p /app/uploads

EXPOSE 4001

CMD ["node", "server.js"]
