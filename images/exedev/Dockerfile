FROM docker.io/library/golang:1.26.6 AS factoryd-build

ARG FACTORYD_VERSION=dev
WORKDIR /src
COPY guest/go.mod ./guest/go.mod
COPY guest/cmd ./guest/cmd
COPY guest/internal ./guest/internal
RUN cd guest && CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags "-s -w -X main.version=${FACTORYD_VERSION}" \
    -o /out/factoryd ./cmd/factoryd

# Pin the VM base so a later upstream rebuild cannot silently change old jobs.
FROM ghcr.io/boldsoftware/exeuntu@sha256:dcdaf66315f3f2597735509531f077db8411de3c0c478f9cd77419f42606a987

COPY --from=factoryd-build /out/factoryd /usr/local/bin/factoryd
COPY images/factoryd.service /etc/systemd/system/factoryd.service

RUN chmod 0755 /usr/local/bin/factoryd && \
    chmod 0644 /etc/systemd/system/factoryd.service && \
    systemctl enable factoryd.service

LABEL org.opencontainers.image.title="Saleor Factory exe.dev VM" \
      org.opencontainers.image.description="A disposable VM image with the Saleor Factory guest runtime" \
      exe.dev/login-user="exedev"
