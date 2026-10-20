#!/bin/sh
set -eu
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
exec dbus-run-session -- /opt/cua/cua-driver serve --embedded --parent-liveness-stdio --permission-mode bounded --capability-manifest /policy.json --approve-capability-manifest --socket /tmp/driver.sock
