# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Lambda (in `lambda/` directory)

- `npm install` - Install dependencies
- `npm test` - Run full test suite (format, lint, typecheck)
- `npm run build` - Build Lambda with esbuild
- `npm run package` - Build and create lambda.zip for deployment
- `npm run lint` / `npm run lint-fix` - Run ESLint with optional auto-fix
- `npm run format` / `npm run format-fix` - Check/fix Prettier formatting
- `npm run typecheck` - Run TypeScript type checking

### Terraform (in root directory)

- `terraform init` - Initialize Terraform
- `terraform plan` - Preview changes
- `terraform apply` - Apply changes

## Architecture Overview

### Tech Stack

- **TypeScript** with Node.js 20 runtime
- **AWS Lambda** for serverless execution
- **AWS Lambda Powertools** for structured logging
- **Terraform** for infrastructure as code
- **esbuild** for bundling

### Project Structure

```
.
├── lambda/
│   ├── src/
│   │   └── index.ts      # Lambda handler
│   ├── package.json
│   ├── tsconfig.json
│   └── eslint.config.js
├── main.tf               # Lambda, IAM, S3 notification resources
├── variables.tf          # Input variables
├── outputs.tf            # Module outputs
└── providers.tf          # AWS provider config
```

### How It Works

1. CloudTrail writes logs to S3 bucket (gzipped JSON)
2. S3 event notification triggers Lambda on new objects
3. Lambda downloads, decompresses, and filters CloudTrail events
4. Management events are forwarded to Anyshift backend
5. Failed events are optionally stored to S3 for retry

### Key Patterns

#### Event Filtering

- **Skipped**: Digest files, non-gzip files
- **Filtered out**: Failed API calls (errorCode), Data events (managementEvent: false)
- **Forwarded**: Management events only (infrastructure changes)

#### Retry Logic

- 5 retries with exponential backoff (1s → 2s → 4s → 8s → 16s)
- Jitter added to prevent thundering herd
- Max backoff capped at 30 seconds

#### Payload Chunking

- 5MB max payload size per request
- 1000 max records per request
- Chunk headers added when splitting

### Code Quality Standards

- ESLint with TypeScript strict rules
- Prettier for formatting (runs on pre-commit hook)
- Conventional commits enforced with commitlint
- No `any` types allowed - explicit typing required
- TypeScript strict mode with `noUncheckedIndexedAccess`

## Important Notes

- This is a client-facing module - keep it simple and well-documented
- Always run the full test suite (`npm test`) before committing
- Follow existing patterns for consistency
- Use TypeScript strictly - no `any` types
- Prefer editing existing files over creating new ones
- The Lambda uses ARM64 architecture for cost savings (~20% cheaper)
