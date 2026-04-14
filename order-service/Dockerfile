Copy

FROM node:lts-slim
 
WORKDIR /app
 
COPY package*.json ./
RUN npm install --omit=dev
 
COPY src ./src
 
ENV NODE_ENV=production
EXPOSE 8000
 
CMD ["node", "src/index.js"]
 