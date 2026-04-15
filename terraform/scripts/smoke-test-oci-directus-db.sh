#!/usr/bin/env bash
set -euo pipefail

if ! command -v terraform >/dev/null 2>&1; then
  echo "terraform command not found in PATH"
  exit 1
fi

if [ ! -f "terraform.tfstate" ] && [ ! -d ".terraform" ]; then
  echo "Run this from terraform after terraform init/apply."
  exit 1
fi

DB_HOST="${DB_HOST:-$(terraform output -raw db_host 2>/dev/null || true)}"
DB_PORT="${DB_PORT:-$(terraform output -raw db_port 2>/dev/null || true)}"
DB_NAME="${DB_NAME:-$(terraform output -raw db_name 2>/dev/null || true)}"
DB_USER="${DB_USER:-$(terraform output -raw directus_db_user 2>/dev/null || true)}"
DB_PASSWORD="${DB_PASSWORD:-${TF_VAR_directus_db_password:-}}"
DB_TUNNEL_ENABLED="${DB_TUNNEL_ENABLED:-$(terraform output -raw db_tunnel_enabled 2>/dev/null || true)}"
DB_TUNNEL_HOST="${DB_TUNNEL_HOST:-$(terraform output -raw db_tunnel_host 2>/dev/null || true)}"
DB_TUNNEL_PORT="${DB_TUNNEL_PORT:-$(terraform output -raw db_tunnel_port 2>/dev/null || true)}"
DB_TUNNEL_USER="${DB_TUNNEL_USER:-$(terraform output -raw db_tunnel_user 2>/dev/null || true)}"
DB_TUNNEL_LOCAL_PORT="${DB_TUNNEL_LOCAL_PORT:-$(terraform output -raw db_tunnel_local_port 2>/dev/null || true)}"
DB_TUNNEL_PRIVATE_KEY_B64="${DB_TUNNEL_PRIVATE_KEY_B64:-$(terraform output -raw db_tunnel_private_key_b64 2>/dev/null || true)}"

if [ -z "${DB_HOST}" ] || [ -z "${DB_PORT}" ] || [ -z "${DB_NAME}" ] || [ -z "${DB_USER}" ]; then
  echo "Missing DB connection details. Set DB_HOST/DB_PORT/DB_NAME/DB_USER or ensure terraform outputs exist."
  exit 1
fi

if [ -z "${DB_PASSWORD}" ]; then
  echo "Missing DB_PASSWORD (or TF_VAR_directus_db_password)."
  exit 1
fi

run_psql() {
  local host="$1"
  local port="$2"
  PGPASSWORD="${DB_PASSWORD}" PGCONNECT_TIMEOUT=5 \
    psql \
      -h "${host}" \
      -p "${port}" \
      -U "${DB_USER}" \
      -d "${DB_NAME}" \
      -Atc "SELECT current_user || '|' || current_database();"
}

RESULT=""
TEST_HOST="${DB_HOST}"
TEST_PORT="${DB_PORT}"
SSH_PID=""
TMP_DIR=""

cleanup() {
  if [ -n "${SSH_PID}" ]; then
    kill "${SSH_PID}" >/dev/null 2>&1 || true
    wait "${SSH_PID}" 2>/dev/null || true
  fi
  if [ -n "${TMP_DIR}" ] && [ -d "${TMP_DIR}" ]; then
    rm -rf "${TMP_DIR}"
  fi
}
trap cleanup EXIT

if [ "${DB_TUNNEL_ENABLED}" = "true" ]; then
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql is required for tunnel-mode smoke tests."
    exit 1
  fi
  if ! command -v ssh >/dev/null 2>&1; then
    echo "ssh client is required for tunnel-mode smoke tests."
    exit 1
  fi
  if [ -z "${DB_TUNNEL_PRIVATE_KEY_B64}" ] || [ -z "${DB_TUNNEL_HOST}" ] || [ -z "${DB_TUNNEL_PORT}" ] || [ -z "${DB_TUNNEL_USER}" ] || [ -z "${DB_TUNNEL_LOCAL_PORT}" ]; then
    echo "Tunnel mode outputs are incomplete."
    exit 1
  fi

  TMP_DIR="$(mktemp -d)"
  KEY_FILE="${TMP_DIR}/id_ed25519"
  KNOWN_HOSTS_FILE="${TMP_DIR}/known_hosts"
  if printf '%s' "${DB_TUNNEL_PRIVATE_KEY_B64}" | base64 --decode > "${KEY_FILE}" 2>/dev/null; then
    true
  elif printf '%s' "${DB_TUNNEL_PRIVATE_KEY_B64}" | base64 -d > "${KEY_FILE}" 2>/dev/null; then
    true
  else
    printf '%s' "${DB_TUNNEL_PRIVATE_KEY_B64}" | base64 -D > "${KEY_FILE}"
  fi
  chmod 600 "${KEY_FILE}"
  touch "${KNOWN_HOSTS_FILE}"

  echo "Running DB smoke test through SSH tunnel ${DB_TUNNEL_USER}@${DB_TUNNEL_HOST}:${DB_TUNNEL_PORT} ..."
  ssh \
    -N \
    -i "${KEY_FILE}" \
    -o ExitOnForwardFailure=yes \
    -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="${KNOWN_HOSTS_FILE}" \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -p "${DB_TUNNEL_PORT}" \
    -L "127.0.0.1:${DB_TUNNEL_LOCAL_PORT}:127.0.0.1:5432" \
    "${DB_TUNNEL_USER}@${DB_TUNNEL_HOST}" >/tmp/directus-db-smoke-tunnel.log 2>/tmp/directus-db-smoke.err &
  SSH_PID=$!
  sleep 2
  TEST_HOST="127.0.0.1"
  TEST_PORT="${DB_TUNNEL_LOCAL_PORT}"
  RESULT="$(run_psql "${TEST_HOST}" "${TEST_PORT}" 2>/tmp/directus-db-smoke.err || true)"
else
  echo "Running DB smoke test against ${TEST_HOST}:${TEST_PORT}/${DB_NAME} as ${DB_USER} ..."
  if command -v psql >/dev/null 2>&1; then
    RESULT="$(run_psql "${TEST_HOST}" "${TEST_PORT}" 2>/tmp/directus-db-smoke.err || true)"
  elif command -v docker >/dev/null 2>&1; then
    RESULT="$(docker run --rm \
      -e PGPASSWORD="${DB_PASSWORD}" \
      postgres:16-alpine \
      psql \
        -h "${TEST_HOST}" \
        -p "${TEST_PORT}" \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        -Atc "SELECT current_user || '|' || current_database();" \
      2>/tmp/directus-db-smoke.err || true)"
  else
    echo "Neither psql nor docker is available to run the smoke test."
    exit 1
  fi
fi

AUTH_USER="$(printf '%s' "${RESULT}" | cut -d'|' -f1 | tr -d '\r')"
AUTH_DB="$(printf '%s' "${RESULT}" | cut -d'|' -f2 | tr -d '\r')"

if [ "${AUTH_USER}" != "${DB_USER}" ] || [ "${AUTH_DB}" != "${DB_NAME}" ]; then
  echo "Smoke test failed. Expected user=${DB_USER} db=${DB_NAME}; got user=${AUTH_USER:-<empty>} db=${AUTH_DB:-<empty>}."
  if [ -f /tmp/directus-db-smoke.err ]; then
    tail -n 3 /tmp/directus-db-smoke.err || true
  fi
  exit 1
fi

echo "DB smoke test passed (user=${AUTH_USER}, db=${AUTH_DB})."
