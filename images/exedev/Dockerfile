FROM docker.io/library/golang:1.26.6 AS sandboxd-build

ARG SANDBOXD_VERSION=dev
WORKDIR /src
COPY guest/go.mod ./guest/go.mod
COPY guest/cmd ./guest/cmd
COPY guest/internal ./guest/internal
RUN cd guest && CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags "-s -w -X main.version=${SANDBOXD_VERSION}" \
    -o /out/sandboxd ./cmd/sandboxd

# Pin the VM base so a later upstream rebuild cannot silently change old jobs.
FROM ghcr.io/boldsoftware/exeuntu@sha256:dcdaf66315f3f2597735509531f077db8411de3c0c478f9cd77419f42606a987

COPY --from=sandboxd-build /out/sandboxd /usr/local/bin/sandboxd
COPY images/sandboxd.service /etc/systemd/system/sandboxd.service

RUN chmod 0755 /usr/local/bin/sandboxd && \
    chmod 0644 /etc/systemd/system/sandboxd.service && \
    systemctl enable sandboxd.service

LABEL org.opencontainers.image.title="Saleor Sandbox exe.dev VM" \
      org.opencontainers.image.description="A disposable VM image with the Saleor Sandbox guest runtime" \
      exe.dev/login-user="exedev"
