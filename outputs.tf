output "lambda_function_arn" {
  description = "ARN of the CloudTrail forwarder Lambda function"
  value       = aws_lambda_function.cloudtrail_forwarder.arn
}

output "lambda_function_name" {
  description = "Name of the CloudTrail forwarder Lambda function"
  value       = aws_lambda_function.cloudtrail_forwarder.function_name
}

output "lambda_role_arn" {
  description = "ARN of the IAM role used by the Lambda function"
  value       = aws_iam_role.lambda_role.arn
}

output "lambda_role_name" {
  description = "Name of the IAM role used by the Lambda function"
  value       = aws_iam_role.lambda_role.name
}

output "cloudwatch_log_group_name" {
  description = "Name of the CloudWatch Log Group for Lambda logs"
  value       = aws_cloudwatch_log_group.lambda_logs.name
}

output "failed_events_bucket_name" {
  description = "Name of the S3 bucket for failed events (if enabled)"
  value       = var.store_failed_events ? local.failed_events_bucket : null
}

output "failed_events_bucket_arn" {
  description = "ARN of the S3 bucket for failed events (if auto-created)"
  value       = var.store_failed_events && var.failed_events_bucket_name == null ? aws_s3_bucket.failed_events[0].arn : null
}
