provider "oci" {
  tenancy_ocid     = var.oci_tenancy_ocid
  user_ocid        = var.oci_user_ocid
  fingerprint      = var.oci_fingerprint
  private_key      = replace(var.oci_private_key, "\\n", "\n")
  region           = var.oci_region
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.oci_tenancy_ocid
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.oci_tenancy_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.db_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_vcn" "directus_db" {
  compartment_id = var.oci_compartment_ocid
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "${var.db_instance_name}-vcn"
  dns_label      = var.vcn_dns_label
}

resource "oci_core_internet_gateway" "directus_db" {
  compartment_id = var.oci_compartment_ocid
  vcn_id         = oci_core_vcn.directus_db.id
  display_name   = "${var.db_instance_name}-igw"
  enabled        = true
}

resource "oci_core_route_table" "directus_db" {
  compartment_id = var.oci_compartment_ocid
  vcn_id         = oci_core_vcn.directus_db.id
  display_name   = "${var.db_instance_name}-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.directus_db.id
  }
}

locals {
  directus_uploads_nfs_tcp_ports = var.enable_directus_uploads_nfs ? distinct(concat(
    [2049],
    var.directus_uploads_nfs_enable_v3_compat ? [
      var.directus_uploads_nfs_rpcbind_port,
      var.directus_uploads_nfs_mountd_port
    ] : []
  )) : []
  directus_uploads_nfs_udp_ports = var.enable_directus_uploads_nfs ? distinct(concat(
    [2049],
    var.directus_uploads_nfs_enable_v3_compat ? [
      var.directus_uploads_nfs_rpcbind_port,
      var.directus_uploads_nfs_mountd_port
    ] : []
  )) : []
  directus_uploads_nfs_tcp_rules = flatten([
    for cidr in var.directus_uploads_nfs_allowed_cidrs : [
      for port in local.directus_uploads_nfs_tcp_ports : {
        cidr = cidr
        port = port
      }
    ]
  ])
  directus_uploads_nfs_udp_rules = flatten([
    for cidr in var.directus_uploads_nfs_allowed_cidrs : [
      for port in local.directus_uploads_nfs_udp_ports : {
        cidr = cidr
        port = port
      }
    ]
  ])
}

resource "oci_core_security_list" "directus_db" {
  compartment_id = var.oci_compartment_ocid
  vcn_id         = oci_core_vcn.directus_db.id
  display_name   = "${var.db_instance_name}-sl"

  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }

  dynamic "ingress_security_rules" {
    for_each = var.enable_db_ssh_tunnel ? [] : var.db_allowed_cidrs
    content {
      protocol = "6"
      source   = ingress_security_rules.value
      tcp_options {
        min = 5432
        max = 5432
      }
    }
  }

  dynamic "ingress_security_rules" {
    for_each = var.ssh_allowed_cidrs
    content {
      protocol = "6"
      source   = ingress_security_rules.value
      tcp_options {
        min = 22
        max = 22
      }
    }
  }

  dynamic "ingress_security_rules" {
    for_each = local.directus_uploads_nfs_tcp_rules
    content {
      protocol = "6"
      source   = ingress_security_rules.value.cidr
      tcp_options {
        min = ingress_security_rules.value.port
        max = ingress_security_rules.value.port
      }
    }
  }

  dynamic "ingress_security_rules" {
    for_each = local.directus_uploads_nfs_udp_rules
    content {
      protocol = "17"
      source   = ingress_security_rules.value.cidr
      udp_options {
        min = ingress_security_rules.value.port
        max = ingress_security_rules.value.port
      }
    }
  }
}

resource "oci_core_subnet" "directus_db" {
  compartment_id             = var.oci_compartment_ocid
  vcn_id                     = oci_core_vcn.directus_db.id
  cidr_block                 = var.subnet_cidr
  display_name               = "${var.db_instance_name}-subnet"
  dns_label                  = var.subnet_dns_label
  route_table_id             = oci_core_route_table.directus_db.id
  security_list_ids          = [oci_core_security_list.directus_db.id]
  prohibit_public_ip_on_vnic = !var.assign_public_ip
}

locals {
  selected_image_id          = coalesce(var.db_image_ocid, data.oci_core_images.ubuntu.images[0].id)
  has_db_tunnel_private_key  = var.db_tunnel_private_key_b64 != null && trimspace(var.db_tunnel_private_key_b64) != ""
  has_db_tunnel_public_key   = var.db_tunnel_public_key != null && trimspace(var.db_tunnel_public_key) != ""
  use_provided_db_tunnel_key = var.enable_db_ssh_tunnel && local.has_db_tunnel_private_key && local.has_db_tunnel_public_key

  postgres_listen_addresses = var.enable_db_ssh_tunnel ? "127.0.0.1" : "*"
  postgres_hba_rules = concat(
    [
      "host all all 127.0.0.1/32 scram-sha-256",
      "host all all ::1/128 scram-sha-256",
    ],
    var.enable_db_ssh_tunnel ? [] : [for cidr in var.db_allowed_cidrs : "host all all ${cidr} scram-sha-256"]
  )

  db_tunnel_public_key_openssh = var.enable_db_ssh_tunnel ? (
    local.use_provided_db_tunnel_key ? trimspace(var.db_tunnel_public_key) : tls_private_key.db_tunnel[0].public_key_openssh
  ) : ""
  db_tunnel_private_key_b64 = var.enable_db_ssh_tunnel ? (
    local.use_provided_db_tunnel_key ? trimspace(var.db_tunnel_private_key_b64) : base64encode(tls_private_key.db_tunnel[0].private_key_openssh)
  ) : ""
  instance_ssh_authorized_keys = distinct(compact(concat(
    var.ssh_authorized_keys,
    var.enable_db_ssh_tunnel ? [local.db_tunnel_public_key_openssh] : []
  )))

  directus_uploads_nfs_exports = var.enable_directus_uploads_nfs ? join("\n      ", [
    for cidr in var.directus_uploads_nfs_allowed_cidrs :
    "${var.directus_uploads_export_path} ${cidr}(rw,sync,no_subtree_check,all_squash,anonuid=${var.directus_uploads_nfs_anon_uid},anongid=${var.directus_uploads_nfs_anon_gid})"
  ]) : ""
}

resource "tls_private_key" "db_tunnel" {
  count     = var.enable_db_ssh_tunnel && !local.use_provided_db_tunnel_key ? 1 : 0
  algorithm = "ED25519"
}

resource "oci_core_instance" "directus_db" {
  compartment_id      = var.oci_compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = var.db_instance_name
  shape               = var.db_shape

  shape_config {
    ocpus                     = var.db_ocpus
    memory_in_gbs             = var.db_memory_gbs
    baseline_ocpu_utilization = var.db_baseline_utilization
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.directus_db.id
    # Use a reserved public IP resource when enabled instead of an ephemeral IP.
    assign_public_ip = false
    hostname_label   = var.instance_hostname_label
  }

  source_details {
    source_type             = "image"
    source_id               = local.selected_image_id
    boot_volume_size_in_gbs = var.db_boot_volume_size_gb
  }

  metadata = {
    user_data = base64encode(templatefile("${path.module}/templates/cloud-init-directus-db.tftpl", {
      db_name                  = var.db_name
      directus_db_user         = var.directus_db_user
      directus_db_password     = var.directus_db_password
      postgres_listen_addresses = local.postgres_listen_addresses
      # Keep each injected pg_hba rule indented inside cloud-init's script block.
      pg_hba_rules             = join("\n      ", local.postgres_hba_rules)
      enable_db_ssh_tunnel     = var.enable_db_ssh_tunnel
      db_tunnel_user           = var.db_tunnel_user
      db_tunnel_public_key     = local.db_tunnel_public_key_openssh
      enable_directus_uploads_nfs = var.enable_directus_uploads_nfs
      directus_uploads_export_path = var.directus_uploads_export_path
      directus_uploads_nfs_anon_uid = tostring(var.directus_uploads_nfs_anon_uid)
      directus_uploads_nfs_anon_gid = tostring(var.directus_uploads_nfs_anon_gid)
      directus_uploads_nfs_enable_v3_compat = var.directus_uploads_nfs_enable_v3_compat
      directus_uploads_nfs_rpcbind_port = tostring(var.directus_uploads_nfs_rpcbind_port)
      directus_uploads_nfs_mountd_port = tostring(var.directus_uploads_nfs_mountd_port)
      directus_uploads_nfs_allowed_cidrs = join("\n", var.directus_uploads_nfs_allowed_cidrs)
      directus_uploads_nfs_exports = local.directus_uploads_nfs_exports
    }))
    ssh_authorized_keys = join("\n", local.instance_ssh_authorized_keys)
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.db_ocpus >= 1
      error_message = "Set db_ocpus >= 1 for VM.Standard.E4.Flex."
    }

    precondition {
      condition     = var.db_memory_gbs >= 1
      error_message = "Set db_memory_gbs >= 1."
    }

    precondition {
      condition = !var.enable_db_ssh_tunnel || (
        (local.has_db_tunnel_private_key && local.has_db_tunnel_public_key) ||
        (!local.has_db_tunnel_private_key && !local.has_db_tunnel_public_key)
      )
      error_message = "When enable_db_ssh_tunnel=true, set both db_tunnel_private_key_b64 and db_tunnel_public_key together, or leave both unset to auto-generate."
    }
  }
}

data "oci_core_vnic_attachments" "directus_db" {
  count          = var.assign_public_ip ? 1 : 0
  compartment_id = var.oci_compartment_ocid
  instance_id    = oci_core_instance.directus_db.id

  depends_on = [oci_core_instance.directus_db]
}

data "oci_core_vnic" "directus_db_primary" {
  count   = var.assign_public_ip ? 1 : 0
  vnic_id = data.oci_core_vnic_attachments.directus_db[0].vnic_attachments[0].vnic_id
}

data "oci_core_private_ips" "directus_db_primary_vnic" {
  count   = var.assign_public_ip ? 1 : 0
  vnic_id = data.oci_core_vnic.directus_db_primary[0].id
}

locals {
  # Resolve the primary private IP OCID for reserved public IP association.
  db_primary_private_ip_id = var.assign_public_ip ? one([
    for ip in data.oci_core_private_ips.directus_db_primary_vnic[0].private_ips : ip.id
    if ip.is_primary
  ]) : null
}

resource "oci_core_public_ip" "directus_db_reserved" {
  count          = var.assign_public_ip ? 1 : 0
  compartment_id = var.oci_compartment_ocid
  display_name   = "${var.db_instance_name}-reserved-public-ip"
  lifetime       = "RESERVED"
  private_ip_id  = local.db_primary_private_ip_id

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  db_private_ip = oci_core_instance.directus_db.private_ip
  db_public_ip  = var.assign_public_ip ? oci_core_public_ip.directus_db_reserved[0].ip_address : null
  db_host       = var.assign_public_ip ? local.db_public_ip : local.db_private_ip
}
