FROM node:20-slim

WORKDIR /app

# package.json と package-lock.json をコピー
COPY package*.json ./

# 依存関係をインストール
RUN npm ci --only=production

# Timezone setting
RUN apt-get update && apt-get install -y tzdata
ENV TZ=Asia/Tokyo

# ソースコードをコピー
COPY . .

# Cloud Run はポート8080を期待
ENV PORT=8080
EXPOSE 8080

# アプリケーションを起動
CMD ["node", "index.js"]
