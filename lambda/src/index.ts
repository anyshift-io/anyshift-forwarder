import type { Context, S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Logger } from '@aws-lambda-powertools/logger';
import { createGunzip, gzipSync } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable, Writable } from 'stream';

// Initialize Powertools Logger
const logger = new Logger({
  serviceName: 'anyshift-forwarder',
  logLevel: (process.env.LOG_LEVEL || 'INFO') as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
});

const s3Client = new S3Client({});
const secretsClient = new SecretsManagerClient({});

// Configuration from environment
const USE_COMPRESSION = process.env.USE_COMPRESSION !== 'false'; // default true
const STORE_FAILED_EVENTS = process.env.STORE_FAILED_EVENTS === 'true';
const FAILED_EVENTS_BUCKET = process.env.FAILED_EVENTS_BUCKET;
const TOKEN_SECRET_ARN = process.env.ANYSHIFT_TOKEN_SECRET_ARN;

// Cached token (fetched from Secrets Manager on cold start)
let cachedToken: string | null = null;

/**
 * Get token from environment variable or Secrets Manager
 */
const getToken = async (): Promise<string> => {
  // Return cached token if available
  if (cachedToken) {
    return cachedToken;
  }

  // Try direct environment variable first
  const envToken = process.env.ANYSHIFT_TOKEN;
  if (envToken) {
    cachedToken = envToken;
    return cachedToken;
  }

  // Fall back to Secrets Manager
  if (TOKEN_SECRET_ARN) {
    logger.info('Fetching token from Secrets Manager');
    const response = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: TOKEN_SECRET_ARN }),
    );
    if (response.SecretString) {
      cachedToken = response.SecretString;
      return cachedToken;
    }
  }

  throw new Error('No token configured: set ANYSHIFT_TOKEN or ANYSHIFT_TOKEN_SECRET_ARN');
};

// Retry configuration
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

// Chunking configuration
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB max payload size
const MAX_RECORDS_PER_CHUNK = 1000;

interface CloudTrailRecord {
  eventSource: string;
  eventName: string;
  awsRegion: string;
  eventTime: string;
  managementEvent?: boolean;
  requestParameters?: Record<string, unknown>;
  responseElements?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  resources?: Array<{
    accountId: string;
    type: string;
    ARN: string;
  }>;
}

interface CloudTrailLogs {
  Records: CloudTrailRecord[];
}

/**
 * Sleep for a given number of milliseconds
 */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Stream decompress gzip data from S3 - memory efficient for large files
 */
const streamDecompress = async (s3Body: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  const gunzip = createGunzip();

  const collectStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });

  await pipeline(s3Body, gunzip, collectStream);
  return Buffer.concat(chunks).toString('utf-8');
};

/**
 * Split records into chunks that fit within size and count limits
 */
const chunkRecords = (records: CloudTrailRecord[]): CloudTrailRecord[][] => {
  const chunks: CloudTrailRecord[][] = [];
  let currentChunk: CloudTrailRecord[] = [];
  let currentSize = 0;

  for (const record of records) {
    const recordJson = JSON.stringify(record);
    const recordSize = Buffer.byteLength(recordJson, 'utf-8');

    // Start new chunk if adding this record would exceed limits
    if (
      currentChunk.length >= MAX_RECORDS_PER_CHUNK ||
      (currentSize + recordSize > MAX_PAYLOAD_BYTES && currentChunk.length > 0)
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }

    currentChunk.push(record);
    currentSize += recordSize;
  }

  // Push remaining records
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
};

/**
 * Calculate backoff with exponential increase and jitter
 */
const calculateBackoff = (attempt: number): number => {
  const exponentialBackoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
  const cappedBackoff = Math.min(exponentialBackoff, MAX_BACKOFF_MS);
  // Add jitter (0-25% of backoff)
  const jitter = cappedBackoff * Math.random() * 0.25;
  return cappedBackoff + jitter;
};

/**
 * Store failed event to S3 for later retry
 */
const storeFailedEvent = async (
  bucket: string,
  sourceFile: string,
  payload: string,
  error: Error,
): Promise<void> => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `failed-events/${timestamp}/${sourceFile.replace(/\//g, '_')}.json`;

  const failedEvent = {
    timestamp: new Date().toISOString(),
    sourceFile,
    error: error.message,
    payload: JSON.parse(payload),
  };

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(failedEvent, null, 2),
      ContentType: 'application/json',
    }),
  );

  logger.info('Stored failed event', { bucket, key: `s3://${bucket}/${key}` });
};

/**
 * Send payload to webhook with retries and exponential backoff
 */
const sendWithRetry = async (
  webhookUrl: string,
  token: string,
  payload: string,
  sourceFile: string,
  chunkIndex?: number,
  totalChunks?: number,
): Promise<void> => {
  let lastError: Error | null = null;

  // Compress payload if enabled
  let body: Buffer | string = payload;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Source-File': sourceFile,
  };

  if (USE_COMPRESSION) {
    body = gzipSync(payload);
    headers['Content-Encoding'] = 'gzip';
    logger.debug('Compressed payload', {
      originalSize: payload.length,
      compressedSize: body.length,
    });
  }

  // Add chunk headers if chunking
  if (chunkIndex !== undefined && totalChunks !== undefined) {
    headers['X-Chunk-Index'] = String(chunkIndex);
    headers['X-Total-Chunks'] = String(totalChunks);
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body,
      });

      // Retry on any non-2xx response
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // Success
      const responseBody = await response.json();
      logger.debug('Webhook succeeded', { attempt: attempt + 1, response: responseBody });
      return;
    } catch (error) {
      lastError = error as Error;

      // Last attempt - don't wait, just throw
      if (attempt === MAX_RETRIES - 1) {
        logger.error('All retry attempts failed', {
          maxRetries: MAX_RETRIES,
          error: lastError.message,
        });
        break;
      }

      const backoffMs = calculateBackoff(attempt);
      logger.warn('Retry attempt failed', {
        attempt: attempt + 1,
        error: lastError.message,
        backoffMs: Math.round(backoffMs),
      });
      await sleep(backoffMs);
    }
  }

  // Store failed event if enabled
  if (STORE_FAILED_EVENTS && FAILED_EVENTS_BUCKET && lastError) {
    try {
      await storeFailedEvent(FAILED_EVENTS_BUCKET, sourceFile, payload, lastError);
    } catch (storeError) {
      logger.error('Failed to store failed event', { error: storeError });
    }
  }

  throw lastError || new Error('All retry attempts failed');
};

// Webhook path appended to base URL
const WEBHOOK_PATH = '/api/cloudtrail/webhook';

export const handler = async (event: S3Event, context: Context): Promise<void> => {
  // Add Lambda context to all logs (request ID, cold start, etc.)
  logger.addContext(context);

  const baseUrl = process.env.ANYSHIFT_BASE_URL;

  if (!baseUrl) {
    logger.error('Missing required environment variable: ANYSHIFT_BASE_URL');
    throw new Error('Missing required environment variable: ANYSHIFT_BASE_URL');
  }

  // Get token (from env var or Secrets Manager)
  const token = await getToken();

  // Construct webhook URL from base URL (remove trailing slash if present)
  const webhookUrl = baseUrl.replace(/\/$/, '') + WEBHOOK_PATH;

  logger.info('Processing S3 events', { eventCount: event.Records.length });
  logger.debug('Configuration', { webhookUrl, compression: USE_COMPRESSION });

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Skip digest files
    if (key.includes('CloudTrail-Digest')) {
      logger.debug('Skipping digest file', { key });
      continue;
    }

    // Skip non-CloudTrail files
    if (!key.endsWith('.json.gz')) {
      logger.debug('Skipping non-gzip file', { key });
      continue;
    }

    logger.info('Processing file', { bucket, key });

    // Download from S3
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

    if (!response.Body) {
      logger.error('Empty file', { key });
      continue;
    }

    // Stream decompress gzip - memory efficient for large files
    const decompressed = await streamDecompress(response.Body as Readable);
    const cloudTrailLogs: CloudTrailLogs = JSON.parse(decompressed);

    if (!cloudTrailLogs.Records || cloudTrailLogs.Records.length === 0) {
      logger.debug('No records in file', { key });
      continue;
    }

    // Filter: only successful management events (infrastructure changes)
    // - managementEvent: true = control plane operations
    //   - ECS: CreateService, DeleteCluster, RegisterTaskDefinition, etc.
    //   - EC2: RunInstances, TerminateInstances, CreateVpc, DeleteSubnet, etc.
    // - managementEvent: false = data plane (S3 GetObject, Lambda Invoke, etc.)
    // Note: Some CloudTrail files omit managementEvent field entirely,
    // so we use !== false instead of === true to include those events
    const relevantEvents = cloudTrailLogs.Records.filter(
      r => !r.errorCode && r.managementEvent !== false,
    );

    const skippedCount = cloudTrailLogs.Records.length - relevantEvents.length;
    if (relevantEvents.length === 0) {
      logger.debug('No relevant management events in file', { key, skippedCount });
      continue;
    }

    logger.info('Found management events', { eventCount: relevantEvents.length, skippedCount });

    // Chunk records if needed to stay under size/count limits
    const chunks = chunkRecords(relevantEvents);

    if (chunks.length > 1) {
      logger.info('Splitting events into chunks', {
        eventCount: relevantEvents.length,
        chunkCount: chunks.length,
      });
    }

    // POST each chunk to Anyshift backend with retries
    for (const [i, chunk] of chunks.entries()) {
      const payload = JSON.stringify({ Records: chunk });

      await sendWithRetry(
        webhookUrl,
        token,
        payload,
        key,
        chunks.length > 1 ? i : undefined,
        chunks.length > 1 ? chunks.length : undefined,
      );

      logger.info('Forwarded chunk', {
        chunkIndex: i + 1,
        totalChunks: chunks.length,
        eventCount: chunk.length,
      });
    }

    logger.info('Successfully forwarded events', {
      eventCount: relevantEvents.length,
      sourceFile: key,
    });
  }
};
