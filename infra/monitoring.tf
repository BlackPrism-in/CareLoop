# Operations (MVP spec §20): uptime checks, log-based alerts to a named
# operator, and daily Firestore backups in addition to point-in-time recovery.

locals {
  alerts_enabled = var.alert_email != ""
}

resource "google_monitoring_notification_channel" "operator" {
  count        = local.alerts_enabled ? 1 : 0
  display_name = "CareLoop on-call operator"
  type         = "email"
  labels       = { email_address = var.alert_email }
}

resource "google_monitoring_uptime_check_config" "health" {
  for_each     = { web = "careloop-web-api-${data.google_project.this.number}.${var.region}.run.app", voice = "careloop-voice-${data.google_project.this.number}.${var.region}.run.app" }
  display_name = "careloop-${each.key}-health"
  timeout      = "10s"
  period       = "300s"
  http_check {
    path         = each.key == "web" ? "/api/health" : "/health" # Cloud Run reserves /healthz publicly
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  monitored_resource {
    type   = "uptime_url"
    labels = { project_id = var.project_id, host = each.value }
  }
}

# Log-based metrics over the services' structured JSON logs.
resource "google_logging_metric" "signals" {
  for_each = {
    job_failed        = "jsonPayload.message=\"job failed permanently\""
    booking_unknown   = "jsonPayload.message=\"booking adapter error treated as UNKNOWN\""
    voice_not_started = "jsonPayload.message=\"voice session not started\""
    webhook_rejected  = "jsonPayload.message=\"webhook signature rejected\""
    unhandled_error   = "jsonPayload.message=\"unhandled error\""
  }
  name   = "careloop/${each.key}"
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=~\"careloop-.*\" AND ${each.value}"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "signals" {
  for_each     = local.alerts_enabled ? google_logging_metric.signals : {}
  display_name = "CareLoop: ${each.key}"
  combiner     = "OR"
  conditions {
    display_name = "${each.key} > 0 in 10 min"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${each.value.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.operator[0].id]
}

resource "google_monitoring_alert_policy" "uptime" {
  count        = local.alerts_enabled ? 1 : 0
  display_name = "CareLoop: service down"
  combiner     = "OR"
  conditions {
    display_name = "Health check failing"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_FRACTION_TRUE"
        cross_series_reducer = "REDUCE_MIN"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.operator[0].id]
}

# Daily backups kept 7 days (proposal; confirm with the customer's retention schedule).
resource "google_firestore_backup_schedule" "daily" {
  database  = google_firestore_database.default.name
  retention = "604800s"
  daily_recurrence {}
}
