import { MAX_NUM, loadCredentialPool, markUploadSuccess, saveRefreshedToken } from "./credentials.mjs";
import { StepError, log } from "./utils.mjs";
import { CredentialError, getAccessToken, uploadVideo } from "./youtube.mjs";

const STEP = "Upload YouTube";

/**
 * Lấy danh sách secret từ MySQL (đã xáo ngẫu nhiên) rồi thử lần lượt:
 *  - Chỉ chọn các dòng num < MAX_NUM (mặc định 9). Nếu mọi dòng đều đạt MAX_NUM -> reset num = 0 cho tất cả.
 *  - Thành công -> num + 1, last_used_at = NOW() cho dòng đó, kết thúc.
 *  - Hết quota / giới hạn upload / token hỏng (CredentialError) -> ghi lại lý do, chuyển sang dòng ngẫu nhiên kế tiếp.
 *  - Lỗi khác (mạng, file video, metadata...) -> dừng ngay vì đổi secret cũng không giải quyết được.
 * Danh sách được đọc NGAY TRƯỚC khi upload (không phải lúc bắt đầu) để dùng dữ liệu mới nhất sau hàng giờ dựng video.
 */
export async function uploadWithCredentialPool(file, meta, thumbnail = null) {
  const { credentials, total, tokenColumn } = await loadCredentialPool();
  if (!credentials.length) {
    throw new StepError(STEP, `Không có dòng secret hợp lệ nào (active=1, có ${tokenColumn}.refresh_token). Tìm thấy ${total} dòng active.`);
  }
  log.info(`Có ${credentials.length} bộ secret hợp lệ (cột ${tokenColumn}). Thứ tự thử ngẫu nhiên: ${credentials.map((c) => c.label).join(" → ")}`);

  const failures = [];
  for (const [index, cred] of credentials.entries()) {
    log.info(`Thử secret ${index + 1}/${credentials.length}: ${cred.label} (num ${cred.num}/${MAX_NUM})`);
    try {
      const tokenResponse = await getAccessToken(cred);
      await saveRefreshedToken(cred, tokenResponse);
      const result = await uploadVideo(file, meta, tokenResponse.access_token, thumbnail);
      await markUploadSuccess(cred);
      return { ...result, credential: cred, failures };
    } catch (e) {
      if (!(e instanceof CredentialError)) throw e;
      const reason = e.message.split("\n")[0];
      failures.push({ label: cred.label, kind: e.kind, reason });
      const left = credentials.length - index - 1;
      log.warn(
        `${cred.label}: ${e.kind === "quota" ? "đã đạt giới hạn" : "secret không dùng được"} — ${reason}` +
          (left ? ` → chọn ngẫu nhiên dòng khác (còn ${left}).` : ".")
      );
    }
  }

  throw new StepError(
    STEP,
    `Đã thử hết ${credentials.length} bộ secret nhưng đều thất bại:\n` +
      failures.map((f) => `  - ${f.label} [${f.kind === "quota" ? "hết quota/giới hạn" : "lỗi tài khoản"}] ${f.reason}`).join("\n") +
      "\nQuota YouTube reset lúc 0h giờ Thái Bình Dương (~14h-15h giờ Việt Nam). Kịch bản chưa bị xoá, lượt sau sẽ dùng lại."
  );
}
