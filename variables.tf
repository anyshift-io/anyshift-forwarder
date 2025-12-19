variable "aws_region" {
  description = "AWS region to deploy the Lambda (must match the S3 bucket region)"
  type        = string
}

variable "cloudtrail_bucket_arn" {
  description = "ARN of the CloudTrail S3 bucket"
  type        = string
}

variable "anyshift_base_url" {
  description = "Anyshift backend base URL"
  type        = string
  default     = "https://api.anyshift.io"
}

variable "anyshift_token" {
  description = "JWT token for authenticating with the Anyshift webhook (mutually exclusive with anyshift_token_secret_arn)"
  type        = string
  sensitive   = true
  default     = null
}

variable "anyshift_token_secret_arn" {
  description = "ARN of the Secrets Manager secret containing the Anyshift token (mutually exclusive with anyshift_token)"
  type        = string
  default     = null
}

variable "lambda_memory_size" {
  description = "Memory size for the Lambda function in MB"
  type        = number
  default     = 256
}

variable "lambda_timeout" {
  description = "Timeout for the Lambda function in seconds"
  type        = number
  default     = 120
}

variable "lambda_reserved_concurrency" {
  description = "Reserved concurrent executions for the Lambda function (limits max parallel executions to prevent runaway costs)"
  type        = number
  default     = 10
}

variable "lambda_architecture" {
  description = "Lambda instruction set architecture (arm64 is ~20% cheaper)"
  type        = string
  default     = "arm64"
  validation {
    condition     = contains(["arm64", "x86_64"], var.lambda_architecture)
    error_message = "Architecture must be 'arm64' or 'x86_64'."
  }
}

variable "log_level" {
  description = "Log level for the Lambda function (DEBUG, INFO, WARN, ERROR)"
  type        = string
  default     = "INFO"
  validation {
    condition     = contains(["DEBUG", "INFO", "WARN", "ERROR"], var.log_level)
    error_message = "Log level must be DEBUG, INFO, WARN, or ERROR."
  }
}

variable "use_compression" {
  description = "Enable gzip compression for outgoing webhook requests"
  type        = bool
  default     = true
}

variable "store_failed_events" {
  description = "Store failed events to S3 for later retry"
  type        = bool
  default     = false
}

variable "failed_events_bucket_name" {
  description = "S3 bucket name for storing failed events (auto-created if store_failed_events is true and this is null)"
  type        = string
  default     = null
}

variable "aws_account_id" {
  description = "AWS account ID where the S3 bucket and Lambda are deployed (used for Lambda invoke permission)"
  type        = string
}

variable "kms_key_arn" {
  description = "ARN of the KMS key used to encrypt the CloudTrail bucket (optional, only needed if bucket uses SSE-KMS)"
  type        = string
  default     = null
}

# Lambda Layer (recommended - no local build needed)
variable "lambda_layer_arn" {
  description = "ARN of the public Lambda layer (e.g., arn:aws:lambda:us-east-1:211125758836:layer:anyshift-forwarder:1)"
  type        = string
  default     = null
}

# Advanced: custom S3 deployment (alternative to layer)
variable "lambda_s3_bucket" {
  description = "S3 bucket containing the Lambda zip"
  type        = string
  default     = null
}

variable "lambda_s3_key" {
  description = "S3 key for the Lambda zip file"
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "CloudWatch Log Group retention in days"
  type        = number
  default     = 14
}

variable "tags" {
  description = "Additional tags to apply to resources"
  type        = map(string)
  default     = {}
}
