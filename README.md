# Anyshift Forwarder

A Terraform module that deploys a Lambda function to forward AWS CloudTrail events to [Anyshift](https://anyshift.io) for real-time infrastructure visibility.

## How It Works

```
CloudTrail → S3 Bucket → S3 Event Notification → Lambda → Anyshift
```

1. CloudTrail writes logs to your S3 bucket
2. S3 triggers the Lambda on new objects
3. Lambda filters and forwards management events to Anyshift

## Quick Start

```hcl
module "anyshift_forwarder" {
  source = "github.com/anyshift-io/anyshift-forwarder"

  aws_region            = "us-east-1"
  aws_account_id        = "123456789012"
  cloudtrail_bucket_arn = "arn:aws:s3:::my-cloudtrail-bucket"
  anyshift_token        = var.anyshift_token

  # Use pre-built Lambda layer (no local build needed)
  lambda_layer_arn = "arn:aws:lambda:us-east-1:211125758836:layer:anyshift-forwarder:2"
}
```

That's it. No local build required.

## Authentication

Store your Anyshift token securely using one of these methods:

### Environment Variable

```bash
export TF_VAR_anyshift_token="your-token"
terraform apply
```

### AWS Secrets Manager (recommended)

```bash
aws secretsmanager create-secret \
  --name "anyshift/token" \
  --secret-string "your-token"
```

```hcl
module "anyshift_forwarder" {
  source = "github.com/anyshift-io/anyshift-forwarder"

  anyshift_token_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:anyshift/token-AbCdEf"
  # ... other config
}
```

## Configuration

### Required Variables

| Name | Description |
|------|-------------|
| `aws_region` | AWS region |
| `aws_account_id` | AWS account ID |
| `cloudtrail_bucket_arn` | ARN of your CloudTrail S3 bucket |

### Authentication (one required)

| Name | Description |
|------|-------------|
| `anyshift_token` | JWT token from Anyshift dashboard |
| `anyshift_token_secret_arn` | Secrets Manager ARN containing the token |

### Optional Variables

| Name | Description | Default |
|------|-------------|---------|
| `lambda_layer_arn` | Pre-built Lambda layer ARN (recommended) | `null` |
| `lambda_architecture` | `arm64` or `x86_64` | `arm64` |
| `lambda_memory_size` | Memory in MB | `256` |
| `lambda_timeout` | Timeout in seconds | `120` |
| `lambda_reserved_concurrency` | Max concurrent executions | `10` |
| `kms_key_arn` | KMS key ARN (if bucket uses SSE-KMS) | `null` |
| `use_compression` | Gzip compress payloads | `true` |
| `store_failed_events` | Store failed events to S3 | `false` |
| `log_level` | `DEBUG`, `INFO`, `WARN`, `ERROR` | `INFO` |
| `log_retention_days` | CloudWatch log retention | `14` |

## Features

### Event Filtering

Only management events (infrastructure changes) are forwarded:
- **Forwarded**: CreateService, DeleteCluster, RunInstances, etc.
- **Filtered out**: Data events (S3 GetObject, Lambda Invoke), failed API calls

### Multi-Account Support

Supports AWS Organization trails - logs from all member accounts are processed.

### KMS Encryption

If your CloudTrail bucket uses SSE-KMS:

```hcl
kms_key_arn = "arn:aws:kms:us-east-1:123456789012:key/..."
```

### Failed Event Storage

Enable `store_failed_events = true` to save events that fail after retries:

```
s3://{bucket}/failed-events/{timestamp}/{source-file}.json
```

Events auto-expire after 30 days.

### Retry Logic

- 5 retries with exponential backoff
- Jitter to prevent thundering herd
- Max 30 second backoff

## Outputs

| Name | Description |
|------|-------------|
| `lambda_function_arn` | Lambda function ARN |
| `lambda_function_name` | Lambda function name |
| `lambda_role_arn` | IAM role ARN |
| `cloudwatch_log_group_name` | CloudWatch log group |

## Lambda Layers

Pre-built layers are published to all major AWS regions:

```
arn:aws:lambda:{region}:211125758836:layer:anyshift-forwarder:{version}
```

**Available regions:** us-east-1, us-east-2, us-west-1, us-west-2, eu-west-1, eu-west-2, eu-west-3, eu-central-1, eu-north-1, ap-northeast-1, ap-northeast-2, ap-southeast-1, ap-southeast-2, ap-south-1, sa-east-1, ca-central-1

See [releases](https://github.com/anyshift-io/anyshift-forwarder/releases) for the latest version.

## Development

```bash
cd lambda
npm install
npm test          # lint, format, typecheck
npm run build     # build with esbuild
npm run package   # create lambda.zip
```

## License

MIT
