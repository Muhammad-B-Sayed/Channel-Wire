FROM node:24-alpine AS build

ARG VITE_GATEWAY_URL=http://127.0.0.1:8000
ARG VITE_ENABLE_DEV_TOKEN=1
ENV VITE_GATEWAY_URL=$VITE_GATEWAY_URL
ENV VITE_ENABLE_DEV_TOKEN=$VITE_ENABLE_DEV_TOKEN

WORKDIR /app
COPY frontend/package*.json ./frontend/
WORKDIR /app/frontend
RUN npm install
COPY frontend ./
RUN npm run build

FROM nginx:1.27-alpine

COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
