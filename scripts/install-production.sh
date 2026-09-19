#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

APP_DIR="${AUTOMATON_APP_DIR:-/opt/automaton}"
STATE_DIR="${AUTOMATON_STATE_DIR:-/root/.automaton}"
BACKUP_DIR="${AUTOMATON_BACKUP_DIR:-/var/backups/automaton}"
ENV_DIR="/etc/automaton"
CURRENT_DIR="$(pwd -P)"

if [[ "${CURRENT_DIR}" != "${APP_DIR}" ]]; then
  echo "Production checkout must be deployed at ${APP_DIR}; current directory is ${CURRENT_DIR}." >&2
  exit 1
fi

install -d -m 700 "${STATE_DIR}" "${BACKUP_DIR}" "${ENV_DIR}"

if [[ ! -f "${ENV_DIR}/automaton.env" ]]; then
  install -m 600 deploy/automaton.env.example "${ENV_DIR}/automaton.env"
fi

install -m 644 deploy/systemd/automaton.service /etc/systemd/system/automaton.service
install -m 644 deploy/systemd/automaton-backup.service /etc/systemd/system/automaton-backup.service
install -m 644 deploy/systemd/automaton-backup.timer /etc/systemd/system/automaton-backup.timer

systemctl daemon-reload
systemctl enable automaton.service automaton-backup.timer

echo "Production units installed."
echo "Next: pnpm install --frozen-lockfile && pnpm build && pnpm production:health"
echo "Then: systemctl start automaton.service automaton-backup.timer"
