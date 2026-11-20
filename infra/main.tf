data "google_project" "this" {}

locals {
  # Cloud Run's deterministic URL avoids a self-reference cycle for WORKER_URL.
  worker_url = "https://careloop-worker-${data.google_project.this.number}.${var.region}.run.app"
  web_url    = "https://careloop-web-api-${data.google_project.this.number}.${var.region}.run.app"
  voice_wss  = "wss://careloop-voice-${data.google_project.this.number}.${var.region}.run.app"
  services = [
    "run.googleapis.com",
    "firestore.googleapis.com",
    "cloudtasks.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "aiplatform.googleapis.com",
    "identitytoolkit.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "cloudscheduler.googleapis.com",
  ]
  common_env = {
    APP_ENV                = var.app_env
    APP_REGION             = var.region
    GOOGLE_CLOUD_PROJECT   = var.project_id
    GOOGLE_API_SURFACE     = "vertex"
    GOOGLE_CLOUD_LOCATION  = "global"
    LIVE_MODEL_LOCATION    = "us-central1"
    INTAKE_MODEL_ID        = var.model_ids.intake
    COORDINATION_MODEL_ID  = var.model_ids.coordination
    VERIFICATION_MODEL_ID  = var.model_ids.verification
    LIVE_MODEL_ID          = var.model_ids.live
    BOOKING_ADAPTER        = var.app_env == "pilot" ? "manual" : "sandbox"
    VOICE_ADAPTER          = "browser"
    MESSAGING_ADAPTER      = "simulated"
    OUTREACH_ENABLED       = tostring(var.outreach_enabled)
    MAX_CONTACT_ATTEMPTS   = "2"
    MAX_CASE_AUDIO_SECONDS = "180"
    CLOUD_TASKS_QUEUE      = google_cloud_tasks_queue.jobs.name
    TASK_QUEUE_MODE        = "cloud-tasks"
    TASKS_INVOKER_EMAIL    = google_service_account.svc["tasks-invoker"].email
    WORKER_URL             = local.worker_url
    VOICE_ALLOWED_ORIGINS  = local.web_url
    VOICE_PUBLIC_URL       = local.voice_wss
  }
}

resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  repository_id = "careloop"
  format        = "DOCKER"
  location      = var.region
  depends_on    = [google_project_service.apis]
}

resource "google_firestore_database" "default" {
  name                              = "(default)"
  location_id                       = var.region
  type                              = "FIRESTORE_NATIVE"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = var.app_env == "pilot" ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
  depends_on                        = [google_project_service.apis]
}

# Private source documents: no public access, tenant-prefixed paths, short retention.
resource "google_storage_bucket" "sources" {
  name                        = "${var.project_id}-careloop-sources"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.app_env != "pilot"
  lifecycle_rule {
    condition { age = 7 } # proposal: delete intake originals 7 days after upload (MVP spec §19)
    action { type = "Delete" }
  }
}

resource "google_cloud_tasks_queue" "jobs" {
  name     = "careloop-jobs"
  location = var.region
  retry_config {
    max_attempts  = 3 # infrastructure retries only; patient-contact budget is enforced in the domain
    min_backoff   = "5s"
    max_backoff   = "300s"
    max_doublings = 4
  }
  rate_limits { max_dispatches_per_second = 10 }
  depends_on = [google_project_service.apis]
}

# Secret containers only; values are added out-of-band, never in Terraform state.
resource "google_secret_manager_secret" "secrets" {
  for_each  = toset(["booking-provider-key", "messaging-provider-key", "telephony-provider-key", "webhook-signing-secrets"])
  secret_id = each.value
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.apis]
}

# Recovery sweep (MVP spec §16): re-dispatches undispatched or stuck outbox items.
resource "google_cloud_scheduler_job" "recovery_sweep" {
  name      = "careloop-recovery-sweep"
  region    = var.region
  schedule  = "* * * * *"
  time_zone = "Asia/Kolkata"
  http_target {
    uri         = "${local.worker_url}/tasks/recovery-sweep"
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.svc["tasks-invoker"].email
      audience              = local.worker_url
    }
  }
  depends_on = [google_project_service.apis]
}
