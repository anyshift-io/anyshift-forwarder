# Anyshift CloudTrail Forwarder Lambda Module
# This module creates a Lambda function that forwards CloudTrail logs from S3 to Anyshift backend

locals {
  # Extract bucket name from ARN: arn:aws:s3:::bucket-name -> bucket-name
  bucket_name   = element(split(":", var.cloudtrail_bucket_arn), 5)
  function_name = "anyshift-cloudtrail-forwarder"

  # Failed events bucket name (auto-generate if not provided)
  failed_events_bucket = var.store_failed_events ? (
    var.failed_events_bucket_name != null ? var.failed_events_bucket_name : "${local.function_name}-failed-events-${var.aws_account_id}"
  ) : null

  common_tags = merge(var.tags, {
    Module    = "cloudtrail-s3-lambda"
    ManagedBy = "terraform"
  })
}

# IAM Role for Lambda
resource "aws_iam_role" "lambda_role" {
  name = local.function_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })

  tags = local.common_tags
}

# S3 read permission - all CloudTrail logs (supports multi-account org trails)
resource "aws_iam_role_policy" "lambda_s3_policy" {
  name = "s3-read-cloudtrail"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "${var.cloudtrail_bucket_arn}/AWSLogs/*/CloudTrail/*"
    }]
  })
}

# KMS decrypt permission (optional - only if bucket uses SSE-KMS)
resource "aws_iam_role_policy" "lambda_kms_policy" {
  count = var.kms_key_arn != null ? 1 : 0

  name = "kms-decrypt-cloudtrail"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt"]
      Resource = var.kms_key_arn
    }]
  })
}

# CloudWatch Logs permission
resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Secrets Manager permission (only if using Secrets Manager for token)
resource "aws_iam_role_policy" "lambda_secrets_policy" {
  count = var.anyshift_token_secret_arn != null ? 1 : 0

  name = "secrets-manager-read"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = var.anyshift_token_secret_arn
    }]
  })
}

# Failed events S3 bucket (auto-created if store_failed_events is true)
resource "aws_s3_bucket" "failed_events" {
  count  = var.store_failed_events && var.failed_events_bucket_name == null ? 1 : 0
  bucket = local.failed_events_bucket

  tags = local.common_tags
}

resource "aws_s3_bucket_lifecycle_configuration" "failed_events" {
  count  = var.store_failed_events && var.failed_events_bucket_name == null ? 1 : 0
  bucket = aws_s3_bucket.failed_events[0].id

  rule {
    id     = "expire-old-failed-events"
    status = "Enabled"

    expiration {
      days = 30
    }

    filter {
      prefix = "failed-events/"
    }
  }
}

# Failed events bucket write permission
resource "aws_iam_role_policy" "lambda_failed_events_policy" {
  count = var.store_failed_events ? 1 : 0

  name = "s3-write-failed-events"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject"]
      Resource = "arn:aws:s3:::${local.failed_events_bucket}/failed-events/*"
    }]
  })
}

# Lambda function
resource "aws_lambda_function" "cloudtrail_forwarder" {
  # Use layer if provided, otherwise use zip deployment
  filename         = var.lambda_layer_arn == null ? "${path.module}/lambda/lambda.zip" : null
  source_code_hash = var.lambda_layer_arn == null ? filebase64sha256("${path.module}/lambda/lambda.zip") : null
  layers           = var.lambda_layer_arn != null ? [var.lambda_layer_arn] : []

  function_name = local.function_name
  role          = aws_iam_role.lambda_role.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = var.lambda_timeout
  memory_size   = var.lambda_memory_size

  # ARM64 architecture is ~20% cheaper than x86_64
  architectures = [var.lambda_architecture]

  # Concurrency guard to prevent runaway costs on burst
  reserved_concurrent_executions = var.lambda_reserved_concurrency

  environment {
    variables = merge(
      {
        ANYSHIFT_BASE_URL = var.anyshift_base_url
        LOG_LEVEL         = var.log_level
        USE_COMPRESSION   = tostring(var.use_compression)
      },
      # Token: either direct or via Secrets Manager
      var.anyshift_token != null ? { ANYSHIFT_TOKEN = var.anyshift_token } : {},
      var.anyshift_token_secret_arn != null ? { ANYSHIFT_TOKEN_SECRET_ARN = var.anyshift_token_secret_arn } : {},
      # Failed events configuration
      var.store_failed_events ? {
        STORE_FAILED_EVENTS = "true"
        FAILED_EVENTS_BUCKET = local.failed_events_bucket
      } : {}
    )
  }

  tags = local.common_tags

  depends_on = [
    aws_iam_role_policy_attachment.lambda_logs,
    aws_cloudwatch_log_group.lambda_logs
  ]
}

# Lambda permission for S3 to invoke (with source_account for defense-in-depth)
resource "aws_lambda_permission" "s3_invoke" {
  statement_id   = "AllowS3Invoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.cloudtrail_forwarder.function_name
  principal      = "s3.amazonaws.com"
  source_arn     = var.cloudtrail_bucket_arn
  source_account = var.aws_account_id
}

# S3 bucket notification - all CloudTrail logs (supports multi-account org trails)
resource "aws_s3_bucket_notification" "cloudtrail_notification" {
  bucket = local.bucket_name

  lambda_function {
    lambda_function_arn = aws_lambda_function.cloudtrail_forwarder.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "AWSLogs/"
    filter_suffix       = ".json.gz"
  }

  depends_on = [aws_lambda_permission.s3_invoke]
}

# CloudWatch Log Group for Lambda
resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days

  tags = local.common_tags
}
