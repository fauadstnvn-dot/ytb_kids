import { randomInt } from "node:crypto";
import mysql from "mysql2/promise";
import { StepError, envNum, envStr, log } from "./utils.mjs";

const STEP = "Lấy YouTube secret từ MySQL";

// Tên bảng/cột không thể truyền qua placeholder "?", nên chỉ cho phép các giá trị trong danh sách trắng.
const ALLOWED_TABLES = new Set(["tb_bao_secret"]);
const ALLOWED_TOKEN_COLUMNS = new Set(["token_kid", "token"]);

const TABLE = envStr("YT_SECRET_TABLE", "tb_bao_secret");
const TOKEN_COLUMN = envStr("YT_TOKEN_COLUMN", "token_kid");
// Mỗi dòng được upload tối đa MAX_NUM lần mỗi vòng. Khi mọi dòng đều đạt MAX_NUM thì reset num = 0 để bắt đầu vòng mới.
export const MAX_NUM = envNum("YT_MAX_NUM", 9);

export const DB_ENV = ["DB_HOST", "DB_USER", "DB_PASS"];

function assertSafeIdentifiers() {
  if (!ALLOWED_TABLES.has(TABLE)) {
    throw new StepError(STEP, `YT_SECRET_TABLE="${TABLE}" không hợp lệ. Cho phép: ${[...ALLOWED_TABLES].join(", ")}.`);
  }
  if (!ALLOWED_TOKEN_COLUMNS.has(TOKEN_COLUMN)) {
    throw new StepError(STEP, `YT_TOKEN_COLUMN="${TOKEN_COLUMN}" không hợp lệ. Cho phép: ${[...ALLOWED_TOKEN_COLUMNS].join(", ")}.`);
  }
}

function dbConfig() {
  return {
    host: process.env.DB_HOST.trim(),
    port: envNum("DB_PORT", 3306),
    user: process.env.DB_USER.trim(),
    password: process.env.DB_PASS,
    database: envStr("DB_NAME", "jj1gcwhyq5o0_thoitiet"),
    charset: "utf8mb4",
    connectTimeout: 20_000,
    ssl: envStr("DB_SSL", "false") === "true" ? { rejectUnauthorized: false } : undefined,
  };
}

function explainDbError(e) {
  switch (e.code) {
    case "ER_ACCESS_DENIED_ERROR":
      return "Sai DB_USER / DB_PASS, hoặc user chưa được cấp quyền trên database này.";
    case "ER_HOST_NOT_PRIVILEGED":
    case "ER_HOST_IS_BLOCKED":
      return "MySQL từ chối IP của GitHub Actions. Vào cPanel → Remote MySQL, thêm Access Host là % (IP của GitHub runner thay đổi liên tục).";
    case "ER_BAD_DB_ERROR":
      return "DB_NAME không tồn tại.";
    case "ER_NO_SUCH_TABLE":
      return `Không có bảng ${TABLE} trong database.`;
    case "ETIMEDOUT":
    case "ECONNREFUSED":
    case "ENOTFOUND":
      return "Không kết nối được tới MySQL. Kiểm tra DB_HOST/DB_PORT và chắc chắn host cho phép kết nối MySQL từ xa (port 3306 mở).";
    default:
      return e.message;
  }
}

/**
 * Mỗi lần thao tác mở 1 kết nối ngắn rồi đóng ngay: quá trình dựng video kéo dài hàng giờ,
 * giữ kết nối lâu sẽ bị host shared ngắt (wait_timeout).
 */
async function withDb(action, fn) {
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig());
  } catch (e) {
    throw new StepError(STEP, `${action}: kết nối MySQL thất bại (${e.code || e.message}). ${explainDbError(e)}`, e);
  }
  try {
    return await fn(conn);
  } catch (e) {
    if (e instanceof StepError) throw e;
    throw new StepError(STEP, `${action}: truy vấn MySQL lỗi (${e.code || e.message}). ${explainDbError(e)}`, e);
  } finally {
    await conn.end().catch(() => {});
  }
}

function parseTokenJson(raw) {
  try {
    const json = JSON.parse(String(raw).trim());
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function fetchUsableRows(conn) {
  const [rows] = await conn.query(
    `SELECT id, ten, client_id, client_secret, \`${TOKEN_COLUMN}\` AS token_json, num
       FROM \`${TABLE}\`
      WHERE active = 1 AND TRIM(client_id) <> '' AND TRIM(client_secret) <> '' AND TRIM(\`${TOKEN_COLUMN}\`) <> ''`
  );
  const valid = [];
  const invalid = [];
  for (const row of rows) {
    const tokenJson = parseTokenJson(row.token_json);
    const refreshToken = tokenJson?.refresh_token?.trim();
    const label = `#${row.id}${row.ten ? ` (${row.ten})` : ""}`;
    if (!refreshToken) {
      invalid.push(label);
      continue;
    }
    valid.push({
      id: row.id,
      label,
      clientId: row.client_id.trim(),
      clientSecret: row.client_secret.trim(),
      refreshToken,
      tokenJson,
      num: Number(row.num) || 0,
    });
  }
  return { valid, invalid, total: rows.length };
}

/**
 * Chỉ xét các dòng bot thực sự dùng được (active=1, token hợp lệ): dòng hỏng/tắt không bao giờ được +1
 * nên nếu tính cả chúng thì sẽ không bao giờ reset.
 */
async function resetIfAllFull(conn, valid) {
  if (!valid.length || valid.some((c) => c.num < MAX_NUM)) return false;
  const [result] = await conn.execute(`UPDATE \`${TABLE}\` SET num = 0`);
  for (const c of valid) c.num = 0;
  log.info(`Tất cả ${valid.length} dòng secret đều đã đạt num >= ${MAX_NUM} → đã reset num = 0 cho ${result.affectedRows} dòng.`);
  return true;
}

/**
 * Đọc các dòng dùng được, reset num nếu tất cả đã đầy, rồi trả về các dòng còn lượt (num < MAX_NUM)
 * theo thứ tự XÁO TRỘN NGẪU NHIÊN. Thử lần lượt theo thứ tự này tương đương
 * "chọn ngẫu nhiên 1 dòng, lỗi thì chọn ngẫu nhiên dòng khác" mà không chọn lại dòng đã thử.
 */
export async function loadCredentialPool() {
  assertSafeIdentifiers();
  const { valid, invalid, total } = await withDb("Đọc danh sách secret", async (conn) => {
    const data = await fetchUsableRows(conn);
    await resetIfAllFull(conn, data.valid);
    return data;
  });

  if (invalid.length) {
    log.warn(`Bỏ qua ${invalid.length} dòng có cột ${TOKEN_COLUMN} không phải JSON hợp lệ hoặc thiếu refresh_token: ${invalid.join(", ")}`);
  }
  const available = valid.filter((c) => c.num < MAX_NUM);
  const full = valid.length - available.length;
  if (full) log.info(`Bỏ qua ${full} dòng đã đạt giới hạn num = ${MAX_NUM} trong vòng này.`);
  return { credentials: shuffle(available), total, tokenColumn: TOKEN_COLUMN };
}

/** Lưu access token mới vào DB (giữ nguyên các trường khác, kể cả refresh_token nếu Google không cấp mới). */
export async function saveRefreshedToken(cred, tokenResponse) {
  const merged = {
    ...cred.tokenJson,
    access_token: tokenResponse.access_token,
    expires_in: tokenResponse.expires_in ?? cred.tokenJson.expires_in,
    scope: tokenResponse.scope ?? cred.tokenJson.scope,
    token_type: tokenResponse.token_type ?? cred.tokenJson.token_type,
    refresh_token: tokenResponse.refresh_token || cred.refreshToken,
    saved_at: Math.floor(Date.now() / 1000),
  };
  try {
    await withDb("Lưu access token mới", (conn) =>
      conn.execute(`UPDATE \`${TABLE}\` SET \`${TOKEN_COLUMN}\` = ? WHERE id = ?`, [JSON.stringify(merged), cred.id])
    );
    cred.tokenJson = merged;
  } catch (e) {
    log.warn(`Không lưu được access token mới cho ${cred.label}: ${e.message}`);
  }
}

/**
 * Upload thành công -> num + 1 cho dòng đó. Nếu sau khi cộng mà mọi dòng đều đạt MAX_NUM thì reset ngay.
 * Lỗi ở đây không được làm hỏng lượt chạy vì video đã lên YouTube.
 */
export async function markUploadSuccess(cred) {
  try {
    await withDb("Cập nhật số lần upload", async (conn) => {
      await conn.execute(`UPDATE \`${TABLE}\` SET num = num + 1, last_used_at = NOW() WHERE id = ?`, [cred.id]);
      cred.num += 1;
      log.info(`${cred.label}: num = ${cred.num}/${MAX_NUM}.`);
      const { valid } = await fetchUsableRows(conn);
      await resetIfAllFull(conn, valid);
    });
  } catch (e) {
    log.warn(`Upload đã thành công nhưng không cập nhật được num/last_used_at cho ${cred.label}: ${e.message}`);
  }
}
