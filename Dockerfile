FROM node:20-alpine

WORKDIR /app

# Install build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --production

COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

ENV PORT=3000
ENV DB_PATH=/app/data/expenses.db

EXPOSE 3000

CMD ["node", "server.js"]
