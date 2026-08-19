FROM docker.io/library/golang:1.26.6 AS yardd-build

ARG YARDD_VERSION=dev
WORKDIR /src
COPY guest/go.mod ./guest/go.mod
COPY guest/cmd ./guest/cmd
COPY guest/internal ./guest/internal
RUN cd guest && CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags "-s -w -X main.version=${YARDD_VERSION}" \
    -o /out/yardd ./cmd/yardd

# Pin the VM base so a later upstream rebuild cannot silently change old jobs.
FROM ghcr.io/boldsoftware/exeuntu@sha256:dcdaf66315f3f2597735509531f077db8411de3c0c478f9cd77419f42606a987

COPY --from=yardd-build /out/yardd /usr/local/bin/yardd
COPY images/yardd.service /etc/systemd/system/yardd.service

RUN chmod 0755 /usr/local/bin/yardd && \
    chmod 0644 /etc/systemd/system/yardd.service && \
    systemctl enable yardd.service

LABEL org.opencontainers.image.title="Saleor Yard exe.dev VM" \
      org.opencontainers.image.description="A disposable VM image with the Saleor Yard guest runtime" \
      exe.dev/login-user="exedev"
