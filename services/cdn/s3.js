/**
 * S3 client trỏ vào MinIO trên VM3 qua private network (không đi Internet).
 *
 * Client được tạo lười (lazy) để khi `CDN_ENABLED=false` service không cần
 * @aws-sdk hoạt động được — quan trọng cho rollback và cho môi trường dev.
 */

const { config } = require('./config');

let client = null;
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

module.exports = { putObject, deleteObject, headObject, getClient };
