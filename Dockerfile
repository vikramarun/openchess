# Multi-stage build for the OpenChess game server (the Rust `chess-server`
# binary). Host this on Fly / Railway / Render / a VM — NOT Vercel (it's a
# long-lived, stateful WebSocket process). The web app deploys separately to
# Vercel (Root Directory = apps/web).

# ---- build ----
FROM rust:1.83-bookworm AS build
WORKDIR /app

# Copy the whole Cargo workspace. (apps/, contracts/, target/ are excluded by
# .dockerignore.) Queries are runtime sqlx — no DATABASE_URL needed at build.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates

# Build only the server binary in release mode.
RUN cargo build --release --bin chess-server

# ---- runtime ----
FROM debian:bookworm-slim AS runtime
# ca-certificates: outbound HTTPS to the RPC. libssl3: reqwest/native-tls.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/target/release/chess-server /usr/local/bin/chess-server

# Bind to all interfaces inside the container; the platform maps the port.
ENV BIND=0.0.0.0:8080
EXPOSE 8080

# Run as a non-root user.
RUN useradd -r -u 10001 appuser
USER appuser

CMD ["chess-server"]
