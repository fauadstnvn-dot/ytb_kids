import fs from "node:fs";
import { StepError, formatBytes, log, sleep } from "./utils.mjs";

const STEP = "Upload YouTube";
const CHUNK_SIZE = 32 * 1024 * 1024; // bội số của 256 KB theo yêu cầu của YouTube resumable upload
const CATEGORY_FILM_ANIMATION = "1";

export class TagError extends Error {}

async function readJson(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function describeApiError(status, json, text) {
  const err = json?.error;
  const reasons = (err?.errors || []).map((e) => e.reason).filter(Boolean);
  const message = err?.message || text?.slice(0, 500) || "(không có nội dung)";
  return { reasons, message, summary: `HTTP ${status}${reasons.length ? ` [${reasons.join(", ")}]` : ""}: ${message}` };
}

function isTagError({ reasons, message }) {
  return reasons.some((r) => /invalidTags|tags/i.test(r)) || /\b(tags?|keywords?)\b/i.test(message);
}

function explain({ reasons, message }) {
  if (reasons.includes("quotaExceeded") || reasons.includes("dailyLimitExceeded"))
    return "Đã hết quota YouTube Data API trong ngày (mỗi lần upload tốn 1600 đơn vị, mặc định 10.000/ngày). Đợi sang ngày mới (giờ Thái Bình Dương) hoặc xin tăng quota.";
  if (reasons.includes("uploadLimitExceeded"))
    return "Kênh đã vượt giới hạn số video được upload trong ngày. Thử lại sau 24 giờ.";
  if (reasons.includes("youtubeSignupRequired"))
    return "Tài khoản Google chưa tạo kênh YouTube.";
  if (reasons.includes("forbidden") || reasons.includes("insufficientPermissions"))
    return "Token không có quyền upload. Hãy tạo lại refresh token với scope https://www.googleapis.com/auth/youtube.upload.";
  if (reasons.includes("invalidTitle")) return "Tiêu đề không hợp lệ (rỗng, > 100 ký tự hoặc chứa < >).";
  if (reasons.includes("invalidDescription")) return "Mô tả không hợp lệ (> 5000 byte hoặc chứa < >).";
  return message;
}

/**
 * Lỗi gắn với 1 bộ secret cụ thể (hết quota, token bị thu hồi, sai client...).
 * Gặp lỗi này thì đổi sang dòng secret khác trong DB; mọi lỗi khác vẫn dừng ngay.
 */
export class CredentialError extends StepError {
  constructor(kind, message) {
    super(STEP, message);
    this.name = "CredentialError";
    this.kind = kind;
  }
}

const QUOTA_REASONS = ["quotaExceeded", "dailyLimitExceeded", "uploadLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"];
const ACCOUNT_REASONS = ["authError", "forbidden", "insufficientPermissions", "youtubeSignupRequired"];

function credentialErrorFrom(status, info, prefix) {
  const text = `${prefix} — ${info.summary}\nNguyên nhân: ${explain(info)}`;
  if (info.reasons.some((r) => QUOTA_REASONS.includes(r)) || (status === 403 && /quota|limit/i.test(info.message))) {
    return new CredentialError("quota", text);
  }
  if (status === 401 || info.reasons.some((r) => ACCOUNT_REASONS.includes(r))) {
    return new CredentialError("account", text);
  }
  return null;
}

/** Đổi refresh token lấy access token. Trả về nguyên response của Google để lưu lại vào DB. */
export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  let res;
  try {
    res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new StepError(STEP, `Không gọi được Google OAuth: ${e.message}`, e);
  }
  const { json, text } = await readJson(res);
  if (!res.ok || !json?.access_token) {
    const code = json?.error;
    const detail = `Lấy access token thất bại (HTTP ${res.status}: ${json?.error_description || code || text.slice(0, 300)})`;
    if (code === "invalid_grant") {
      throw new CredentialError(
        "account",
        `${detail}. Refresh token đã hết hạn hoặc bị thu hồi. Nếu OAuth consent screen đang ở chế độ "Testing", token chỉ sống 7 ngày — hãy chuyển sang "In production" rồi chạy lại \`npm run token\` và cập nhật lại cột token trong DB.`
      );
    }
    if (code === "invalid_client" || code === "unauthorized_client") {
      throw new CredentialError("account", `${detail}. client_id / client_secret sai hoặc không khớp với client đã dùng để tạo refresh token.`);
    }
    if (res.status === 429) throw new CredentialError("quota", `${detail}. Google OAuth đang giới hạn tần suất.`);
    throw new StepError(STEP, `${detail}.`);
  }
  return json;
}

async function initiate(token, meta, size) {
  const body = {
    snippet: {
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      categoryId: CATEGORY_FILM_ANIMATION,
    },
    status: {
      privacyStatus: "public",
      selfDeclaredMadeForKids: true,
      embeddable: true,
      license: "youtube",
    },
  };
  const res = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size),
      "X-Upload-Content-Type": "video/mp4",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.ok && res.headers.get("location")) return res.headers.get("location");
  const { json, text } = await readJson(res);
  const info = describeApiError(res.status, json, text);
  if (isTagError(info)) throw new TagError(info.summary);
  throw credentialErrorFrom(res.status, info, "Khởi tạo upload thất bại") ||
    new StepError(STEP, `Khởi tạo upload thất bại — ${info.summary}\nNguyên nhân: ${explain(info)}`);
}

async function queryOffset(token, uploadUrl, size) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Range": `bytes */${size}`, "Content-Length": "0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 308) {
    const range = res.headers.get("range");
    return { offset: range ? Number(range.split("-")[1]) + 1 : 0 };
  }
  if (res.status === 200 || res.status === 201) return { done: (await readJson(res)).json };
  const { json, text } = await readJson(res);
  throw new StepError(STEP, `Không khôi phục được phiên upload — ${describeApiError(res.status, json, text).summary}`);
}

async function sendFile(token, uploadUrl, file, size) {
  const fd = fs.openSync(file, "r");
  try {
    let offset = 0;
    let failures = 0;
    let lastPct = -1;
    while (offset < size) {
      const len = Math.min(CHUNK_SIZE, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      let res;
      try {
        res = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "video/mp4",
            "Content-Length": String(len),
            "Content-Range": `bytes ${offset}-${offset + len - 1}/${size}`,
          },
          body: buf,
          signal: AbortSignal.timeout(15 * 60_000),
        });
      } catch (e) {
        if (++failures > 5) throw new StepError(STEP, `Mất kết nối khi upload quá 5 lần: ${e.message}`, e);
        log.warn(`Lỗi mạng khi upload (${e.message}) — thử lại lần ${failures}`);
        await sleep(5000 * failures);
        const q = await queryOffset(token, uploadUrl, size);
        if (q.done) return q.done;
        offset = q.offset;
        continue;
      }

      if (res.status === 308) {
        const range = res.headers.get("range");
        offset = range ? Number(range.split("-")[1]) + 1 : offset;
        failures = 0;
      } else if (res.status === 200 || res.status === 201) {
        return (await readJson(res)).json;
      } else if (res.status >= 500) {
        if (++failures > 5) {
          const { json, text } = await readJson(res);
          throw new StepError(STEP, `YouTube lỗi máy chủ liên tục — ${describeApiError(res.status, json, text).summary}`);
        }
        log.warn(`YouTube trả HTTP ${res.status} — thử lại lần ${failures}`);
        await sleep(5000 * failures);
        const q = await queryOffset(token, uploadUrl, size);
        if (q.done) return q.done;
        offset = q.offset;
        continue;
      } else {
        const { json, text } = await readJson(res);
        const info = describeApiError(res.status, json, text);
        if (isTagError(info)) throw new TagError(info.summary);
        throw credentialErrorFrom(res.status, info, "Upload dữ liệu video thất bại") ||
          new StepError(STEP, `Upload dữ liệu video thất bại — ${info.summary}\nNguyên nhân: ${explain(info)}`);
      }

      const pct = Math.floor((offset / size) * 100);
      if (pct >= lastPct + 10 || offset >= size) {
        lastPct = pct;
        log.info(`  Đã gửi ${formatBytes(offset)} / ${formatBytes(size)} (${pct}%)`);
      }
    }
    const q = await queryOffset(token, uploadUrl, size);
    if (q.done) return q.done;
    throw new StepError(STEP, "Đã gửi hết dữ liệu nhưng YouTube không xác nhận hoàn tất.");
  } finally {
    fs.closeSync(fd);
  }
}

const FALLBACK_TAG_COUNT = 5;

/**
 * Chọn danh sách tag cho lần thử kế tiếp sau khi YouTube báo lỗi tag:
 *  - Sau lần 1 lỗi: bỏ 1 tag cuối.
 *  - Sau lần 2 vẫn lỗi: chỉ giữ 5 tag đầu tiên.
 *  - Sau đó nếu vẫn lỗi: tiếp tục bỏ từng tag cuối cho tới khi được.
 */
function nextTags(tags, failedAttempt) {
  if (failedAttempt === 2 && tags.length > FALLBACK_TAG_COUNT) {
    return { tags: tags.slice(0, FALLBACK_TAG_COUNT), note: `chỉ giữ ${FALLBACK_TAG_COUNT} tag đầu tiên` };
  }
  return { tags: tags.slice(0, -1), note: `bỏ tag "${tags[tags.length - 1]}"` };
}

/**
 * Upload đúng 1 video bằng 1 access token. Lỗi tag bị YouTube từ chối trước khi video được tạo,
 * nên thử lại với tag mới không sinh video trùng. Lỗi quota/tài khoản -> CredentialError để đổi secret.
 * Lỗi khác -> dừng và báo nguyên nhân.
 */
export async function uploadVideo(file, meta, token) {
  const size = fs.statSync(file).size;
  log.info(`Kích thước video: ${formatBytes(size)}`);
  log.info(`Tiêu đề: ${meta.title}`);
  log.info(`Danh mục: Film & Animation | Dành cho trẻ em: Có | Chế độ: Public`);

  let tags = [...meta.tags];
  for (let attempt = 1; ; attempt++) {
    log.info(`Lần ${attempt}: upload với ${tags.length} tag (tổng ${tags.join(",").length} ký tự): ${tags.join(" | ") || "(không tag)"}`);
    try {
      const uploadUrl = await initiate(token, { ...meta, tags }, size);
      const video = await sendFile(token, uploadUrl, file, size);
      if (!video?.id) throw new StepError(STEP, `YouTube không trả về ID video: ${JSON.stringify(video).slice(0, 500)}`);
      return { id: video.id, url: `https://www.youtube.com/watch?v=${video.id}`, tags };
    } catch (e) {
      if (!(e instanceof TagError)) throw e;
      if (!tags.length) {
        throw new StepError(STEP, `YouTube vẫn báo lỗi tag dù đã bỏ hết tag: ${e.message}`);
      }
      const next = nextTags(tags, attempt);
      tags = next.tags;
      log.warn(`Lần ${attempt}: YouTube từ chối tag (${e.message}). Thử lại: ${next.note}.`);
    }
  }
}
