FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --production

COPY . .

EXPOSE 8000

CMD ["npm", "start"]
