#!/usr/bin/env bash
# Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
#
# `ceremony-soakctl` — control for the unattended distributed-ceremony soak.
#
#   install    write the systemd USER units for this checkout and enable the timer
#   uninstall  disable the timer and remove the units (the state dir is kept)
#   start      clear PAUSED and start the timer
#   stop       stop the timer AND the service, and set PAUSED
#   pause      stop the timer and set PAUSED (an in-flight run finishes)
#   status     state dir + systemd timer state + the soak's status block
#   report     the last N JSONL records + the status block
#   run-now    trigger one run immediately (systemctl --user start the service)
#   logs       follow the unit's journal
#
# Everything is a USER unit: no root, no system-wide service. `loginctl
# enable-linger` makes the timer survive logout (already enabled on baospace).
#
# The soak itself runs from THIS checkout (`--repo=`), so a checkout that gets
# deleted takes the program with it: install it from a durable path.

set -uo pipefail

UNIT_NAME="bao-court-ceremony-soak"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF_DIR/../.." && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/bao-court-ceremony-soak"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SOAK="scripts/court/distributed-ceremony-soak.mjs"

for arg in "$@"; do
  case "$arg" in
    --repo=*) REPO="${arg#*=}" ;;
    --state-dir=*) STATE_DIR="${arg#*=}" ;;
    --help|-h)
      sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
  esac
done

verb="${1:-status}"
[ $# -gt 0 ] && shift

soak() { ( cd "$REPO" && node --import tsx "$SOAK" "$@" --state-dir="$STATE_DIR" ); }

install_units() {
  [ -d "$REPO/node_modules/tsx" ] || { echo "no tsx in $REPO — run: (cd $REPO && npm ci)"; exit 1; }
  mkdir -p "$UNIT_DIR"
  for unit in service timer; do
    sed "s|@REPO@|$REPO|g" "$REPO/scripts/court/systemd/${UNIT_NAME}.${unit}" \
      > "$UNIT_DIR/${UNIT_NAME}.${unit}"
  done
  systemctl --user daemon-reload
  systemctl --user enable --now "${UNIT_NAME}.timer"
  echo "installed ${UNIT_NAME}.timer from $REPO"
  systemctl --user list-timers "${UNIT_NAME}.timer" --no-pager || true
}

case "$verb" in
  install)
    install_units
    ;;
  uninstall)
    systemctl --user disable --now "${UNIT_NAME}.timer" 2>/dev/null || true
    systemctl --user stop "${UNIT_NAME}.service" 2>/dev/null || true
    rm -f "$UNIT_DIR/${UNIT_NAME}.timer" "$UNIT_DIR/${UNIT_NAME}.service"
    systemctl --user daemon-reload
    echo "removed the timer and service; state kept at $STATE_DIR"
    ;;
  start)
    rm -f "$STATE_DIR/PAUSED"
    systemctl --user start "${UNIT_NAME}.timer" 2>/dev/null || install_units
    systemctl --user list-timers "${UNIT_NAME}.timer" --no-pager || true
    ;;
  pause)
    systemctl --user stop "${UNIT_NAME}.timer" 2>/dev/null || true
    mkdir -p "$STATE_DIR" && : > "$STATE_DIR/PAUSED"
    echo "paused: timer stopped and PAUSED set (an in-flight run finishes)"
    ;;
  stop)
    systemctl --user stop "${UNIT_NAME}.timer" 2>/dev/null || true
    systemctl --user stop "${UNIT_NAME}.service" 2>/dev/null || true
    mkdir -p "$STATE_DIR" && : > "$STATE_DIR/PAUSED"
    echo "stopped: timer + service, PAUSED set"
    ;;
  status)
    echo "== systemd"
    systemctl --user is-enabled "${UNIT_NAME}.timer" 2>/dev/null || echo "timer: not installed"
    systemctl --user is-active "${UNIT_NAME}.service" 2>/dev/null | sed 's/^/service now: /'
    systemctl --user list-timers "${UNIT_NAME}.timer" --no-pager 2>/dev/null | sed -n '1,3p' || true
    echo "== soak"
    soak status
    ;;
  report)
    soak report "$@"
    ;;
  run-now)
    systemctl --user start "${UNIT_NAME}.service"
    echo "started ${UNIT_NAME}.service (journal: ceremony-soakctl.sh logs)"
    ;;
  logs)
    journalctl --user -u "${UNIT_NAME}.service" -n 80 --no-pager -f
    ;;
  preflight)
    soak preflight
    ;;
  next)
    soak next
    ;;
  *)
    echo "usage: $0 {install|uninstall|start|stop|pause|status|report|run-now|logs|preflight|next} [--repo=…] [--state-dir=…]"
    exit 2
    ;;
esac
