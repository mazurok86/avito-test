#!/usr/bin/env bash
# Starts Xvfb (and a per-container dbus session) so Chrome can run headful
# inside the container. Without these, Chrome either refuses to start or
# falls back to headless rendering, which is trivially fingerprinted.
#
# When ENABLE_VNC=true is set, additionally starts x11vnc (raw VNC on :5900)
# and a websockify→noVNC bridge (browser UI on :6080) for remote viewing of
# the in-container desktop. Ports must also be published by the host.
set -e

# First-stage (root): the container starts without a USER directive (see
# Dockerfile), so we land here as root for one-shot setup that needs root
# privileges — primarily chown'ing the persistent chrome-profile volume so
# the `node` user can read/write it regardless of which UID owned the files
# on previous runs (e.g. a volume created under a different base image).
# Then we re-exec ourselves under `node` via setpriv and the rest of this
# script runs unprivileged.
if [ "$(id -u)" = "0" ]; then
    # HOME defaults to /root because we started the container as root.
    # setpriv preserves env across the uid switch, so without this override
    # the `node` user would inherit HOME=/root and every library that
    # caches in $HOME (puppeteer/cosmiconfig, dbus-launch, X11 client libs,
    # gnupg) would try to write to /root/* and fail with EACCES.
    export HOME=/home/node

    # Xvfb refuses to create /tmp/.X11-unix as non-root; pre-create it now
    # with the canonical 1777 (world-writable + sticky) so Xvfb (running as
    # `node` after the privilege drop) can bind its display socket there.
    mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

    PROFILE_DIR="${PUPPETEER_USER_DATA_DIR:-/app/.chrome-profile}"
    if [ -d "$PROFILE_DIR" ]; then
        chown -R node:node "$PROFILE_DIR"
    fi
    exec setpriv --reuid=node --regid=node --init-groups -- "$0" "$@"
fi

DISPLAY_NUM="${DISPLAY:-:99}"
SCREEN_GEOMETRY="${XVFB_SCREEN:-1920x1080x24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

# Stale lock from a crashed previous run blocks Xvfb startup.
rm -f "/tmp/.X${DISPLAY_NUM#:}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM#:}" 2>/dev/null || true

Xvfb "$DISPLAY_NUM" \
    -screen 0 "$SCREEN_GEOMETRY" \
    -ac \
    -nolisten tcp \
    +extension RANDR \
    +extension GLX \
    +extension COMPOSITE \
    &
XVFB_PID=$!

# Wait for the display socket to appear before exec'ing Chrome's parent.
for _ in $(seq 1 50); do
    if [ -S "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ]; then break; fi
    sleep 0.1
done

export DISPLAY="$DISPLAY_NUM"

# Session dbus avoids Chrome's "Failed to connect to the bus" spam and gives
# the keyring/notification stubs something to talk to.
if command -v dbus-launch >/dev/null 2>&1; then
    eval "$(dbus-launch --sh-syntax)"
fi

# Lightweight WM so Chrome gets real window decorations (title bar + border)
# — without it outerWidth == innerWidth, a fingerprint signal.
OPENBOX_PID=""
if command -v openbox >/dev/null 2>&1; then
    openbox >/tmp/openbox.log 2>&1 &
    OPENBOX_PID=$!
fi

X11VNC_PID=""
WEBSOCKIFY_PID=""
if [ "${ENABLE_VNC:-false}" = "true" ]; then
    echo "[entrypoint] ENABLE_VNC=true → starting x11vnc on :${VNC_PORT}, noVNC on :${NOVNC_PORT}"

    # -nopw is safe only because compose binds these ports to 127.0.0.1.
    # Never expose them on a public interface without -passwdfile.
    x11vnc \
        -display "$DISPLAY_NUM" \
        -rfbport "$VNC_PORT" \
        -forever \
        -shared \
        -nopw \
        -xkb \
        -noxdamage \
        -quiet \
        -bg \
        -o /tmp/x11vnc.log
    # -bg detaches; recover its PID via pgrep so we can stop it on shutdown.
    X11VNC_PID="$(pgrep -n -x x11vnc || true)"

    if [ -d /usr/share/novnc ]; then
        websockify \
            --web=/usr/share/novnc \
            "$NOVNC_PORT" "localhost:${VNC_PORT}" \
            >/tmp/websockify.log 2>&1 &
        WEBSOCKIFY_PID=$!
    else
        echo "[entrypoint] /usr/share/novnc missing — skipping noVNC bridge"
    fi
fi

cleanup() {
    [ -n "$WEBSOCKIFY_PID" ] && kill "$WEBSOCKIFY_PID" 2>/dev/null || true
    [ -n "$X11VNC_PID" ] && kill "$X11VNC_PID" 2>/dev/null || true
    [ -n "$OPENBOX_PID" ] && kill "$OPENBOX_PID" 2>/dev/null || true
    [ -n "${DBUS_SESSION_BUS_PID:-}" ] && kill "$DBUS_SESSION_BUS_PID" 2>/dev/null || true
    kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

# Stale singleton locks left by a previous container instance prevent Chrome
# startup with:
#   "Скорее всего, профиль используется другим процессом Google Chrome (<pid>)
#    на другом компьютере (<hostname>). Во избежание сбоев профиль был
#    заблокирован."
# Each container has a fresh hostname + PID namespace, so any lock found in
# the profile dir at startup is by definition from a dead predecessor and
# can be removed unconditionally.
PROFILE_DIR="${PUPPETEER_USER_DATA_DIR:-/app/.chrome-profile}"
if [ -d "$PROFILE_DIR" ]; then
    rm -f "$PROFILE_DIR/SingletonLock" \
          "$PROFILE_DIR/SingletonCookie" \
          "$PROFILE_DIR/SingletonSocket"
fi

exec "$@"
