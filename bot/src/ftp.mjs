import { randomInt } from "node:crypto";
import path from "node:path";
import { Client } from "basic-ftp";
import { StepError, envNum, envStr, log } from "./utils.mjs";

function ftpOptions() {
  const secureRaw = envStr("FTP_SECURE", "false").toLowerCase();
  const secure = secureRaw === "implicit" ? "implicit" : ["1", "true", "yes"].includes(secureRaw);
  return {
    host: process.env.FTP_HOST.trim(),
    port: envNum("FTP_PORT", 21),
    user: process.env.FTP_USER.trim(),
    password: process.env.FTP_PASS,
    secure,
    secureOptions: secure ? { rejectUnauthorized: false } : undefined,
  };
}

export async function connectFtp(step) {
  const client = new Client(60_000);
  const opts = ftpOptions();
  try {
    await client.access(opts);
    return client;
  } catch (e) {
    client.close();
    const hint =
      e.code === 530
        ? "Sai user hoặc mật khẩu FTP (FTP_USER / FTP_PASS)."
        : e.code === "ENOTFOUND" || e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT"
          ? `Không kết nối được tới ${opts.host}:${opts.port}. Kiểm tra FTP_HOST / FTP_PORT và firewall của hosting.`
          : "Kiểm tra lại FTP_HOST, FTP_USER, FTP_PASS (và FTP_SECURE nếu host bắt buộc FTPS).";
    throw new StepError(step, `Đăng nhập FTP thất bại: ${e.message}. ${hint}`, e);
  }
}

export async function listFiles(client, dir, exts, step) {
  try {
    const items = await client.list(dir);
    return items
      .filter((f) => f.isFile && exts.some((x) => f.name.toLowerCase().endsWith(x)))
      .map((f) => ({ name: f.name, size: f.size, remotePath: path.posix.join(dir, f.name) }));
  } catch (e) {
    throw new StepError(step, `Không đọc được thư mục FTP: ${e.message}. Kiểm tra đường dẫn trong secret có tồn tại không.`, e);
  }
}

export function pickRandom(list) {
  return list[randomInt(list.length)];
}

export async function download(client, remotePath, localPath, step) {
  try {
    await client.downloadTo(localPath, remotePath);
  } catch (e) {
    throw new StepError(step, `Tải file "${path.posix.basename(remotePath)}" từ FTP thất bại: ${e.message}`, e);
  }
}

/** Kết nối lại (phiên cũ có thể đã bị ngắt trong lúc dựng video) rồi xoá file. */
export async function deleteRemote(remotePath, step) {
  const client = await connectFtp(step);
  try {
    await client.remove(remotePath);
    log.info(`Đã xoá kịch bản trên FTP: ${path.posix.basename(remotePath)}`);
  } catch (e) {
    throw new StepError(step, `Xoá file "${path.posix.basename(remotePath)}" trên FTP thất bại: ${e.message}. Hãy xoá thủ công để tránh upload trùng.`, e);
  } finally {
    client.close();
  }
}

/** Tìm file .mp3 trùng tên (không phân biệt hoa/thường, bỏ đuôi) với kịch bản trong thư mục `dir`. Không có thì trả về null. */
export async function findMatchingMp3(client, dir, storyBaseName) {
  let items;
  try {
    items = await client.list(dir);
  } catch (e) {
    log.warn(`Không đọc được thư mục mp3 riêng (secret MP3_DIR): ${e.message}. Dùng Google TTS.`);
    return null;
  }
  const want = storyBaseName.trim().toLowerCase();
  const hit = items.find((f) => f.isFile && f.name.toLowerCase().endsWith(".mp3") && f.name.slice(0, -4).trim().toLowerCase() === want);
  return hit ? { name: hit.name, size: hit.size, remotePath: path.posix.join(dir, hit.name) } : null;
}
