# -------- Build stage --------
FROM node:20-alpine AS build
WORKDIR /app
COPY src ./src
COPY tsconfig.json ./tsconfig.json
COPY package.json package-lock.json* ./
RUN npm install
RUN npm ci
RUN npm run build

# -------- Runtime stage --------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# Create non-root user
RUN addgroup -S app && adduser -S -G app app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER app
EXPOSE 8080
CMD ["node", "dist/server.js"]
