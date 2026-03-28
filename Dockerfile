FROM node:20-alpine

WORKDIR /app

# Install dependencies (including devDependencies needed for TypeScript build)
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy source and build
COPY src/ ./src/
RUN npm run build

CMD ["npm", "start"]
