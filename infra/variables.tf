variable "project_id" {
  type        = string
  description = "Separate GCP project per environment (demo/staging vs pilot)."
}

variable "app_env" {
  type = string
  validation {
    condition     = contains(["demo", "staging", "pilot"], var.app_env)
    error_message = "app_env must be demo, staging or pilot."
  }
}

variable "region" {
  type        = string
  default     = "asia-south1"
  description = "Application region. Regional storage is a design setting, not a data-residency claim (Blueprint p.8)."
}

variable "images" {
  type        = object({ web_api = string, worker = string, voice = string })
  description = "Image digests (not tags) from Artifact Registry."
  default = {
    web_api = "us-docker.pkg.dev/cloudrun/container/hello"
    worker  = "us-docker.pkg.dev/cloudrun/container/hello"
    voice   = "us-docker.pkg.dev/cloudrun/container/hello"
  }
}

variable "model_ids" {
  type        = object({ intake = string, coordination = string, verification = string, live = string })
  description = "Verified with `pnpm check:models` before apply."
}

variable "outreach_enabled" {
  type    = bool
  default = false
  validation {
    condition     = var.outreach_enabled == false || var.app_env == "pilot"
    error_message = "Outreach may only be enabled in the pilot environment."
  }
}

variable "alert_email" {
  type        = string
  default     = ""
  description = "Named on-call operator for alerts (MVP spec §20: never an unmonitored inbox). Empty disables alerting."
}

variable "enabled_languages" {
  description = "Comma-separated case/contact languages. Add bn-IN only after a supervised Bengali review."
  type        = string
  default     = "hi-IN,en-IN"
  validation {
    condition     = alltrue([for l in split(",", var.enabled_languages) : contains(["hi-IN", "en-IN", "bn-IN"], trimspace(l))])
    error_message = "enabled_languages may contain only hi-IN, en-IN and bn-IN."
  }
}

variable "whatsapp_phone_number_id" {
  description = "Meta WhatsApp Cloud API phone number ID. Empty keeps messaging simulated. The access token goes in Secret Manager \"whatsapp-access-token\"."
  type        = string
  default     = ""
}

variable "whatsapp_test_recipients" {
  description = "Outside the pilot, WhatsApp is sent only to these E.164 numbers (comma-separated): testers' own phones."
  type        = string
  default     = ""
}

variable "patient_app_url" {
  description = "Link in the WhatsApp invite where patients get the app. Empty: <web URL>/app."
  type        = string
  default     = ""
}
