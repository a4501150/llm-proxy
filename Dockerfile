# Build stage
FROM node:20-alpine AS build
WORKDIR /usr/src/app
COPY ./app .
RUN npm install
RUN npm run compile

# Production stage
FROM node:20-alpine
WORKDIR /usr/src/app
COPY --from=build /usr/src/app/lib ./lib
COPY --from=build /usr/src/app/package.json ./package.json
COPY --from=build /usr/src/app/package-lock.json ./package-lock.json
RUN npm ci --omit=dev

EXPOSE 3030
CMD ["node", "lib"]

