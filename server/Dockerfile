FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Uploads are mounted as a volume at runtime
RUN mkdir -p /app/uploads

EXPOSE 4001

CMD ["node", "server.js"]
