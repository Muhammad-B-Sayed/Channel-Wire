FROM alpine:3.20 AS build

RUN apk add --no-cache build-base make
WORKDIR /app
COPY Makefile ./
COPY core ./core
RUN make

FROM alpine:3.20

RUN adduser -D -H -s /sbin/nologin channelwire
WORKDIR /app
COPY --from=build /app/build/channelwire-server /usr/local/bin/channelwire-server
USER channelwire
EXPOSE 5555
ENV CW_BIND_HOST=0.0.0.0
CMD ["channelwire-server", "5555"]
