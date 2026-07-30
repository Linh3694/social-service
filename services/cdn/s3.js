/**
 * S3 client trỏ vào MinIO trên VM3 qua private network (không đi Internet).
 *
 * Client được tạo lười (lazy) để khi `CDN_ENABLED=false` service không cần
 * @aws-sdk hoạt động được — quan trọng cho rollback và cho môi trường dev.
 */

const { config } = require('./config');

let client = null;
let presignClient = null;
let sdk = null;

function getSdk() {
  if (!sdk) {
    // require lười: tắt CDN thì không chạm tới package này
    sdk = require('@aws-sdk/client-s3');
  }
  return sdk;
}

function getClient() {
  if (!client) {
    const { S3Client } = getSdk();
    client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: config.s3.forcePathStyle,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      },
    });
  }
  return client;
}

/**
 * @param {{bucket: string, key: string, body: Buffer, contentType: string, cacheControl?: string}} params
 */
async function putObject({ bucket, key, body, contentType, cacheControl }) {
  const { PutObjectCommand } = getSdk();
  await getClient().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
  return { bucket, key };
}

async function deleteObject({ bucket, key }) {
  const { DeleteObjectCommand } = getSdk();
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function headObject({ bucket, key }) {
  const { HeadObjectCommand } = getSdk();
  try {
    const res = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, size: res.ContentLength, contentType: res.ContentType };
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') {
      return { exists: false };
    }
    throw error;
  }
}

/** Tải object về buffer — dùng ở bước promote của upload trực tiếp (Phase 3). */
async function getObjectBuffer({ bucket, key }) {
  const { GetObjectCommand } = getSdk();
  const res = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return {
    buffer: Buffer.concat(chunks),
    contentType: res.ContentType,
  };
}

/**
 * Presigned PUT cho client upload thẳng lên MinIO (Phase 3).
 *
 * PHẢI ký bằng endpoint CÔNG KHAI, không phải endpoint private: SigV4 đưa `Host`
 * vào chữ ký, nên ký bằng `172.16.20.31:9000` rồi đưa client dùng qua
 * `media.wellspring.edu.vn` sẽ luôn `SignatureDoesNotMatch`. Đây đúng là bẫy mà
 * lms-media-service đã ghi lại trong config/minio.js.
 */
async function presignPutUrl({ bucket, key, contentType, expiresIn }) {
  const { PutObjectCommand, S3Client } = getSdk();
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  if (!presignClient) {
    presignClient = new S3Client({
      endpoint: config.publicUrl || config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: config.s3.forcePathStyle,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      },
    });
  }

  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });
  return getSignedUrl(presignClient, cmd, { expiresIn: expiresIn || 900 });
}

module.exports = {
  putObject,
  deleteObject,
  headObject,
  getObjectBuffer,
  presignPutUrl,
  getClient,
};
