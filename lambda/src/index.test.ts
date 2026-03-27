import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { GetObjectCommandOutput } from '@aws-sdk/client-s3';
import type { S3Event, Context } from 'aws-lambda';
import { gzipSync, gunzipSync } from 'zlib';
import { Readable } from 'stream';
import { handler } from './index.js';

const s3Mock = mockClient(S3Client);
const secretsMock = mockClient(SecretsManagerClient);

// Typed fetch mock
const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>();

const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'anyshift-forwarder',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:anyshift-forwarder',
  memoryLimitInMB: '256',
  awsRequestId: 'test-request-id',
  logGroupName: '/aws/lambda/anyshift-forwarder',
  logStreamName: '2024/01/01/[$LATEST]test',
  getRemainingTimeInMillis: () => 30000,
  done: vi.fn(),
  fail: vi.fn(),
  succeed: vi.fn(),
};

const makeS3Event = (key: string, bucket = 'test-cloudtrail-bucket'): S3Event => ({
  Records: [
    {
      eventVersion: '2.1',
      eventSource: 'aws:s3',
      awsRegion: 'us-east-1',
      eventTime: '2024-01-01T00:00:00.000Z',
      eventName: 'ObjectCreated:Put',
      userIdentity: { principalId: 'EXAMPLE' },
      requestParameters: { sourceIPAddress: '1.2.3.4' },
      responseElements: { 'x-amz-request-id': 'test', 'x-amz-id-2': 'test' },
      s3: {
        s3SchemaVersion: '1.0',
        configurationId: 'test',
        bucket: {
          name: bucket,
          ownerIdentity: { principalId: 'EXAMPLE' },
          arn: `arn:aws:s3:::${bucket}`,
        },
        object: {
          key,
          size: 1024,
          eTag: 'abc123',
          sequencer: '0A1B2C3D4E5F678901',
        },
      },
    },
  ],
});

const makeGzipBody = (records: Record<string, unknown>[]): GetObjectCommandOutput['Body'] =>
  Readable.from(
    gzipSync(JSON.stringify({ Records: records })),
  ) as unknown as GetObjectCommandOutput['Body'];

const managementEvent: Record<string, unknown> = {
  eventSource: 'ec2.amazonaws.com',
  eventName: 'RunInstances',
  awsRegion: 'us-east-1',
  eventTime: '2024-01-01T00:00:00Z',
  managementEvent: true,
};

const CLOUDTRAIL_KEY = 'AWSLogs/123456789/CloudTrail/us-east-1/2024/01/01/test.json.gz';

const okResponse = (): Promise<Response> =>
  Promise.resolve({ ok: true, json: async () => ({ status: 'ok' }) } as Response);

beforeAll(() => {
  process.env.ANYSHIFT_BASE_URL = 'https://test.anyshift.io';
  process.env.ANYSHIFT_TOKEN = 'test-jwt-token';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(okResponse);
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.ANYSHIFT_BASE_URL;
  delete process.env.ANYSHIFT_TOKEN;
  s3Mock.restore();
  secretsMock.restore();
});

afterEach(() => {
  s3Mock.reset();
  secretsMock.reset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(okResponse);
});

describe('handler validation', () => {
  it('throws when ANYSHIFT_BASE_URL is missing', async () => {
    const saved = process.env.ANYSHIFT_BASE_URL;
    delete process.env.ANYSHIFT_BASE_URL;
    await expect(handler(makeS3Event(CLOUDTRAIL_KEY), mockContext)).rejects.toThrow(
      'Missing required environment variable: ANYSHIFT_BASE_URL',
    );
    process.env.ANYSHIFT_BASE_URL = saved;
  });
});

describe('file filtering', () => {
  it('skips CloudTrail digest files', async () => {
    await handler(
      makeS3Event('AWSLogs/123/CloudTrail-Digest/us-east-1/digest.json.gz'),
      mockContext,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips non-gzip files', async () => {
    await handler(makeS3Event('AWSLogs/123/CloudTrail/us-east-1/test.json'), mockContext);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips files with empty S3 body', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: undefined });
    await handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips files with no CloudTrail records', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody([]) });
    await handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('decodes percent-encoded plus signs in S3 keys', async () => {
    const encodedKey = 'AWSLogs/123/CloudTrail/us-east-1/2024/test+file.json.gz';
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody([managementEvent]) });
    await handler(makeS3Event(encodedKey), mockContext);
    expect(s3Mock).toHaveReceivedCommandWith(GetObjectCommand, {
      Key: 'AWSLogs/123/CloudTrail/us-east-1/2024/test file.json.gz',
    });
  });
});

describe('event filtering', () => {
  it('skips data plane events (managementEvent: false)', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeGzipBody([{ ...managementEvent, managementEvent: false }]),
    });
    await handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips events with errorCode', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeGzipBody([{ ...managementEvent, errorCode: 'AccessDenied' }]),
    });
    await handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes events where managementEvent field is absent', async () => {
    const eventWithoutField: Record<string, unknown> = {
      eventSource: 'iam.amazonaws.com',
      eventName: 'CreateRole',
      awsRegion: 'us-east-1',
      eventTime: '2024-01-01T00:00:00Z',
    };
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody([eventWithoutField]) });
    await handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('forwards only management events from a mixed set', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: makeGzipBody([
        managementEvent,
        { ...managementEvent, managementEvent: false, eventName: 'GetObject' },
        { ...managementEvent, errorCode: 'AccessDenied', eventName: 'RunInstances' },
      ]),
    });
    await handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    expect(fetchMock).toHaveBeenCalledOnce();

    const lastArgs = fetchMock.mock.calls.at(-1);
    expect(lastArgs).toBeDefined();
    const body = (lastArgs as [string, RequestInit])[1].body;
    expect(body).toBeInstanceOf(Buffer);
    const payload = JSON.parse(gunzipSync(body as Buffer).toString()) as {
      Records: unknown[];
    };
    expect(payload.Records).toHaveLength(1);
    expect(payload.Records[0]).toMatchObject({ eventName: 'RunInstances' });
  });
});

describe('event forwarding', () => {
  it('POSTs to the correct webhook URL', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody([managementEvent]) });
    await handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://test.anyshift.io/api/cloudtrail/webhook',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('strips trailing slash from ANYSHIFT_BASE_URL', async () => {
    const saved = process.env.ANYSHIFT_BASE_URL;
    process.env.ANYSHIFT_BASE_URL = 'https://test.anyshift.io/';
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody([managementEvent]) });
    await handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://test.anyshift.io/api/cloudtrail/webhook',
      expect.anything(),
    );
    process.env.ANYSHIFT_BASE_URL = saved;
  });

  it('sends Authorization header with token', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody([managementEvent]) });
    await handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-jwt-token' }),
      }),
    );
  });

  it('includes X-Source-File header matching the S3 key', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody([managementEvent]) });
    await handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Source-File': CLOUDTRAIL_KEY }),
      }),
    );
  });

  it('compresses the payload with gzip by default', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody([managementEvent]) });
    await handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Encoding': 'gzip' }),
      }),
    );
  });
});

describe('chunking', () => {
  const LARGE_KEY = 'AWSLogs/123/CloudTrail/us-east-1/large.json.gz';

  it('sends 1001 records as two separate requests', async () => {
    const records = Array.from({ length: 1001 }, (_, i) => ({
      ...managementEvent,
      eventName: `Event${i}`,
    }));
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody(records) });
    await handler(makeS3Event(LARGE_KEY), mockContext);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('includes X-Chunk-Index and X-Total-Chunks headers when splitting', async () => {
    const records = Array.from({ length: 1001 }, (_, i) => ({
      ...managementEvent,
      eventName: `Event${i}`,
    }));
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody(records) });
    await handler(makeS3Event(LARGE_KEY), mockContext);

    const firstArgs = fetchMock.mock.calls.at(0);
    expect(firstArgs).toBeDefined();
    const headers = (firstArgs as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers['X-Chunk-Index']).toBe('0');
    expect(headers['X-Total-Chunks']).toBe('2');
  });

  it('does not include chunk headers when all records fit in one request', async () => {
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody([managementEvent]) });
    await handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    expect(fetchMock).toHaveBeenCalledOnce();

    const firstArgs = fetchMock.mock.calls.at(0);
    expect(firstArgs).toBeDefined();
    const headers = (firstArgs as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers['X-Chunk-Index']).toBeUndefined();
    expect(headers['X-Total-Chunks']).toBeUndefined();
  });
});

describe('retry behavior', () => {
  it('retries on HTTP error and succeeds on second attempt', async () => {
    vi.useFakeTimers();
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody([managementEvent]) });
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      } as Response)
      .mockImplementation(okResponse);

    const promise = handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('throws after exhausting all 5 retry attempts', async () => {
    vi.useFakeTimers();
    s3Mock.on(GetObjectCommand).resolves({ Body: makeGzipBody([managementEvent]) });
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('Connection refused'));

    const promise = handler(makeS3Event(CLOUDTRAIL_KEY), mockContext);
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow('Connection refused');
    expect(fetchMock).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });
});

describe('token retrieval via Secrets Manager', () => {
  it('fetches token from Secrets Manager when ANYSHIFT_TOKEN is not set', async () => {
    vi.resetModules();
    const savedToken = process.env.ANYSHIFT_TOKEN;
    delete process.env.ANYSHIFT_TOKEN;
    process.env.ANYSHIFT_TOKEN_SECRET_ARN =
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:anyshift-token';

    // After resetModules, create fresh mocks for the newly loaded module instances
    const { S3Client: FreshS3Client, GetObjectCommand: FreshGetObjectCommand } =
      await import('@aws-sdk/client-s3');
    const { SecretsManagerClient: FreshSMClient, GetSecretValueCommand: FreshGetSecretCommand } =
      await import('@aws-sdk/client-secrets-manager');
    const freshS3Mock = mockClient(FreshS3Client);
    const freshSMMock = mockClient(FreshSMClient);

    freshS3Mock.on(FreshGetObjectCommand).resolves({
      Body: makeGzipBody([managementEvent]) as unknown as GetObjectCommandOutput['Body'],
    });
    freshSMMock.on(FreshGetSecretCommand).resolves({ SecretString: 'sm-retrieved-token' });

    const { handler: freshHandler } = await import('./index.js');
    await freshHandler(makeS3Event(CLOUDTRAIL_KEY), mockContext);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sm-retrieved-token' }),
      }),
    );

    freshS3Mock.restore();
    freshSMMock.restore();
    process.env.ANYSHIFT_TOKEN = savedToken;
    delete process.env.ANYSHIFT_TOKEN_SECRET_ARN;
  });
});
