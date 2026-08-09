#!/usr/bin/env sh
set -eu

FLINK_REST_TARGET="${FLINK_REST_TARGET:-flink-rest.kafka.svc.cluster.local:8081}"
RUNTIME_STATUS_URL="${RUNTIME_STATUS_URL:-http://runtime-status-service.directus.svc.cluster.local:8080}"
CANARY_DEFINITION_KEY="${CANARY_DEFINITION_KEY-}"
CANARY_SOURCE="${CANARY_SOURCE:-flink}"
ENDPOINT_MODE="${ENDPOINT_MODE:-action}"
CONNECT_TIMEOUT_MS="${CONNECT_TIMEOUT_MS:-5000}"
HTTP_TIMEOUT_MS="${HTTP_TIMEOUT_MS:-60000}"
FAIL_ON_WARNING="${FAIL_ON_WARNING:-false}"
FAIL_ON_SKIPPED="${FAIL_ON_SKIPPED:-false}"
REQUIRE_STEPS="${REQUIRE_STEPS:-true}"

exec /opt/flink/bin/flink run \
  -m "${FLINK_REST_TARGET}" \
  -c com.suncoast.runtime.status.flink.RuntimeStatusCanaryJob \
  /opt/flink/usrlib/runtime-status-flink-job.jar \
  --runtime-status-url "${RUNTIME_STATUS_URL}" \
  --definition-key "${CANARY_DEFINITION_KEY}" \
  --source "${CANARY_SOURCE}" \
  --endpoint-mode "${ENDPOINT_MODE}" \
  --connect-timeout-ms "${CONNECT_TIMEOUT_MS}" \
  --http-timeout-ms "${HTTP_TIMEOUT_MS}" \
  --fail-on-warning "${FAIL_ON_WARNING}" \
  --fail-on-skipped "${FAIL_ON_SKIPPED}" \
  --require-steps "${REQUIRE_STEPS}"
