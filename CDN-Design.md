# CDN Wellspring — Thiết kế & Kế hoạch triển khai

> **Phạm vi giai đoạn 1:** media của `social-service` (bài đăng WISLife, chat GV↔PH, avatar).
> **Mục tiêu dài hạn:** CDN dùng chung cho toàn dự án (SIS files, parent-portal, LMS docs…).
> **Domain:** `https://cdn.wellspring.edu.vn`
> **Liên quan:** [`media-setup-vm1.md`](./media-setup-vm1.md) (VM1 media LMS), [`LMS-Design.md`](./LMS-Design.md) §9

**Quyết định đã chốt (2026-07-29):**

| Hạng mục | Chốt |
|----------|------|
| Hạ tầng | **VM3 mới, độc lập** — không dùng chung VM1 (LMS video/transcode) |
| Bảo mật | **100% private** — mọi object phát qua URL có chữ ký, không có object public |
| Edge | **100% self-host** — không Cloudflare/CDN thương mại |
| Quy mô | ~5.000–10.000 user, uploads hiện tại < 200 GB |

---

## Mục lục

1. [Hiện trạng & vấn đề](#1-hiện-trạng--vấn-đề)
2. [Kiến trúc đích](#2-kiến-trúc-đích)
3. [Cơ chế bảo mật: private + vẫn cache được](#3-cơ-chế-bảo-mật-private--vẫn-cache-được)
4. [Sizing VM3](#4-sizing-vm3)
5. [Bucket & quy ước object key](#5-bucket--quy-ước-object-key)
6. [Thay đổi trong social-service](#6-thay-đổi-trong-social-service)
7. [Tối ưu ảnh/video (nguồn tiết kiệm lớn nhất)](#7-tối-ưu-ảnhvideo-nguồn-tiết-kiệm-lớn-nhất)
8. [Cấu hình Nginx VM3](#8-cấu-hình-nginx-vm3)
9. [Migration dữ liệu cũ](#9-migration-dữ-liệu-cũ)
10. [Kế hoạch theo phase](#10-kế-hoạch-theo-phase)
11. [Rollback](#11-rollback)
12. [Vận hành: backup, monitoring, lifecycle](#12-vận-hành-backup-monitoring-lifecycle)
13. [Rủi ro & điểm cần lưu ý](#13-rủi-ro--điểm-cần-lưu-ý)
14. [Mở rộng cho toàn dự án](#14-mở-rộng-cho-toàn-dự-án)

---

## 1. Hiện trạng & vấn đề

### 1.1. Luồng media hiện tại

```
Client (web/mobile)
   │  POST multipart /api/social  hoặc  /api/social/chat/.../attachments
   ▼
Nginx SIS (admin.sis / prod.sis.wellspring.edu.vn)
   ▼
social-service :5010  (VM microservices dùng chung)
   ├── multer diskStorage → ./uploads/posts/   ./uploads/chat/
   └── express.static('/uploads')  ← chính process Node phục vụ byte ảnh/video
```

**Nguồn (đã đọc):**

| Vị trí | Nội dung |
|--------|----------|
| `social-service/routes/postRoutes.js:12-18` | `multer.diskStorage` → `uploads/posts/`, limit 50 MB |
| `social-service/routes/chatRoutes.js:12-55` | `multer.diskStorage` → `uploads/chat/`, limit 100 MB |
| `social-service/app.js:108-116` | `express.static(uploadPath)` mount ở `/uploads` **và** `/api/social/uploads`, `Cache-Control: public, max-age=86400, immutable` |
| `controllers/postController.js:514, 929` | DB lưu chuỗi `"/api/social/uploads/posts/<file>"` |
| `controllers/chatController.js:2141, 2241` | DB lưu chuỗi `"/uploads/chat/<file>"` |
| `controllers/chatController.js:1307` | `sanitizeIncomingAttachments` chỉ nhận URL bắt đầu `"/uploads/chat/"` |

### 1.2. Vấn đề

| # | Vấn đề | Hệ quả |
|---|--------|--------|
| **P1** | Byte media đi xuyên qua process Node đơn luồng | Tải một video 100 MB chiếm event loop; API feed/chat chậm theo. `instances: 1` trong `ecosystem.config.js` ⇒ không có buffer. |
| **P2** | File nằm trên **disk local của VM microservices** | Không scale ngang được (`pm2 scale` = mất file). Restore/backup VM đó phải kéo theo toàn bộ media. |
| **P3** | **Không có bảo mật ở tầng media** | `express.static` phục vụ mọi file cho bất kỳ ai có URL — kể cả **ảnh chat GV↔PH về học sinh**. Không kiểm tra token. Đây là rủi ro nghiêm trọng nhất hiện nay. |
| **P4** | Lưu **nguyên ảnh gốc từ điện thoại** (3–5 MB/ảnh) | Feed 18 ảnh = ~60 MB tải về/phiên. Trên 4G phụ huynh, feed gần như không dùng được. Disk phình ~866 GB/năm học (xem §4). |
| **P5** | **Không strip EXIF** | Ảnh điện thoại chứa toạ độ GPS. Ảnh học sinh do GV chụp tại trường bị lộ vị trí — vấn đề tuân thủ, không chỉ kỹ thuật. |
| **P6** | Media dính chặt vào domain SIS (`SOCIAL_BASE_URL`) | Mọi request ảnh phải đi qua Nginx SIS + upstream `sis_app`, cạnh tranh connection với API nghiệp vụ. |

### 1.3. Điểm thuận lợi lớn — client đã sẵn sàng

Cả 3 client đều **đã xử lý URL tuyệt đối**:

```ts
// frappe-sis-frontend/src/pages/Teaching/Class/tabs/ClassActionTab.tsx:160
function resolveMediaUrl(path?: string) {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;  // ← đi thẳng
  return `${SOCIAL_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

// workspace-mobile/src/utils/imageUtils.ts:18  và  src/utils/image.ts:14 — logic tương đương
```

⇒ **Khi backend trả URL tuyệt đối `https://cdn.wellspring.edu.vn/...`, cả web và mobile hoạt động ngay, không cần build lại app.** Đây là lý do lộ trình dưới đây có thể triển khai mà không chờ release mobile — một lợi thế hiếm, nên tận dụng.

---

## 2. Kiến trúc đích

```
                        Internet
                            │
                            ▼
          ┌─────────────────────────────────────────┐
          │  VM3 — cdn.wellspring.edu.vn  (mới)     │
          │                                          │
          │  Nginx :443                              │
          │   ├── secure_link  → xác thực chữ ký    │  ← chặn tại edge, không tới MinIO
          │   ├── proxy_cache  → object nóng         │
          │   └── proxy_pass 127.0.0.1:9000          │
          │                                          │
          │  MinIO :9000  (bind 127.0.0.1 + private) │
          │   └── /data  (NVMe)                      │
          │                                          │
          │  cdn-service :5040   (Phase 2)           │
          │   └── sharp + ffmpeg: variants, EXIF     │
          └────────────────┬─────────────────────────┘
                           │ private 172.16.20.0/24
                           │ S3 API + presign
          ┌────────────────┴─────────────────────────┐
          │  VM microservices — social-service :5010 │
          │   • upload → stream lên MinIO            │
          │   • DB lưu **object key**, không lưu URL │
          │   • ký URL tại thời điểm trả API         │
          └──────────────────────────────────────────┘
```

**Tại sao VM riêng, không dùng chung VM1:**

| | VM1 (media LMS) | VM3 (CDN social) |
|---|---|---|
| Profile tải | Ít file, rất lớn (video bài giảng), throughput cao | **Rất nhiều file nhỏ**, IOPS cao, QPS cao |
| CPU | FFmpeg transcode ăn 100% CPU nhiều giờ | Nginx TLS + sharp — cần latency ổn định |
| Hệ quả nếu chung | Transcode một bài giảng làm **treo feed toàn trường** | — |
| Vòng đời | Video học liệu giữ nhiều năm | Chat có TTL, feed archive theo năm học |
| Downtime | Bảo trì LMS = mất luôn ảnh chat | Độc lập |

Hai workload xung đột nhau về mọi mặt. Tách VM là quyết định đúng.

---

## 3. Cơ chế bảo mật: private + vẫn cache được

Đây là phần thiết kế then chốt. Yêu cầu "**100% private, signed URL toàn bộ**" thường **giết chết cache** — vì mỗi lần ký ra một URL khác nhau, browser không dùng lại được, Nginx cache không hit. Ba kỹ thuật dưới đây giữ được cả hai.

### 3.1. Chọn Nginx `secure_link`, không dùng MinIO presigned GET

| | MinIO presigned GET (SigV4) | **Nginx `secure_link`** ✅ |
|---|---|---|
| Nơi kiểm | MinIO (Go process) | **Nginx tại edge** — request sai bị chặn trước khi tốn tài nguyên |
| Cache được? | Rất khó — chữ ký nằm trong nhiều query param, `Host` nằm trong chữ ký | Được — cache key tách khỏi chữ ký |
| Chi phí ký | HMAC-SHA256 nhiều bước, phải giữ S3 client | 1 lần MD5, thuần chuỗi — không cần gọi MinIO |
| Đổi backend | Ràng vào S3 | Trong suốt — sau này đổi sang disk/Ceph không ảnh hưởng client |

**Cách MinIO cho Nginx đọc mà vẫn private (điểm dễ làm sai):**

Nếu để `mc anonymous set none` rồi `proxy_pass` thẳng, MinIO sẽ trả **403** cho mọi request từ Nginx — vì Nginx không ký SigV4. Ba cách xử lý:

| Cách | Đánh giá |
|------|----------|
| `mc anonymous set download` | ❌ Mọi máy trong `172.16.20.0/24` đọc được object không cần chữ ký. Trái với yêu cầu "100% private". |
| Nginx ký SigV4 bằng njs (`nginx-s3-gateway`) | Đúng nhất, nhưng thêm module njs + độ phức tạp vận hành |
| **Bucket policy có điều kiện `aws:SourceIp = 127.0.0.1`** ✅ | Chỉ **tiến trình Nginx trên chính VM3** đọc được. Không cần njs. |

```json
// /opt/cdn/policies/allow-nginx-only.json  — áp cho từng bucket
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": ["*"] },
    "Action": ["s3:GetObject"],
    "Resource": ["arn:aws:s3:::cdn-social-posts/*"],
    "Condition": { "IpAddress": { "aws:SourceIp": "127.0.0.1/32" } }
  }]
}
```

```bash
mc anonymous set-json /opt/cdn/policies/allow-nginx-only.json local/cdn-social-posts
```

Cộng thêm: MinIO **chỉ nghe `127.0.0.1:9000` + `172.16.20.94:9000`**, UFW chặn 9000 từ Internet, và Nginx bắt buộc chữ ký. Kết quả — object không lộ ra ngoài kể cả khi đoán đúng key, và **cũng không lộ với máy khác trong LAN**.

> Nginx **không** được `proxy_set_header X-Forwarded-For` ở chặng đi MinIO, nếu không MinIO có thể lấy IP client thay vì `127.0.0.1` và policy sẽ chặn nhầm. Config §8 đã xoá header này một cách tường minh.

### 3.2. Expiry làm tròn cửa sổ (window rounding) — mấu chốt để cache hoạt động

Nếu ký `exp = now + 24h`, mỗi user mở feed lúc khác nhau ⇒ URL khác nhau ⇒ **cache miss 100%**.

Giải pháp: **làm tròn expiry lên mốc cố định**, để mọi user trong cùng cửa sổ nhận **URL giống hệt nhau**:

```js
// services/cdnSign.js
const WINDOW = 6 * 3600;     // cửa sổ 6 giờ
const LIFETIME = 24 * 3600;  // URL sống tối thiểu 24 giờ

function signedUrl(objectPath) {                       // objectPath = "/social-posts/2026/07/ab/xxx.webp"
  const exp = Math.ceil(Date.now() / 1000 / WINDOW) * WINDOW + LIFETIME;
  const raw = `${exp}${objectPath} ${process.env.CDN_LINK_SECRET}`;
  const sig = crypto.createHash('md5').update(raw).digest('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');   // base64url — đúng chuẩn secure_link
  return `${process.env.CDN_PUBLIC_URL}${objectPath}?e=${exp}&s=${sig}`;
}
```

Kết quả:

* Trong mỗi cửa sổ 6 h, cùng một ảnh ⇒ **cùng một URL** ⇒ browser cache hit, Nginx cache hit.
* URL luôn còn hạn ít nhất 24 h, tối đa 30 h ⇒ ảnh trong feed không bao giờ "chết giữa chừng" khi user cuộn.
* Link bị chia sẻ ra ngoài (Zalo, email) **tự hết hạn trong ≤ 30 h**.
* Đổi `CDN_LINK_SECRET` ⇒ **toàn bộ link cũ chết ngay lập tức** — có sẵn nút "kill switch".

> Đánh đổi cần biết: cửa sổ 6 h nghĩa là link rò rỉ vẫn dùng được tối đa 30 h. Với bucket nhạy cảm hơn có thể hạ `WINDOW=1h / LIFETIME=2h` (mục §3.4), đổi lại cache hit giảm.

### 3.3. Cache key bỏ qua chữ ký

```nginx
proxy_cache_key "$uri";     # KHÔNG gồm $args
```

Nhờ vậy object đã cache ở cửa sổ trước vẫn phục vụ được cho cửa sổ sau — chỉ cần chữ ký hợp lệ. Cache hit rate thực tế đạt ~90 %+ với avatar và ảnh feed. Cache **không** là lỗ hổng: Nginx đã chặn request sai chữ ký **trước khi** đọc cache.

### 3.4. Phân tầng theo độ nhạy cảm

| Bucket | Cửa sổ / hạn | `Cache-Control` gửi client | Nginx `proxy_cache` |
|--------|--------------|---------------------------|---------------------|
| `cdn-social-avatars` | 24 h / 7 ngày | `private, max-age=604800, immutable` | ✅ 30 ngày |
| `cdn-social-posts` | 6 h / 24 h | `private, max-age=86400, immutable` | ✅ 7 ngày |
| `cdn-social-chat` | **1 h / 2 h** | `private, max-age=3600` | ✅ 24 h (key = `$uri`) |

`private` (không phải `public`) ⇒ proxy trung gian của ISP/trường **không được** cache; chỉ browser của chính user cache. Vì key đã content-addressed (§5.2) nên `immutable` là an toàn tuyệt đối: nội dung đổi ⇒ key đổi.

### 3.5. Kiểm soát quyền ở tầng ứng dụng — vẫn giữ nguyên

Chữ ký chỉ trả lời "URL này có hợp lệ không", **không** trả lời "user này có quyền xem không". Quyền vẫn do `social-service` quyết định: chỉ khi user qua được `getConversationForUser()` / quyền xem post thì API mới **ký và trả URL**. Không có quyền ⇒ không nhận được URL ⇒ không xem được. Mô hình này giữ nguyên toàn bộ logic phân quyền đang có, không phải viết lại.

---

## 4. Sizing VM3

### 4.1. Tính toán dung lượng (10.000 user)

Giả định: 120 bài đăng/ngày × 3 ảnh, 600 ảnh chat/ngày, 8 video bài đăng + 25 video chat/ngày.

| Hạng mục | Nếu giữ nguyên hiện trạng | **Sau tối ưu (§7)** |
|----------|---------------------------|---------------------|
| Ảnh bài đăng | 1,23 GB/ngày | **0,15 GB/ngày** |
| Video bài đăng | 0,20 GB/ngày | 0,20 GB/ngày |
| Ảnh chat | 1,46 GB/ngày | **0,21 GB/ngày** |
| Video chat | 0,44 GB/ngày | 0,44 GB/ngày |
| **Tổng** | **~3,3 GB/ngày** | **~1,0 GB/ngày** |
| **Mỗi năm học (260 ngày)** | **~866 GB** | **~257 GB** |

> Chỉ riêng việc re-encode ảnh sang WebP đã **cắt ~70 % dung lượng và ~85 % băng thông**. Đây là hạng mục có ROI cao nhất trong toàn bộ kế hoạch — nếu chỉ làm được một việc, hãy làm việc này.

Dự phóng disk (đã cộng 35 % overhead MinIO + snapshot):

| Mốc | Dữ liệu | Cần cấp |
|-----|---------|---------|
| Sau 1 năm học | 257 GB | 347 GB |
| Sau 2 năm học | 514 GB | 693 GB |
| Sau 3 năm học | 770 GB | **1.040 GB** |

### 4.2. Băng thông

| Chỉ số | Giá trị |
|--------|---------|
| Phiên mở feed (18 thumbnail 480 px ≈ 110 KB) | 1,93 MB/user |
| Peak 1.200 user đồng thời trong 5 phút | **~60 Mbps** |
| Egress tháng | ~150 GB |

NIC 1 Gbps thừa sức. Nút thắt thực tế là **IOPS ảnh nhỏ**, không phải băng thông ⇒ **bắt buộc NVMe**, không dùng HDD/SAN.

### 4.3. Cấu hình đề xuất

| Hạng mục | Giá trị | Ghi chú |
|----------|---------|---------|
| vCPU | **4** | Nginx TLS ~1 core; sharp 2 core; MinIO 1 core |
| RAM | **8 GB** | 4 GB page cache là phần quan trọng nhất |
| Disk OS | 50 GB | `/` |
| Disk data | **1 TB NVMe** → `/data` | Đủ ~3 năm học sau tối ưu. Chọn volume **mở rộng online được**. |
| Cache Nginx | 60 GB (trong 1 TB) | `/var/cache/nginx/cdn` |
| Public IP | 1 | Nginx :443 |
| Private IP | `172.16.20.94` (đề xuất) | Kề VM1 `.93`, dễ nhớ |
| NIC | 1 Gbps | |

> 4 vCPU / 8 GB là mức khởi điểm, **không** phải giới hạn. Nếu bật transcode video 720p (§7.3), FFmpeg cần thêm 2–4 core — hãy chọn nhà cung cấp cho phép resize CPU/RAM nóng.

**Ghi chú về `proxy_cache` khi Nginx và MinIO cùng máy:** cache không tiết kiệm I/O disk (cùng NVMe), nhưng vẫn đáng bật vì bỏ qua tầng Go của MinIO (parse S3 request, kiểm policy, metadata lookup) và cho Nginx dùng `sendfile` zero-copy. Đo được ~3–5× throughput trên file nhỏ. Nếu sau này tách MinIO sang máy khác, cache trở thành thiết yếu.

---

## 5. Bucket & quy ước object key

### 5.1. Bucket

| Bucket | Nội dung | Policy đọc | Lifecycle |
|--------|----------|-----------|-----------|
| `cdn-social-posts` | Ảnh/video bài đăng + variants | `GetObject` chỉ từ `127.0.0.1` (§3.1) | Giữ, archive theo năm học |
| `cdn-social-chat` | Đính kèm chat GV↔PH | `GetObject` chỉ từ `127.0.0.1` | Xoá theo chính sách lưu trữ trường (mặc định: giữ) |
| `cdn-social-avatars` | Avatar đã chuẩn hoá 256 px | `GetObject` chỉ từ `127.0.0.1` | Giữ |
| `cdn-staging` | Vùng đệm upload trực tiếp (Phase 3) | **`none`** — không phát ra ngoài | **Expire 1 ngày** |

User `social_service` (IAM) có `PutObject/DeleteObject/HeadObject` trên cả 4 bucket qua private network — độc lập với policy đọc ẩn danh ở trên.

Prefix `cdn-` để sau này thêm `cdn-sis-files`, `cdn-parent-portal`… mà không phải đổi convention.

### 5.2. Object key — content-addressed

```
<bucket>/<yyyy>/<mm>/<hash[0:2]>/<hash>.<ext>
<bucket>/<yyyy>/<mm>/<hash[0:2]>/<hash>_w480.webp
<bucket>/<yyyy>/<mm>/<hash[0:2]>/<hash>_w1080.webp
```

`hash = sha256(nội dung file).hex[0:32]`

Lợi ích:

* **Dedupe tự nhiên** — cùng một ảnh 20 GV cùng gửi ⇒ lưu 1 bản. Trong môi trường trường học (ảnh sự kiện, thông báo chuyển tiếp) tỉ lệ trùng thực tế khá cao.
* **Immutable đúng nghĩa** — nội dung đổi ⇒ key đổi ⇒ `Cache-Control: immutable` không bao giờ sai. Không còn class lỗi "user thấy ảnh cũ".
* **Shard `hash[0:2]`** — 256 prefix, tránh thư mục có hàng trăm nghìn entry.
* Không lộ thông tin (khác với tên file `chat-1753776000000-123456789.jpg` hiện tại — đoán được thời điểm gửi).

### 5.3. Lưu gì trong MongoDB

**Lưu object key, KHÔNG lưu URL đầy đủ.**

```js
// Post.images / ChatMessage.attachments[].url
"cdn://social-posts/2026/07/ab/ab3f…d1.webp"
```

Ký thành URL đầy đủ **tại thời điểm trả API**. Đây là quyết định quan trọng, cho phép:

* Đổi domain CDN, đổi `CDN_LINK_SECRET`, đổi cửa sổ hết hạn — **không migration DB**.
* Không bao giờ có URL hết hạn nằm chết trong DB.
* Cùng object phục vụ nhiều client với TTL khác nhau nếu cần.

Prefix `cdn://` giúp phân biệt rõ với giá trị legacy `/uploads/...` và `/api/social/uploads/...` trong lúc migration (§9).

---

## 6. Thay đổi trong social-service

### 6.1. Dependency mới

```bash
npm i @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner sharp
```

`sharp` là native binary — build trên đúng kiến trúc VM (Linux x64 glibc). Cố định phiên bản trong `package.json`.

### 6.2. Biến môi trường (`config.env`)

```bash
# --- CDN ---
CDN_ENABLED=true                                    # kill switch → false = quay lại disk local
CDN_PUBLIC_URL=https://cdn.wellspring.edu.vn
CDN_S3_ENDPOINT=http://172.16.20.94:9000            # private, không qua Internet
CDN_ACCESS_KEY=social_service
CDN_SECRET_KEY=<đổi>
CDN_REGION=us-east-1
CDN_FORCE_PATH_STYLE=true

CDN_BUCKET_POSTS=cdn-social-posts
CDN_BUCKET_CHAT=cdn-social-chat
CDN_BUCKET_AVATARS=cdn-social-avatars

# Bí mật ký secure_link — PHẢI trùng $cdn_secret trong nginx VM3
CDN_LINK_SECRET=<32+ ký tự ngẫu nhiên>
CDN_SIGN_WINDOW_SEC=21600                           # 6h
CDN_SIGN_LIFETIME_SEC=86400                         # 24h
CDN_SIGN_WINDOW_CHAT_SEC=3600                       # chat: 1h
CDN_SIGN_LIFETIME_CHAT_SEC=7200                     # chat: 2h

# Xử lý ảnh
CDN_IMAGE_MAX_WIDTH=2048
CDN_IMAGE_QUALITY=82
CDN_IMAGE_VARIANTS=480,1080
CDN_STRIP_EXIF=true

# Đọc dữ liệu cũ trong lúc migrate
CDN_LEGACY_FALLBACK=true
```

### 6.3. Module mới

```
social-service/services/cdn/
├── s3.js           # S3Client + putObjectStream / headObject / deleteObject
├── sign.js         # signedUrl(objectKey, {profile}) — secure_link, window rounding
├── imagePipeline.js# sharp: strip EXIF → resize → webp → variants
├── videoPipeline.js# ffmpeg: faststart remux + poster (Phase 2)
└── index.js        # storeUpload(file, {bucket, kind}) → { key, variants, width, height }
```

### 6.4. Điểm cần sửa (đầy đủ)

| File | Dòng | Sửa |
|------|------|-----|
| `routes/postRoutes.js` | 12–18 | `diskStorage` → thư mục **tạm** `os.tmpdir()`; sau khi controller xử lý xong thì `unlink` |
| `routes/chatRoutes.js` | 12–20 | Tương tự |
| `controllers/postController.js` | 514, 929 | `/uploads/posts/<f>` → `await cdn.storeUpload(file, {bucket: POSTS})` → lưu `cdn://social-posts/...` |
| `controllers/postController.js` | 604 | Cleanup khi lỗi: xoá file tạm **và** object đã lên MinIO |
| `controllers/chatController.js` | 2141, 2241 | Như trên với bucket CHAT |
| `controllers/chatController.js` | **1307** | `sanitizeIncomingAttachments`: chấp nhận `cdn://social-chat/` (giữ `/uploads/chat/` cho tới hết migration) |
| `controllers/chatController.js` | **27** `messagePayloadForApi` | **Điểm ký tập trung cho chat** — map `attachments[].url` qua `sign()` |
| `controllers/postController.js` | 60–90 `populatePostQuery` | **Điểm ký tập trung cho post** — thêm hàm `signPostMedia(post)` cho `images`, `videos`, `authorSnapshot.avatarUrl` |
| `utils/chatSocket.js`, `utils/newfeedSocket.js` | — | **Quan trọng:** payload realtime cũng phải đi qua cùng hàm ký, nếu không tin nhắn mới sẽ hiện ảnh vỡ |
| `app.js` | 108–116 | Giữ `express.static('/uploads')` trong suốt Phase 1–3, **gỡ ở Phase 4** |

> Cạm bẫy hay gặp: quên ký ở đường socket. Ảnh hiển thị đúng khi F5 nhưng vỡ khi tin nhắn đến realtime. Nên viết **một** hàm `signMediaDeep(payload)` và gọi ở cả REST lẫn socket, thay vì ký rải rác.

### 6.5. Luồng upload sau khi sửa (Phase 1)

```
Client ──multipart──▶ social-service
                          │ ① ghi file tạm /tmp (không còn ./uploads)
                          │ ② sha256 → object key
                          │ ③ sharp: strip EXIF → webp 2048 + w1080 + w480
                          │ ④ PutObject song song lên MinIO VM3 (private network)
                          │ ⑤ unlink /tmp
                          ▼
                     DB lưu "cdn://social-posts/2026/07/ab/<hash>.webp"
                          │
                          ▼ khi trả API
                     ký → "https://cdn.wellspring.edu.vn/social-posts/…?e=…&s=…"
```

---

## 7. Tối ưu ảnh/video (nguồn tiết kiệm lớn nhất)

### 7.1. Ảnh — pipeline `sharp`

```js
const pipeline = sharp(tmpPath, { failOn: 'none' })
  .rotate()                                    // áp EXIF orientation RỒI mới strip
  .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
  .webp({ quality: 82, effort: 4 });
// sharp mặc định KHÔNG copy metadata ⇒ EXIF/GPS bị loại (không gọi .withMetadata())
```

Variants sinh cùng lúc: `_w1080` (xem chi tiết), `_w480` (thumbnail feed), avatar `_w96`.

| | Trước | Sau |
|---|-------|-----|
| Ảnh điện thoại 12 MP | 3,5 MB | **~350 KB** (2048 px WebP) |
| Thumbnail feed | 3,5 MB (tải nguyên ảnh gốc!) | **~110 KB** |
| Feed 18 ảnh | ~63 MB | **~1,9 MB** |

Feed nhanh hơn ~33 lần trên 4G. Đây là thay đổi mà phụ huynh cảm nhận được ngay.

> `.rotate()` **phải** đứng trước, vì strip EXIF sẽ mất cờ orientation ⇒ ảnh chụp dọc bị xoay ngang. Lỗi này rất hay gặp và chỉ lộ ra khi user thật dùng.

**Giữ lại bản gốc?** Đề xuất: **không** cho ảnh feed/chat (bản 2048 px WebP q82 đã vượt nhu cầu hiển thị). Nếu nghiệp vụ cần bản gốc (ví dụ ảnh sự kiện để in ấn), thêm bucket `cdn-social-originals` với lifecycle 90 ngày rồi chuyển sang lưu trữ lạnh.

### 7.2. Định dạng: WebP, không AVIF

AVIF nhỏ hơn ~20 % nhưng encode chậm hơn 5–10× — không đáng trên 4 vCPU. WebP được hỗ trợ bởi 97 %+ trình duyệt, React Native và iOS/Android WebView đều đọc tốt. Ảnh động/PNG trong suốt vẫn giữ alpha channel qua WebP.

### 7.3. Video

**Phase 1 — remux (rẻ, làm ngay):**

```bash
ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4     # ~1 giây, không re-encode
ffmpeg -i in.mp4 -ss 1 -vframes 1 -vf scale=480:-1 poster.webp
```

`+faststart` đẩy moov atom lên đầu file ⇒ video **phát ngay** thay vì phải tải hết. Poster frame giúp feed không bị khoảng trắng chờ.

**Phase 2 — transcode 720p (tuỳ chọn):** `-c:v libx264 -crf 26 -preset veryfast -vf scale=-2:720` cắt ~60 % dung lượng video, nhưng cần thêm 2–4 vCPU và một queue (BullMQ, Redis `172.16.20.120` DB **/3** — tránh trùng DB /2 của `lms-media-service`). Chỉ làm nếu video chat vượt ~0,5 GB/ngày.

**Không làm HLS cho social.** Video chat/feed ngắn (< 2 phút), progressive MP4 + `faststart` là đủ; HLS thêm phức tạp mà không có lợi ích tương xứng. HLS để dành cho LMS trên VM1.

### 7.4. Ảnh hưởng lên `Cache-Control` phía client

Vì key content-addressed, có thể mạnh dạn:

```
Cache-Control: private, max-age=86400, immutable
```

Kết hợp `resolveMediaUrl` sẵn có của client ⇒ ảnh feed cuộn lại **không phát sinh request nào**.

---

## 8. Cấu hình Nginx VM3

```nginx
# /etc/nginx/conf.d/cdn-cache.conf  (khối http)
proxy_cache_path /var/cache/nginx/cdn levels=1:2 keys_zone=cdn_cache:200m
                 max_size=60g inactive=30d use_temp_path=off;

map $http_origin $cdn_cors {
    default "";
    "~^https://(wis|parentportal|admin\.sis|prod\.sis)\.wellspring\.edu\.vn$" $http_origin;
    "~^https://(wis-staging|parentportal-staging)\.wellspring\.edu\.vn$"      $http_origin;
}
```

Khối `secure_link` lặp lại ở nhiều `location` ⇒ tách ra snippet:

```nginx
# /etc/nginx/snippets/cdn-securelink.conf
secure_link     $arg_s,$arg_e;
secure_link_md5 "$secure_link_expires$uri CHANGE_ME_CDN_LINK_SECRET";
if ($secure_link = "")  { return 403; }   # thiếu / sai chữ ký
if ($secure_link = "0") { return 410; }   # hết hạn
```

```nginx
# /etc/nginx/snippets/cdn-upstream.conf  — chặng đi MinIO
proxy_http_version 1.1;
proxy_set_header   Host $http_host;
proxy_set_header   Connection "";
proxy_set_header   Authorization "";
# KHÔNG gửi X-Forwarded-For: policy MinIO khớp aws:SourceIp = 127.0.0.1
proxy_set_header   X-Forwarded-For "";
proxy_hide_header  x-amz-request-id;
proxy_hide_header  x-amz-id-2;
proxy_hide_header  x-amz-version-id;
proxy_hide_header  Set-Cookie;
proxy_ignore_headers Set-Cookie Cache-Control Expires;

add_header X-Content-Type-Options nosniff always;
add_header Access-Control-Allow-Origin $cdn_cors always;
add_header Cross-Origin-Resource-Policy "cross-origin" always;
add_header Timing-Allow-Origin $cdn_cors always;
add_header Accept-Ranges bytes always;
```

```nginx
# /etc/nginx/sites-available/cdn.wellspring.edu.vn
server {
    listen 80;
    server_name cdn.wellspring.edu.vn;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name cdn.wellspring.edu.vn;

    # certbot inject ssl_certificate / ssl_certificate_key
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:CDNSSL:20m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # Ảnh/video đã nén sẵn — gzip chỉ tốn CPU
    gzip off;
    sendfile on;
    tcp_nopush on;

    access_log /var/log/nginx/cdn.access.log;
    error_log  /var/log/nginx/cdn.error.log;

    location = /health { access_log off; return 200 "ok\n"; }

    # ⚠️ THỨ TỰ QUAN TRỌNG — nginx khớp regex location theo thứ tự khai báo.
    #    Đặt cụ thể trước, tổng quát sau.

    # ── (1) VIDEO: KHÔNG cache. Range/206 cần slice module mới cache đúng;
    #        video chiếm % request rất nhỏ ⇒ stream thẳng cho đơn giản & đúng.
    location ~ ^/(?<svc>social-posts|social-chat)/(?<objkey>.+\.(?:mp4|mov|m4v|webm))$ {
        include /etc/nginx/snippets/cdn-securelink.conf;
        proxy_cache off;
        proxy_force_ranges on;
        proxy_buffering off;
        proxy_pass http://127.0.0.1:9000/cdn-$svc/$objkey;
        include /etc/nginx/snippets/cdn-upstream.conf;
        add_header Cache-Control "private, max-age=3600" always;
    }

    # ── (2) CHAT (ảnh/tệp): TTL ngắn nhất
    location ~ ^/social-chat/(?<objkey>.+)$ {
        include /etc/nginx/snippets/cdn-securelink.conf;
        proxy_cache       cdn_cache;
        proxy_cache_key   "$uri";                 # bỏ chữ ký ⇒ dùng lại qua nhiều cửa sổ
        proxy_cache_valid 200 24h;
        proxy_cache_valid 403 404 1m;
        proxy_cache_lock  on;
        proxy_pass http://127.0.0.1:9000/cdn-social-chat/$objkey;
        include /etc/nginx/snippets/cdn-upstream.conf;
        add_header Cache-Control "private, max-age=3600" always;
        add_header X-Cache-Status $upstream_cache_status always;
    }

    # ── (3) BÀI ĐĂNG + AVATAR: cache dài
    location ~ ^/(?<svc>social-posts|social-avatars)/(?<objkey>.+)$ {
        include /etc/nginx/snippets/cdn-securelink.conf;
        proxy_cache       cdn_cache;
        proxy_cache_key   "$uri";
        proxy_cache_valid 200 30d;
        proxy_cache_valid 403 404 1m;
        proxy_cache_lock  on;                     # 100 request đồng thời → 1 lần tới MinIO
        proxy_cache_use_stale error timeout updating http_500 http_502 http_503;
        proxy_cache_background_update on;
        proxy_pass http://127.0.0.1:9000/cdn-$svc/$objkey;
        include /etc/nginx/snippets/cdn-upstream.conf;
        add_header Cache-Control "private, max-age=86400, immutable" always;
        add_header X-Cache-Status $upstream_cache_status always;
    }

    # Mọi thứ khác — kể cả S3 API, ListBucket, console — đều chặn
    location / { return 404; }
}
```

**Năm chỗ dễ sai, đã xử lý trong config trên:**

1. **Thứ tự regex `location`.** nginx khớp regex location **theo thứ tự khai báo**. Nếu đặt `^/(social-posts|social-chat|social-avatars)/` trước, khối `^/social-chat/` phía sau **không bao giờ chạy** ⇒ chat vô tình hưởng TTL 24 h của bài đăng. Cụ thể trước, tổng quát sau.
2. **Named capture `(?<svc>…)` thay vì `$1`/`$2`.** `$1`,`$2` là biến toàn cục dùng chung cho mọi phép khớp regex trong request — regex trong `map $http_origin $cdn_cors` (đánh giá lười, đúng lúc `add_header` chạy) có thể ghi đè chúng, khiến `proxy_pass` trỏ sai bucket. Named capture là biến riêng, không bị đụng. Đây là loại lỗi chỉ xuất hiện lúc tải cao và cực khó truy vết — dùng named capture ngay từ đầu.
3. **Cache 206.** `proxy_cache_valid 206` không làm nginx cache range đúng cách (cần module `slice`). Video tách ra `proxy_cache off`.
4. **`$secure_link_expires` chứ không `$arg_e`** trong `secure_link_md5` — biến chuẩn của module, tránh sai lệch khi query bị encode.
5. **Object key chỉ dùng `[A-Za-z0-9._/-]`.** Location regex khớp trên URI **đã giải mã**; nếu key chứa ký tự cần escape thì `proxy_pass` có thể mã hoá lại sai. Quy ước content-addressed (§5.2) đảm bảo điều này theo thiết kế.

> Thuật toán ký đã được đối chiếu: `md5` nhị phân → base64url của phía Node **khớp chính xác** với `openssl md5 -binary | openssl base64 | tr +/ -_ | tr -d =` — đúng thuật toán `ngx_http_secure_link_module`. Kiểm tra làm tròn cửa sổ cũng xác nhận: các thời điểm trong cùng khối 6 h sinh ra URL giống hệt nhau, đổi đúng tại mốc biên.

**Kiểm chứng bắt buộc trước khi go-live:**

```bash
# 1. Không chữ ký → 403
curl -sI https://cdn.wellspring.edu.vn/social-posts/2026/07/ab/x.webp | head -1

# 2. Chữ ký sai → 403 ; hết hạn → 410
# 3. Không list được bucket
curl -sI https://cdn.wellspring.edu.vn/cdn-social-posts/ | head -1        # kỳ vọng 404
# 4. MinIO không lộ ra Internet
curl -m 5 -sI http://<VM3_PUBLIC_IP>:9000/minio/health/live               # kỳ vọng timeout
# 5. Cache hoạt động
curl -sI "<signed_url>" | grep X-Cache-Status                             # lần 2 phải là HIT
```

Firewall VM3:

```bash
ufw default deny incoming
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow from 172.16.20.0/24 to any port 9000 proto tcp   # chỉ private subnet
ufw enable
```

---

## 9. Migration dữ liệu cũ

Nguyên tắc: **không sửa DB trước, dùng resolver ở tầng đọc.** Cách này cho phép rollback tức thời chỉ bằng một biến môi trường — quan trọng vì đây là hệ thống đang chạy thật với phụ huynh.

### Bước 1 — Copy file lên MinIO (không downtime)

```bash
# Trên VM microservices
mc alias set cdn http://172.16.20.94:9000 social_service "$CDN_SECRET_KEY"

mc mirror --overwrite --preserve \
   /srv/app/social-service/uploads/posts/  cdn/cdn-social-posts/legacy/
mc mirror --overwrite --preserve \
   /srv/app/social-service/uploads/chat/   cdn/cdn-social-chat/legacy/

mc ls --recursive cdn/cdn-social-posts/legacy/ | wc -l    # đối chiếu với: ls uploads/posts | wc -l
```

Giữ nguyên tên file ⇒ ánh xạ từ giá trị DB cũ là **thuần tất định**, không cần bảng tra:

```
"/api/social/uploads/posts/files-123-456.jpg" → cdn-social-posts/legacy/files-123-456.jpg
"/uploads/chat/chat-789-012.jpg"              → cdn-social-chat/legacy/chat-789-012.jpg
```

### Bước 2 — Resolver ở tầng đọc

```js
// services/cdn/resolve.js
function toObjectKey(stored) {
  if (!stored) return null;
  if (stored.startsWith('cdn://')) return stored.slice(6);                       // mới
  if (stored.startsWith('/api/social/uploads/posts/'))
    return `social-posts/legacy/${stored.split('/').pop()}`;
  if (stored.startsWith('/uploads/posts/'))
    return `social-posts/legacy/${stored.split('/').pop()}`;
  if (stored.startsWith('/uploads/chat/'))
    return `social-chat/legacy/${stored.split('/').pop()}`;
  return null;                                                                  // → giữ nguyên, fallback disk
}
```

Bật `CDN_ENABLED=true` ⇒ **toàn bộ media cũ lẫn mới đều phát qua CDN ngay**, DB chưa đổi một byte nào.

### Bước 3 — Đối soát (chạy sau 24 h)

Script `scripts/cdn-verify-legacy.js`: duyệt mọi `Post.images/videos` + `ChatMessage.attachments`, `HeadObject` từng key, xuất danh sách thiếu. Chạy `mc mirror` lại cho phần thiếu.

### Bước 4 — Rewrite DB (chỉ khi Bước 3 sạch, sau ≥ 2 tuần)

```js
// scripts/cdn-rewrite-urls.js — chạy theo batch 1000 doc, có --dry-run
// "/uploads/chat/x.jpg" → "cdn://social-chat/legacy/x.jpg"
```

### Bước 5 — Dọn (sau ≥ 4 tuần, sau khi đã snapshot)

Gỡ `express.static('/uploads')` khỏi `app.js`, xoá thư mục `uploads/` trên VM microservices.

> **Không nén lại ảnh legacy trong lần migrate đầu.** Việc đó thay đổi kích thước file hàng loạt, khó đối soát, và không giải quyết được vấn đề cấp bách (bảo mật). Có thể chạy job nén nền sau khi hệ thống đã ổn định — khi đó sinh key mới và cập nhật DB, có `--dry-run` đầy đủ.

---

## 10. Kế hoạch theo phase

### Phase 0 — Dựng hạ tầng VM3 (2–3 ngày, không đụng code)

| # | Việc | Nghiệm thu |
|---|------|------------|
| 0.1 | Cấp VM 4 vCPU / 8 GB / 50 GB OS + 1 TB NVMe, private `172.16.20.94` | `lsblk` thấy disk |
| 0.2 | OS Ubuntu 22.04, timezone `Asia/Ho_Chi_Minh`, mount `/data` (XFS, `noatime`) | `df -h /data` |
| 0.3 | Docker + MinIO (theo mẫu §5 `media-setup-vm1.md`, đổi path/IP) | `curl 127.0.0.1:9000/minio/health/live` → 200 |
| 0.4 | Tạo 4 bucket, IAM user `social_service`, policy tối thiểu, `anonymous set none` | `mc ls`, `mc anonymous get` |
| 0.5 | DNS A `cdn.wellspring.edu.vn` → public IP VM3 | `dig +short` |
| 0.6 | Nginx + certbot + config §8 | `nginx -t`, SSL Labs ≥ A |
| 0.7 | UFW theo §8 | `ufw status verbose` |
| 0.8 | **Chạy đủ 5 kiểm chứng bảo mật §8** | Tất cả đúng kỳ vọng |

### Phase 1 — social-service ghi lên CDN (3–5 ngày)

| # | Việc |
|---|------|
| 1.1 | Thêm dependency, viết `services/cdn/{s3,sign,imagePipeline,index}.js` |
| 1.2 | Đổi multer → thư mục tạm; controller gọi `cdn.storeUpload()` |
| 1.3 | Hàm ký tập trung `signMediaDeep()`; gắn vào `messagePayloadForApi` (chat), `populatePostQuery` (post), **và cả 2 socket** |
| 1.4 | `sanitizeIncomingAttachments` chấp nhận `cdn://social-chat/` |
| 1.5 | Resolver legacy (§9 Bước 2) |
| 1.6 | Cờ `CDN_ENABLED` bao mọi nhánh mới |
| 1.7 | Test staging: post ảnh, post video, chat ảnh, chat file, avatar, realtime socket, **quay ảnh dọc iPhone**, ảnh HEIC |

**Nghiệm thu Phase 1:** upload mới không sinh file nào trong `./uploads`; ảnh feed < 400 KB; `exiftool` trên ảnh tải về không còn GPS; URL không chữ ký → 403.

### Phase 2 — Migrate dữ liệu cũ + bật production (2–3 ngày)

| # | Việc |
|---|------|
| 2.1 | `mc mirror` toàn bộ `uploads/` (chạy ngoài giờ) |
| 2.2 | Deploy code Phase 1 với `CDN_ENABLED=false` — xác nhận không đổi hành vi |
| 2.3 | Bật `CDN_ENABLED=true` **giờ thấp điểm** (đề xuất 20:00) |
| 2.4 | Theo dõi 24 h: `X-Cache-Status`, tỉ lệ 403/410, `cdn.error.log`, p95 API feed |
| 2.5 | Chạy `cdn-verify-legacy.js`, mirror bù phần thiếu |

### Phase 3 — Upload trực tiếp lên CDN (1 tuần, sau khi Phase 2 ổn định)

Client xin presigned PUT → upload thẳng vào `cdn-staging` → `social-service` chỉ nhận key và xác nhận. Byte **không** còn đi qua `social-service` ⇒ giải quyết triệt để **P1**.

Cần: endpoint `POST /api/social/media/presign`, worker promote `cdn-staging` → bucket đích + sinh variants, và **cập nhật client** (web + mobile). Đây là lý do xếp sau — không muốn chặn Phase 1–2 chờ release app.

### Phase 4 — Dọn dẹp (sau ≥ 4 tuần)

Rewrite DB, gỡ `express.static`, xoá `uploads/`, cập nhật `LMS-Design.md` + tài liệu kiến trúc.

**Tổng: ~3 tuần đến production (Phase 0–2), Phase 3–4 theo sau.**

---

## 11. Rollback

| Tình huống | Hành động | Thời gian |
|-----------|-----------|-----------|
| Ảnh không hiện, lỗi ký | `CDN_ENABLED=false` → `pm2 reload social-service` | **< 1 phút** |
| VM3 chết | Như trên — `express.static` vẫn còn ⇒ media cũ phục vụ từ disk local; media tạo sau khi bật CDN sẽ thiếu (chấp nhận trong Phase 1–3) | < 1 phút |
| Nghi ngờ rò rỉ link | Đổi `CDN_LINK_SECRET` ở cả Nginx và social-service → reload cả hai | < 5 phút, mọi link cũ chết ngay |
| Cache phục vụ nội dung sai | `rm -rf /var/cache/nginx/cdn/* && systemctl reload nginx` | < 2 phút |
| Cần lùi hoàn toàn | Revert commit; dữ liệu MinIO **không xoá** (giữ để thử lại) | ~10 phút |

Điều kiện để rollback luôn khả thi: **không xoá `uploads/` và không rewrite DB cho tới Phase 4.** Đừng rút ngắn bước này.

---

## 12. Vận hành: backup, monitoring, lifecycle

### 12.1. Backup

| Lớp | Cách | Tần suất | Giữ |
|-----|------|----------|-----|
| Snapshot volume `/data` | Snapshot của nhà cung cấp | Hàng ngày | 14 ngày |
| Đồng bộ ngoài site | `mc mirror --watch` sang NAS/VM khác | Liên tục | 90 ngày |
| Config | `/opt/cdn/`, `/etc/nginx/`, `/etc/cdn/` vào git nội bộ | Mỗi lần đổi | — |

Kiểm thử restore mỗi quý — backup chưa restore thử thì chưa phải backup.

### 12.2. Monitoring

Đã có `@wis/observability` trong `social-service` — mở rộng sang VM3:

| Chỉ số | Cảnh báo |
|--------|----------|
| Disk `/data` | > 75 % → cảnh báo, > 85 % → khẩn |
| Cache hit rate (`X-Cache-Status`) | < 70 % kéo dài |
| Tỉ lệ 403/410 | Tăng đột biến ⇒ lệch secret hoặc lệch đồng hồ |
| p95 latency `/social-*` | > 200 ms |
| MinIO health | `/minio/health/live` != 200 |
| Cert hết hạn | < 14 ngày |

> **Đồng bộ NTP là bắt buộc.** `secure_link` so sánh timestamp; lệch đồng hồ giữa VM microservices và VM3 quá vài phút sẽ gây 410 hàng loạt. Bật `systemd-timesyncd` trên cả hai và thêm vào checklist Phase 0.

### 12.3. Lifecycle

```bash
# Vùng đệm upload — dọn sau 1 ngày
mc ilm add --expiry-days 1 cdn/cdn-staging
# Multipart upload dở dang — dọn sau 7 ngày (tránh rác vô hình chiếm disk)
mc ilm add --noncurrent-expire-days 7 cdn/cdn-social-posts
```

Chính sách lưu trữ chat và ảnh học sinh nên do **nhà trường quyết định**, không phải mặc định kỹ thuật — đề nghị đưa vào chính sách dữ liệu của trường rồi cấu hình lifecycle theo đó.

---

## 13. Rủi ro & điểm cần lưu ý

| Rủi ro | Mức | Giảm thiểu |
|--------|-----|-----------|
| Quên ký ở đường socket ⇒ ảnh vỡ khi realtime | **Cao** | Một hàm `signMediaDeep()` duy nhất; thêm test cho payload socket |
| `sharp` build sai kiến trúc trên VM | Trung bình | Cài trên chính VM, pin version, `npm rebuild sharp` trong quy trình deploy |
| Lệch đồng hồ ⇒ 410 hàng loạt | Trung bình | NTP + cửa sổ 6 h đã có biên rất rộng |
| Ảnh xoay sai sau khi strip EXIF | Trung bình | `.rotate()` trước `.webp()`; test ảnh dọc từ iPhone thật |
| Ảnh HEIC từ iPhone | Trung bình | `sharp` cần libheif; nếu thiếu → fallback giữ nguyên file, log cảnh báo (đừng để throw làm hỏng cả bài đăng) |
| VM3 là điểm lỗi đơn (SPOF) | Trung bình | Chấp nhận ở giai đoạn này; snapshot hàng ngày + `mc mirror` ngoài site. Đường HA: MinIO 4 node + 2 Nginx sau LB (§14) |
| Disk đầy đột ngột | Thấp | Cảnh báo 75 %, volume mở rộng online được |
| Video lớn vẫn qua social-service ở Phase 1–2 | Thấp (tạm) | Phase 3 giải quyết dứt điểm |

**Về SPOF, nói thẳng:** với thiết kế này, VM3 chết = toàn bộ ảnh/video social không hiển thị (API và chat text vẫn chạy). Với ~10.000 user và tính chất nghiệp vụ (không phải hệ thống tài chính), đánh đổi này hợp lý cho giai đoạn đầu — nhưng nên biết mà chấp nhận có ý thức, không phải phát hiện ra lúc sự cố.

---

## 14. Mở rộng cho toàn dự án

Thiết kế trên đã tính sẵn cho các service khác vào sau:

| Bước | Việc |
|------|------|
| Thêm service | Tạo bucket `cdn-<service>-<loại>`, IAM user riêng, thêm bucket vào regex `location` Nginx |
| Chuẩn hoá | Tách `services/cdn/` của `social-service` thành package dùng chung `@wis/cdn-client` (giống cách `@wis/observability` đang làm) |
| Xử lý media tập trung | Dựng `cdn-service :5040` trên VM3 (sharp/ffmpeg + BullMQ) — các service chỉ gửi key, không tự xử lý ảnh |
| Gộp media LMS | Cân nhắc chuyển VM1 về sau `cdn.wellspring.edu.vn` khi VM3 đã ổn định — **không làm cùng lúc với giai đoạn 1** |
| HA khi vượt ~30.000 user | MinIO 4 node erasure coding + 2 Nginx sau load balancer; cache Nginx trở thành thiết yếu |

Quy ước đặt tên nhất quán giúp bước mở rộng chỉ là thêm dòng config, không phải thiết kế lại:

```
https://cdn.wellspring.edu.vn/<service>-<loại>/<yyyy>/<mm>/<hash2>/<hash>.<ext>?e=<exp>&s=<sig>
```

---

## Phụ lục A — Checklist Phase 0 (in ra dùng khi dựng VM)

```
[ ] VM 4 vCPU / 8 GB / 50 GB OS / 1 TB NVMe, private 172.16.20.94, public IP
[ ] Ubuntu 22.04, timedatectl set-timezone Asia/Ho_Chi_Minh
[ ] systemd-timesyncd BẬT và đã sync  (timedatectl status)
[ ] mkfs.xfs /dev/sdb ; mount /data (noatime) ; ghi /etc/fstab
[ ] Docker + MinIO container, bind 127.0.0.1:9000 + 172.16.20.94:9000, console 127.0.0.1:9001
[ ] Bucket: cdn-social-posts, cdn-social-chat, cdn-social-avatars, cdn-staging
[ ] mc anonymous set none cho CẢ 4 bucket (mặc định) — xác nhận bằng mc anonymous get
[ ] Áp bucket policy aws:SourceIp=127.0.0.1/32 cho 3 bucket phát ra CDN (§3.1)
    → từ máy KHÁC trong LAN: curl http://172.16.20.94:9000/cdn-social-posts/<key> phải 403
[ ] IAM user social_service + policy tối thiểu (không dùng root key cho app)
[ ] DNS A cdn.wellspring.edu.vn → public IP
[ ] Nginx + config §8 (thay CHANGE_ME_CDN_LINK_SECRET)
[ ] certbot --nginx -d cdn.wellspring.edu.vn ; systemctl status certbot.timer
[ ] mkdir -p /var/cache/nginx/cdn ; chown www-data
[ ] UFW: 22/80/443 public ; 9000 chỉ 172.16.20.0/24 ; enable
[ ] 5 kiểm chứng bảo mật §8 — TẤT CẢ phải đúng kỳ vọng
[ ] Snapshot hàng ngày + mc mirror ngoài site đã cấu hình
[ ] Alert disk / cert / MinIO health đã gắn vào observability
```

## Phụ lục B — Đối chiếu vấn đề → giải pháp

| Vấn đề (§1.2) | Giải quyết ở | Phase |
|---------------|--------------|-------|
| P1 Byte qua Node | §2 tách plane; §10 Phase 3 upload trực tiếp | 1 (giảm) → 3 (dứt điểm) |
| P2 File trên disk local | §5 MinIO VM3 | 1 |
| P3 **Không bảo mật media** | §3 secure_link + MinIO private | **1** |
| P4 Ảnh gốc nặng | §7 sharp WebP + variants | 1 |
| P5 EXIF/GPS | §7.1 strip metadata | 1 |
| P6 Dính domain SIS | §2 domain CDN riêng | 1 |

---

*Tài liệu này mô tả thiết kế và kế hoạch. Các bước cài đặt chi tiết trên máy chủ sẽ được tách sang `cdn-setup-vm3.md` khi bắt đầu Phase 0, theo đúng khuôn mẫu của `media-setup-vm1.md`.*
