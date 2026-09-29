FROM python:3.13.7-slim@sha256:5f55cdf0c5d9dc1a415637a5ccc4a9e18663ad203673173b8cda8f8dcacef689
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl dbus-x11 xvfb openbox chromium=154.0.8037.57-1~deb13u1 libxi6 libxkbcommon0 libatspi2.0-0 fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      amd64) ARCH=x86_64; SHA=fff2016e0dea320df9be3aa52fc942c4ea4ca651df32cf3e950119bbc3097d29 ;; \
      arm64) ARCH=arm64; SHA=a77007a57ddac6f5b46a49fa9d7c39d9f22b461bd6b50af736b45946b0207875 ;; \
      *) exit 1 ;; esac && \
    curl --fail --location --max-time 180 "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.30.4/cua-driver-rs-0.30.4-linux-$ARCH-binary.tar.gz" -o /tmp/driver.tar.gz && \
    echo "$SHA  /tmp/driver.tar.gz" | sha256sum -c - && mkdir /opt/cua && tar -xzf /tmp/driver.tar.gz -C /opt/cua cua-driver && rm /tmp/driver.tar.gz && /opt/cua/cua-driver --version
RUN useradd --uid 1000 --create-home cua
COPY start.sh /opt/cua/start.sh
ENV DISPLAY=:99 HOME=/home/cua XDG_RUNTIME_DIR=/tmp/cua-runtime
USER 1000:1000
ENTRYPOINT ["/bin/sh", "/opt/cua/start.sh"]
