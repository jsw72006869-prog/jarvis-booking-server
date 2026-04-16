FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

# Playwright Chromium 설치
RUN npx playwright install chromium

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["node", "dist/index.js"]
