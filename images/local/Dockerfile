FROM docker.io/library/golang:1.26.6 AS build

ARG FACTORYD_VERSION=dev
WORKDIR /src
COPY guest/go.mod ./guest/go.mod
COPY guest/cmd ./guest/cmd
COPY guest/internal ./guest/internal
RUN cd guest && CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags "-s -w -X main.version=${FACTORYD_VERSION}" \
    -o /out/factoryd ./cmd/factoryd

FROM scratch AS export
COPY --from=build /out/factoryd /factoryd
