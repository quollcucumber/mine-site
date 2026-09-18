FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && chown -R 1000:1000 /app

USER 1000
ENV PORT=7860
EXPOSE 7860
CMD ["npm", "start"]
