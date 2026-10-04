#!/usr/bin/env bash
set -euo pipefail

TFC_HOSTNAME="${TFC_HOSTNAME:-app.terraform.io}"
TFC_ORGANIZATION="${TFC_ORGANIZATION:-dotcomrow}"
TFC_WORKSPACE="${TFC_WORKSPACE:-k8s-cms}"
KUBERNETES_NAMESPACE="${KUBERNETES_NAMESPACE:-directus}"
KUBERNETES_SECRET_NAME="${KUBERNETES_SECRET_NAME:-directus-backup-gcs}"
KUBERNETES_CONFIGMAP_NAME="${KUBERNETES_CONFIGMAP_NAME:-directus-backup-config}"
TFC_TOKEN="${TFC_TOKEN:-${TF_API_TOKEN:-${TFE_TOKEN:-}}}"
OUTPUT_NAME="directus_backup_service_account_key_b64"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_TEMPLATE="${SCRIPT_DIR}/../templates/directus-backup-config.yaml.tftpl"

for command_name in curl jq kubectl; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "Required command not found: ${command_name}" >&2
    exit 1
  }
done

if [[ -z "${TFC_TOKEN}" ]]; then
  echo "Set TFC_TOKEN, TF_API_TOKEN, or TFE_TOKEN to a token with permission to read sensitive state outputs." >&2
  exit 1
fi

if [[ ! -f "${CONFIG_TEMPLATE}" ]]; then
  echo "Backup ConfigMap template not found: ${CONFIG_TEMPLATE}" >&2
  exit 1
fi

api_get() {
  curl --fail --silent --show-error \
    --header "Authorization: Bearer ${TFC_TOKEN}" \
    --header "Content-Type: application/vnd.api+json" \
    "https://${TFC_HOSTNAME}/api/v2${1}"
}

decode_base64() {
  if printf '' | base64 --decode >/dev/null 2>&1; then
    base64 --decode
  else
    base64 -D
  fi
}

work_dir="$(mktemp -d)"
chmod 700 "${work_dir}"
trap 'rm -rf "${work_dir}"' EXIT
credential_file="${work_dir}/service-account.json"
rendered_config="${work_dir}/directus-backup-config.yaml"

workspace_id="$(
  api_get "/organizations/${TFC_ORGANIZATION}/workspaces/${TFC_WORKSPACE}" \
    | jq -er '.data.id'
)"

outputs_json="$(api_get "/workspaces/${workspace_id}/current-state-version-outputs")"
output_id="$(
  printf '%s' "${outputs_json}" \
    | jq -er --arg name "${OUTPUT_NAME}" '.data[] | select(.attributes.name == $name) | .id'
)"
expected_service_account="$(
  printf '%s' "${outputs_json}" \
    | jq -er '.data[] | select(.attributes.name == "directus_backup_service_account") | .attributes.value'
)"
gcs_bucket="$(
  printf '%s' "${outputs_json}" \
    | jq -er '.data[] | select(.attributes.name == "directus_backup_bucket") | .attributes.value'
)"

if [[ ! "${gcs_bucket}" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]]; then
  echo "Terraform output directus_backup_bucket is not a valid GCS bucket name." >&2
  exit 1
fi

# The collection endpoint redacts sensitive values. Fetch the selected output
# resource directly, keeping the credential only in a mode-0600 temporary file.
api_get "/state-version-outputs/${output_id}" \
  | jq -er '.data.attributes.value' \
  | decode_base64 >"${credential_file}"
chmod 600 "${credential_file}"

jq -e \
  --arg expected "${expected_service_account}" \
  '.type == "service_account" and .client_email == $expected and (.private_key | length > 0)' \
  "${credential_file}" >/dev/null

sed "s/__GCS_BUCKET__/${gcs_bucket}/g" "${CONFIG_TEMPLATE}" >"${rendered_config}"
grep -q "GCS_BUCKET: \"${gcs_bucket}\"" "${rendered_config}"

kubectl apply -f "${rendered_config}" >/dev/null

kubectl create secret generic "${KUBERNETES_SECRET_NAME}" \
  --namespace "${KUBERNETES_NAMESPACE}" \
  --from-file="service-account.json=${credential_file}" \
  --dry-run=client \
  --output=yaml \
  | kubectl apply -f - >/dev/null

kubectl label secret "${KUBERNETES_SECRET_NAME}" \
  --namespace "${KUBERNETES_NAMESPACE}" \
  app.kubernetes.io/name=directus-full-backup \
  app.kubernetes.io/managed-by=terraform-output-reconciler \
  --overwrite >/dev/null

applied_bucket="$(
  kubectl get configmap "${KUBERNETES_CONFIGMAP_NAME}" \
    --namespace "${KUBERNETES_NAMESPACE}" \
    --output=jsonpath='{.data.GCS_BUCKET}'
)"
if [[ "${applied_bucket}" != "${gcs_bucket}" ]]; then
  echo "Applied ConfigMap bucket does not match the Terraform output." >&2
  exit 1
fi

echo "Reconciled ${KUBERNETES_NAMESPACE}/${KUBERNETES_CONFIGMAP_NAME} and ${KUBERNETES_NAMESPACE}/${KUBERNETES_SECRET_NAME} from Terraform outputs."
