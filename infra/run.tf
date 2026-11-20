resource "google_cloud_run_v2_service" "web_api" {
  # Images are deployed by the pipeline (by digest); Terraform owns everything else.
  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }
  name     = "careloop-web-api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  template {
    service_account = google_service_account.svc["web-api"].email
    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }
    containers {
      image = var.images.web_api
      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.whatsapp_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.whatsapp_phone_number_id == "" ? [] : [1]
        content {
          name = "WHATSAPP_ACCESS_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["whatsapp-access-token"].secret_id
              version = "latest"
            }
          }
        }
      }
      # Provider webhook signing secrets: value lives only in Secret Manager.
      env {
        name = "WEBHOOK_SIGNING_SECRETS"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["webhook-signing-secrets"].secret_id
            version = "latest"
          }
        }
      }
      startup_probe {
        http_get { path = "/api/health" }
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service" "worker" {
  # Images are deployed by the pipeline (by digest); Terraform owns everything else.
  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }
  name     = "careloop-worker"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL" # authenticated: no allUsers invoker binding
  template {
    service_account = google_service_account.svc["worker"].email
    timeout         = "300s"
    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }
    containers {
      image = var.images.worker
      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.whatsapp_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.whatsapp_phone_number_id == "" ? [] : [1]
        content {
          name = "WHATSAPP_ACCESS_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets["whatsapp-access-token"].secret_id
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get { path = "/healthz" }
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service" "voice" {
  # Images are deployed by the pipeline (by digest); Terraform owns everything else.
  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }
  name     = "careloop-voice"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  template {
    service_account                  = google_service_account.svc["voice"].email
    timeout                          = "900s" # must exceed the application session cap (MVP spec §11)
    session_affinity                 = true
    max_instance_request_concurrency = 20
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    containers {
      image = var.images.voice
      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }
      startup_probe {
        http_get { path = "/healthz" }
      }
    }
  }
  depends_on = [google_project_service.apis]
}

# Public staff UI and voice entry points; authorization is enforced in-app.
resource "google_cloud_run_v2_service_iam_member" "public" {
  for_each = { web_api = google_cloud_run_v2_service.web_api.name, voice = google_cloud_run_v2_service.voice.name }
  name     = each.value
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "urls" {
  value = {
    web_api = google_cloud_run_v2_service.web_api.uri
    worker  = google_cloud_run_v2_service.worker.uri
    voice   = google_cloud_run_v2_service.voice.uri
  }
}
