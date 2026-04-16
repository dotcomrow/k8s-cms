# Oracle Directus DB VM (Paid Tiny Tier)

This stack provisions a small paid Oracle Cloud VM for PostgreSQL and bootstraps a Directus database/user idempotently. It now lives in the main `terraform/` module so GitHub Actions can plan/apply GCP + OCI in one run.

## Why this stack

- Keeps DB state outside the k8s platform.
- Uses explicit `directus_db_user` / `directus_db_password` variables so credentials stay constant across platform rebuilds.
- `prevent_destroy = true` by default to avoid accidental VM deletion.
- Uses an automated SSH tunnel path by default (`enable_db_ssh_tunnel=true`):
  - PostgreSQL listens on localhost only.
  - No public ingress rule for 5432 is created.
  - Cloud-init creates the tunnel user and installs the tunnel public key automatically.
  - Terraform exposes a Vault-ready secret payload for Directus.

## Usage

```sh
cd terraform
terraform init
terraform apply \
  -var "oci_tenancy_ocid=..." \
  -var "oci_user_ocid=..." \
  -var "oci_fingerprint=..." \
  -var "oci_private_key=${OCI_PRIVATE_KEY_PEM}" \
  -var "oci_region=us-phoenix-1" \
  -var "oci_compartment_ocid=..." \
  -var "directus_db_user=directus_app" \
  -var "directus_db_password=REPLACE_WITH_LONG_SECRET" \
  -var 'ssh_authorized_keys=["ssh-ed25519 AAAA..."]' \
  -var 'db_allowed_cidrs=["X.X.X.X/32"]' \
  -var 'ssh_allowed_cidrs=["Y.Y.Y.Y/32"]'
```

Note: `db_allowed_cidrs` is used only when `enable_db_ssh_tunnel=false`.

For Terraform Cloud, create a sensitive variable named `oci_private_key` and paste the full PEM key contents (including `-----BEGIN ...-----` / `-----END ...-----` lines).

### Stable tunnel credentials (recommended)

To keep SSH tunnel auth stable even if Terraform state/workspace changes, set both of these Terraform variables once and keep them fixed:

- `db_tunnel_private_key_b64` (sensitive): base64 of the OpenSSH private key file.
- `db_tunnel_public_key`: matching OpenSSH public key line.

If both are set, Terraform uses them directly instead of generating a new keypair.

Example key generation:

```sh
ssh-keygen -t ed25519 -N '' -f ./directus-db-tunnel
base64 < ./directus-db-tunnel | tr -d '\n'
cat ./directus-db-tunnel.pub
```

Then seed Vault for Directus.

If your Vault policy allows nested paths:

```sh
vault write secret/data/directus/db \
  data="$(terraform output -json vault_secret_directus_db | jq -c '.value')"
```

If human-managed secrets must live only at root `secret/data`:

```sh
vault write secret/data \
  data="$(terraform output -json vault_secret_directus_db_root | jq -c '.value')"
```

Run a smoke test after apply:

```sh
./scripts/smoke-test-oci-directus-db.sh
```

The smoke test verifies:
- PostgreSQL is reachable.
- The configured username/password can authenticate.
- The active user and database match the expected values.
- In tunnel mode, SSH key auth to the tunnel user succeeds (fails fast with SSH error output if not).

For key troubleshooting, compare outputs:

```sh
terraform output -raw db_tunnel_public_key
terraform output -raw db_tunnel_private_key_b64 | base64 --decode | ssh-keygen -y -f /dev/stdin
```

## Cost knobs

- `db_baseline_utilization` default is `BASELINE_1_8` (lowest burstable baseline).
- `db_memory_gbs` default is `2` for a small but usable Postgres footprint.
- `db_ocpus` default is `1` (minimum for `VM.Standard.E4.Flex`).

## Directus behavior

- Keep Vault DB credentials aligned with the same `directus_db_user` and `directus_db_password` values from Terraform.
- Directus startup in this repo checks for `directus.directus_migrations`; if present, it skips `database install` and uses the existing DB.
- Directus reads optional tunnel fields from `secret/data/directus/db` (or root `secret/data` with `directus_db_*` keys) and uses an in-pod SSH tunnel when enabled.

## Connectivity Model

- Default model: private DB access over automated SSH tunnel (encrypted) with Postgres bound to localhost.
- Port `22` is still required for the tunnel endpoint; lock `ssh_allowed_cidrs` down to your cluster egress IP/CIDR.

## Cloud-init scope

- Cloud-init fully automates PostgreSQL install/bootstrap and tunnel-user setup at VM creation time.
- Cloud-init is first-boot initialization; it is not a continuous config-management loop.
