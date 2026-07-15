ARG RUST_IMAGE=rust:1.97.0-alpine
ARG RUNTIME_IMAGE=alpine:3.23

FROM ${RUST_IMAGE} AS builder

RUN apk add --no-cache build-base openssl-dev openssl-libs-static perl pkgconf \
    && rustup target add wasm32-unknown-unknown
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/opt/dioxus-cli-target \
    CARGO_TARGET_DIR=/opt/dioxus-cli-target cargo install dioxus-cli --version 0.7.6 --locked

WORKDIR /workspace
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY v2 ./v2
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    dx build --web --package p2p-web --locked --release --debug-symbols false
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --locked --release -p p2p-server

FROM ${RUNTIME_IMAGE} AS runtime

RUN apk add --no-cache ca-certificates curl \
    && addgroup -S -g 10001 p2p \
    && adduser -S -D -H -u 10001 -G p2p p2p

WORKDIR /app
COPY --from=builder /workspace/target/release/p2p-server /app/p2p-server
COPY --from=builder /workspace/target/dx/p2p-web/release/web/public /app/web
RUN mkdir -p /app/data && chown -R p2p:p2p /app

USER p2p:p2p
ENV P2P_ADDR=0.0.0.0:3410 \
    P2P_DATABASE_PATH=/app/data/control.sqlite3 \
    P2P_WEB_DIST=/app/web \
    RUST_LOG=p2p_server=info,tower_http=info
EXPOSE 3410
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
    CMD curl --fail --silent --show-error http://127.0.0.1:3410/health/ready >/dev/null || exit 1
ENTRYPOINT ["/app/p2p-server"]
