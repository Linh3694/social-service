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
 * @param {{bucket: string, key: string, body: Buffer, contentType: string, cacheControl?: string, contentDisposition?: string}} params
 */
async function putObject({ bucket, key, body, contentType, cacheControl, contentDisposition }) {
  const { PutObjectCommand } = getSdk();
  await getClient().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl,
    // Tên file gốc cho trình duyệt — undefined thì SDK bỏ hẳn field, MinIO không
    // lưu header rỗng (xem contentDispositionFor ở index.js).
    ContentDisposition: contentDisposition,
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

/** Client dùng để ký — endpoint PHẢI là domain công khai; xem ghi chú ở presignPutUrl. */
function getPresignClient() {
  if (!presignClient) {
    const { S3Client } = getSdk();
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
  return presignClient;
}

// ── Upload nhiều phần, nối lại được (SIS-181) ─────────────────────────────
//
// Vì sao cần: trần upload là 1GB, mà phụ huynh/giáo viên phần lớn dùng 4G. Một
// lượt PUT đơn 800MB rớt ở phút thứ tám là mất trắng, phải tải lại từ đầu. Chia
// phần thì chỉ phải gửi lại đúng phần hỏng.
//
// BẪY ĐÃ TRÁNH — client KHÔNG cần đọc ETag. Cách làm chuẩn của S3 là client thu
// ETag của từng phần rồi gửi kèm lúc complete. Nhưng nginx trước MinIO chỉ
// `Access-Control-Expose-Headers: Content-Length, Content-Range` (media-setup-vm1.md:441)
// nên trình duyệt KHÔNG đọc được `ETag` — luôn null, và complete luôn hỏng, lại là
// một lỗi CORS câm nữa. Vì vậy server tự gọi `ListParts` để lấy ETag. Đổi lại
// còn được resume chuẩn xác: hỏi server phần nào đã lên rồi, không phải tin
// localStorage.

async function createMultipartUpload({ bucket, key, contentType }) {
  const { CreateMultipartUploadCommand } = getSdk();
  const r = await getClient().send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  }));
  return r.UploadId;
}

async function presignUploadPart({ bucket, key, uploadId, partNumber, expiresIn }) {
  const { UploadPartCommand } = getSdk();
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const cmd = new UploadPartCommand({
    Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber,
  });
  return getSignedUrl(getPresignClient(), cmd, { expiresIn: expiresIn || 900 });
}

/** Các phần đã lên, kèm ETag — nguồn sự thật cho cả resume lẫn complete. */
async function listParts({ bucket, key, uploadId }) {
  const { ListPartsCommand } = getSdk();
  const parts = [];
  let marker;
  do {
    // eslint-disable-next-line no-await-in-loop -- phân trang tuần tự
    const r = await getClient().send(new ListPartsCommand({
      Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker,
    }));
    for (const p of r.Parts || []) parts.push({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size });
    marker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
  } while (marker);
  return parts.sort((a, b) => a.PartNumber - b.PartNumber);
}

async function completeMultipartUpload({ bucket, key, uploadId, parts }) {
  const { CompleteMultipartUploadCommand } = getSdk();
  await getClient().send(new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })) },
  }));
}

async function abortMultipartUpload({ bucket, key, uploadId }) {
  const { AbortMultipartUploadCommand } = getSdk();
  await getClient().send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
}

module.exports = {
  putObject,
  deleteObject,
  headObject,
  getObjectBuffer,
  presignPutUrl,
  getClient,
  createMultipartUpload,
  presignUploadPart,
  listParts,
  completeMultipartUpload,
  abortMultipartUpload,
};
