output "db_instance_id" {
  value = oci_core_instance.directus_db.id
}

output "db_public_ip" {
  value = local.db_public_ip
}

output "db_private_ip" {
  value = local.db_private_ip
}

output "db_host" {
  value = local.db_host
}

output "db_port" {
  value = 5432
}

output "db_name" {
  value = var.db_name
}

output "directus_uploads_nfs_enabled" {
  value = var.enable_directus_uploads_nfs
}

output "directus_uploads_nfs_host" {
  value = local.db_host
}

output "directus_uploads_nfs_path" {
  value = var.directus_uploads_export_path
}

output "directus_db_user" {
  value     = var.directus_db_user
  sensitive = true
}

output "db_tunnel_user" {
  value = var.db_tunnel_user
}

output "db_tunnel_enabled" {
  value = var.enable_db_ssh_tunnel
}

output "db_tunnel_host" {
  value = local.db_host
}

output "db_tunnel_port" {
  value = 22
}

output "db_tunnel_local_port" {
  value = var.db_tunnel_local_port
}

output "db_tunnel_private_key_b64" {
  value     = var.enable_db_ssh_tunnel ? local.db_tunnel_private_key_b64 : null
  sensitive = true
}

output "db_tunnel_public_key" {
  value     = var.enable_db_ssh_tunnel ? local.db_tunnel_public_key_openssh : null
  sensitive = true
}

output "vault_secret_directus_db" {
  value = {
    host     = local.db_host
    port     = "5432"
    database = var.db_name
    username = var.directus_db_user
    password = var.directus_db_password
    ssh_tunnel_enabled    = tostring(var.enable_db_ssh_tunnel)
    ssh_tunnel_host       = local.db_host
    ssh_tunnel_port       = "22"
    ssh_tunnel_user       = var.db_tunnel_user
    ssh_tunnel_local_port = tostring(var.db_tunnel_local_port)
    ssh_tunnel_remote_port = "5432"
    ssh_private_key_b64   = var.enable_db_ssh_tunnel ? local.db_tunnel_private_key_b64 : ""
  }
  sensitive = true
}

output "vault_secret_directus_db_root" {
  value = {
    directus_db_host                       = local.db_host
    directus_db_port                       = "5432"
    directus_db_database                   = var.db_name
    directus_db_username                   = var.directus_db_user
    directus_db_password                   = var.directus_db_password
    directus_db_ssh_tunnel_enabled         = tostring(var.enable_db_ssh_tunnel)
    directus_db_ssh_tunnel_host            = local.db_host
    directus_db_ssh_tunnel_port            = "22"
    directus_db_ssh_tunnel_user            = var.db_tunnel_user
    directus_db_ssh_tunnel_local_port      = tostring(var.db_tunnel_local_port)
    directus_db_ssh_tunnel_remote_port     = "5432"
    directus_db_ssh_private_key_b64        = var.enable_db_ssh_tunnel ? local.db_tunnel_private_key_b64 : ""
  }
  sensitive = true
}
