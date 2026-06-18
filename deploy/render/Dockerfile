FROM python:3.12-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Makefile ./
COPY core ./core
RUN make

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app
ENV CHANNELWIRE_CORE_HOST=127.0.0.1
ENV CHANNELWIRE_CORE_PORT=5555

WORKDIR /app
COPY gateway/requirements.txt ./gateway/requirements.txt
RUN pip install --no-cache-dir -r gateway/requirements.txt
COPY --from=build /app/build/channelwire-server /usr/local/bin/channelwire-server
COPY tools ./tools
COPY gateway ./gateway
COPY deploy/render/start.sh /usr/local/bin/channelwire-render-start
RUN chmod +x /usr/local/bin/channelwire-render-start

EXPOSE 8000
CMD ["channelwire-render-start"]
