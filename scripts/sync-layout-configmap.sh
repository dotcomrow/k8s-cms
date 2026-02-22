#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAYOUT_DIR="${ROOT_DIR}/layouts"
TEMPLATES_FILE="${LAYOUT_DIR}/templates.data"
OUT_FILE="${ROOT_DIR}/manifests/16-directus-layout-templates.yaml"

if ! command -v yq >/dev/null 2>&1; then
  echo "yq is required to run this script." >&2
  exit 1
fi

if [ ! -f "${TEMPLATES_FILE}" ]; then
  echo "Missing templates file: ${TEMPLATES_FILE}" >&2
  exit 1
fi

asset_files=()
while IFS= read -r asset; do
  [ -z "${asset}" ] && continue
  asset_files+=("${asset}")
done < <(
  yq -r '.templates[] | [.html_file, .css_file] | .[] | select(. != null and . != "")' "${TEMPLATES_FILE}" \
    | awk '!seen[$0]++'
)

for asset in "${asset_files[@]}"; do
  if [ ! -f "${LAYOUT_DIR}/${asset}" ]; then
    echo "Missing layout asset referenced by templates.data: ${asset}" >&2
    exit 1
  fi
done

TMP_FILE="$(mktemp)"
trap 'rm -f "${TMP_FILE}"' EXIT

{
  echo "# Directus layout templates (GitOps source of truth)."
  echo "# Generated from ./layouts via scripts/sync-layout-configmap.sh"
  echo "apiVersion: v1"
  echo "kind: ConfigMap"
  echo "metadata:"
  echo "  name: directus-layout-templates"
  echo "  namespace: directus"
  echo "  labels:"
  echo "    app: directus"
  echo "data:"

  echo "  templates.yaml: |"
  sed 's/^/    /' "${TEMPLATES_FILE}"

  for asset in "${asset_files[@]}"; do
    echo "  ${asset}: |"
    sed 's/^/    /' "${LAYOUT_DIR}/${asset}"
  done
} >"${TMP_FILE}"

mv "${TMP_FILE}" "${OUT_FILE}"
trap - EXIT

echo "Wrote ${OUT_FILE}"
