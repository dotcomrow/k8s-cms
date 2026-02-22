#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
THEME_DIR="${ROOT_DIR}/themes"
THEMES_FILE="${THEME_DIR}/themes.data"
OUT_FILE="${ROOT_DIR}/manifests/17-directus-theme-packages.yaml"

if ! command -v yq >/dev/null 2>&1; then
  echo "yq is required to run this script." >&2
  exit 1
fi

if [ ! -f "${THEMES_FILE}" ]; then
  echo "Missing themes file: ${THEMES_FILE}" >&2
  exit 1
fi

asset_files=()
while IFS= read -r asset; do
  [ -z "${asset}" ] && continue
  asset_files+=("${asset}")
done < <(
  yq -r '.themes[] | .css_file | select(. != null and . != "")' "${THEMES_FILE}" \
    | awk '!seen[$0]++'
)

for asset in "${asset_files[@]}"; do
  if [ ! -f "${THEME_DIR}/${asset}" ]; then
    echo "Missing theme asset referenced by themes.data: ${asset}" >&2
    exit 1
  fi
done

TMP_FILE="$(mktemp)"
trap 'rm -f "${TMP_FILE}"' EXIT

{
  echo "# Directus theme packages (GitOps source of truth)."
  echo "# Generated from ./themes via scripts/sync-theme-configmap.sh"
  echo "apiVersion: v1"
  echo "kind: ConfigMap"
  echo "metadata:"
  echo "  name: directus-theme-packages"
  echo "  namespace: directus"
  echo "  labels:"
  echo "    app: directus"
  echo "data:"

  echo "  themes.yaml: |"
  sed 's/^/    /' "${THEMES_FILE}"

  for asset in "${asset_files[@]}"; do
    echo "  ${asset}: |"
    sed 's/^/    /' "${THEME_DIR}/${asset}"
  done
} >"${TMP_FILE}"

mv "${TMP_FILE}" "${OUT_FILE}"
trap - EXIT

echo "Wrote ${OUT_FILE}"
