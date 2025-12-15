# Anyshift CloudTrail S3 Lambda Module

This Terraform module creates a Lambda function that forwards CloudTrail logs from an S3 bucket to the Anyshift backend for real-time infrastructure tracking.

## Architecture

```
CloudTrail → S3 bucket → S3 Event Notification → Lambda → Anyshift Backend
                                                           │
                                                           ▼
                                                   aws-api-extractor
                                                           │
                                                           ▼
                                                   graph-connector → Neo4j
```

## Prerequisites

1. CloudTrail must be configured to deliver logs to an S3 bucket
2. You need an Anyshift JWT token (generated from the Anyshift dashboard)
3. Lambda code must be built before applying Terraform

## Secrets Management

The `anyshift_token` is a sensitive JWT token that should **never be committed to version control**. Use one of these approaches:

### Option 1: Environment Variable (Simplest)

```bash
export TF_VAR_anyshift_token="your-jwt-token"
terraform apply
```

### Option 2: AWS Secrets Manager (Recommended for Production)

First, store your token in AWS Secrets Manager:

```bash
aws secretsmanager create-secret \
  --name "anyshift/token" \
  --secret-string "your-jwt-token"
```

Then reference it in your Terraform using the native integration (Lambda fetches at runtime):

```hcl
module "cloudtrail_forwarder" {
  source                    = "./cloudtrail-s3-lambda"
  anyshift_token_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:anyshift/token-AbCdEf"
  # ... other variables
}
```

Or fetch in Terraform (token visible in state file):

```hcl
data "aws_secretsmanager_secret_version" "anyshift" {
  secret_id = "anyshift/token"
}

module "cloudtrail_forwarder" {
  source         = "./cloudtrail-s3-lambda"
  anyshift_token = data.aws_secretsmanager_secret_version.anyshift.secret_string
  # ... other variables
}
```

### Option 3: Terraform Variables File (gitignored)

Create a `terraform.tfvars` file:

```hcl
anyshift_token = "your-jwt-token"
```

**Important:** Add `*.tfvars` to your `.gitignore`:

```bash
echo "*.tfvars" >> .gitignore
```

### Option 4: Terraform Cloud/Enterprise

Set `anyshift_token` as a **sensitive variable** in your workspace settings. The value will be encrypted and masked in logs.

> ⚠️ **Warning:** Never hardcode the token directly in your Terraform files or commit it to Git.

## Building the Lambda

```bash
cd lambda
npm install
npm run package
```

This creates `lambda.zip` which Terraform will deploy.

## Usage

### Basic Usage

```hcl
module "cloudtrail_forwarder" {
  source = "./cloudtrail-s3-lambda"

  aws_region            = "us-east-1"
  aws_account_id        = "123456789012"
  cloudtrail_bucket_arn = "arn:aws:s3:::my-cloudtrail-logs-bucket"
  anyshift_token        = var.anyshift_token  # JWT from Anyshift dashboard

  tags = {
    Team = "platform"
  }
}
```

### Production Configuration

```hcl
module "cloudtrail_forwarder" {
  source = "./cloudtrail-s3-lambda"

  aws_region            = "us-east-1"
  aws_account_id        = "123456789012"
  cloudtrail_bucket_arn = "arn:aws:s3:::my-cloudtrail-logs-bucket"

  # Use Secrets Manager for token (recommended)
  anyshift_token_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:anyshift/token-AbCdEf"

  # Performance & cost optimization
  lambda_architecture = "arm64"  # ~20% cheaper than x86_64
  use_compression     = true     # Reduces payload size

  # Reliability
  store_failed_events = true     # Store failed events to S3 for retry
  log_level           = "INFO"   # DEBUG for troubleshooting

  # KMS encryption (if bucket uses SSE-KMS)
  # kms_key_arn = "arn:aws:kms:us-east-1:123456789012:key/..."

  tags = {
    Team        = "platform"
    Environment = "prod"
  }
}
```

## Inputs

### Required

| Name | Description | Type |
|------|-------------|------|
| aws_region | AWS region for deployment | `string` |
| aws_account_id | AWS account ID where resources are deployed | `string` |
| cloudtrail_bucket_arn | ARN of the CloudTrail S3 bucket | `string` |

### Authentication (one required)

| Name | Description | Type | Default |
|------|-------------|------|---------|
| anyshift_token | JWT token (mutually exclusive with secret ARN) | `string` | `null` |
| anyshift_token_secret_arn | Secrets Manager ARN for token (recommended) | `string` | `null` |

### Optional

| Name | Description | Type | Default |
|------|-------------|------|---------|
| anyshift_base_url | Anyshift backend base URL | `string` | `https://api.anyshift.io` |
| lambda_architecture | CPU architecture (`arm64` or `x86_64`) | `string` | `arm64` |
| lambda_memory_size | Memory size in MB | `number` | `256` |
| lambda_timeout | Timeout in seconds | `number` | `120` |
| lambda_reserved_concurrency | Max concurrent executions | `number` | `10` |
| lambda_layer_arn | Custom Lambda layer ARN (optional) | `string` | `null` |
| log_level | Log level (DEBUG, INFO, WARN, ERROR) | `string` | `INFO` |
| log_retention_days | CloudWatch log retention | `number` | `14` |
| use_compression | Enable gzip compression for requests | `bool` | `true` |
| store_failed_events | Store failed events to S3 | `bool` | `false` |
| failed_events_bucket_name | Custom bucket for failed events | `string` | `null` (auto-created) |
| kms_key_arn | KMS key ARN for encrypted buckets | `string` | `null` |
| tags | Additional resource tags | `map(string)` | `{}` |

## Outputs

| Name | Description |
|------|-------------|
| lambda_function_arn | ARN of the Lambda function |
| lambda_function_name | Name of the Lambda function |
| lambda_role_arn | ARN of the Lambda IAM role |
| lambda_role_name | Name of the Lambda IAM role |
| cloudwatch_log_group_name | CloudWatch Log Group name |
| failed_events_bucket_name | S3 bucket for failed events (if enabled) |
| failed_events_bucket_arn | ARN of failed events bucket (if auto-created) |

## S3 Path Structure

CloudTrail logs are organized by account and region:
```
s3://{bucket}/AWSLogs/{account_id}/CloudTrail/{region}/YYYY/MM/DD/{file}.json.gz
```

The module listens to `AWSLogs/` prefix and supports **multi-account organization trails** - logs from all member accounts in an org trail bucket will be processed.

## KMS Encryption

If your CloudTrail bucket uses SSE-KMS encryption, provide the `kms_key_arn` variable:

```hcl
kms_key_arn = "arn:aws:kms:us-east-1:123456789012:key/..."
```

This grants the Lambda `kms:Decrypt` permission on the key. If not provided, no KMS permissions are created (for SSE-S3 or unencrypted buckets).

## Compression

When `use_compression = true` (default), the Lambda compresses outgoing payloads with gzip:
- Reduces network transfer size significantly
- Your backend must accept `Content-Encoding: gzip` header
- Disable with `use_compression = false` if your backend doesn't support it

## Failed Event Storage

When `store_failed_events = true`, events that fail to forward after all retries are stored in S3:

```
s3://{failed-events-bucket}/failed-events/{timestamp}/{source-file}.json
```

Each failed event file contains:
- Original CloudTrail records
- Error message
- Source file path
- Timestamp

Failed events are automatically expired after 30 days. You can implement a retry mechanism by:
1. Processing files from the failed-events bucket
2. Re-sending to your backend
3. Deleting successfully processed files

## Retry Mechanism

The Lambda implements robust retry logic:
- **5 retries** with exponential backoff (1s → 2s → 4s → 8s → 16s)
- **Jitter** added to prevent thundering herd
- **Max backoff** capped at 30 seconds
- All non-2xx responses trigger retries (including 404 for backend restarts)

## Filtering

The Lambda filters:
- Digest files (`CloudTrail-Digest`) - skipped
- Non-gzip files - skipped
- Failed API calls (events with `errorCode`) - filtered out
- Data events (`managementEvent: false`) - filtered out (only management events forwarded)

**Management events** = Infrastructure changes (CreateService, DeleteCluster, RunTask, etc.)
**Data events** = High-volume operations (S3 GetObject, Lambda Invoke, etc.) - not relevant for infrastructure tracking

## Payload Chunking

Large CloudTrail files are automatically split into chunks:
- **5MB** max payload size per request
- **1000** max records per request

Chunk headers (`X-Chunk-Index`, `X-Total-Chunks`) are added when chunking occurs.

## Concurrency Guard

The `lambda_reserved_concurrency` variable limits max concurrent Lambda executions (default: 10). This prevents runaway costs during CloudTrail burst scenarios while ensuring reasonable throughput.

## Lambda Layers

For easier updates without redeploying the entire module, you can use Lambda Layers:

```hcl
lambda_layer_arn = "arn:aws:lambda:us-east-1:123456789012:layer:anyshift-forwarder:1"
```

When a layer ARN is provided, the module uses the layer instead of the zip deployment.

## Monitoring

Lambda logs are available in CloudWatch at `/aws/lambda/anyshift-cloudtrail-forwarder` with configurable retention (default: 14 days).

### Log Levels

| Level | Description |
|-------|-------------|
| `DEBUG` | Verbose output including payload sizes, skipped files |
| `INFO` | Standard operation logs (default) |
| `WARN` | Retry attempts and recoverable issues |
| `ERROR` | Failed operations only |

Set `log_level = "DEBUG"` temporarily for troubleshooting.
