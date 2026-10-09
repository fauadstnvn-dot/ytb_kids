import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectFtp, deleteRemote, download, findMatchingMp3, listFiles, normalizeDir, pickRandom } from "./ftp.mjs";
import { buildAudio, renderVideo, validateStory } from "./render.mjs";
import { buildYouTubeMeta, loadStory, retimeSegments } from "./story.mjs";
import { synthesizeNarration } from "./tts.mjs";
import { DB_ENV, loadCredentialPool } from "./credentials.mjs";
import { uploadWithCredentialPool } from "./publish.mjs";
import { probeDuration, StepError, StoryError, envNum, envStr, formatBytes, formatTimestamp, log, requireEnv } from "./utils.mjs";

// Đường dẫn FTP lấy từ GitHub Secret, không ghi cứng trong code và không in ra log để người khác không biết vị trí lưu trữ.
const STORY_DIR = normalizeDir(envStr("STORY_DIR", ""));
const MUSIC_DIR = normalizeDir(envStr("MUSIC_DIR", ""));
const MP3_DIR = normalizeDir(envStr("MP3_DIR", ""));
const WIDTH = envNum("VIDEO_WIDTH", 2560);
const HEIGHT = envNum("VIDEO_HEIGHT", 1440);
const FPS = envNum("VIDEO_FPS", 30);
const DRY_RUN = envStr("DRY_RUN", "false") === "true";

async function summary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n").catch(() => {});
}

async function pickMusic(musicLocal) {
  const ftp = await connectFtp("Đăng nhập FTP");
  try {
    const musics = await listFiles(ftp, MUSIC_DIR, [".mp3"], "Lấy danh sách nhạc nền", "MUSIC_DIR");
    if (!musics.length) throw new StepError("Lấy danh sách nhạc nền", "Thư mục nhạc nền (secret MUSIC_DIR) không có file .mp3 nào.");
    const musicFile = pickRandom(musics);
    log.info(`Có ${musics.length} nhạc nền, chọn: ${musicFile.name} (${formatBytes(musicFile.size)})`);
    await download(ftp, musicFile.remotePath, musicLocal, "Tải nhạc nền");
    return musicFile;
  } finally {
    ftp.close();
  }
}

/** Kết nối lại mỗi lần (phiên cũ có thể đã hết hạn trong lúc dựng), bỏ qua các kịch bản đã biết là lỗi. */
async function pickStory(workDir, broken) {
  const ftp = await connectFtp("Đăng nhập FTP");
  try {
    const skip = new Set(broken.map((b) => b.name));
    const stories = (await listFiles(ftp, STORY_DIR, [".js"], "Lấy danh sách kịch bản", "STORY_DIR")).filter((f) => !skip.has(f.name));
    if (!stories.length) {
      const detail = broken.length
        ? `Đã thử ${broken.length} kịch bản nhưng đều lỗi và đã ${DRY_RUN ? "bỏ qua" : "xoá"}:\n` +
          broken.map((b) => `  - ${b.name} — ${b.reason}`).join("\n") +
          "\nKhông còn kịch bản hợp lệ nào trong thư mục kịch bản (secret STORY_DIR). Hãy tải thêm kịch bản .js lên FTP."
        : "Không còn kịch bản .js nào trong thư mục kịch bản (secret STORY_DIR). Hãy tải thêm kịch bản lên FTP.";
      throw new StepError("Chọn kịch bản", detail);
    }
    const storyFile = pickRandom(stories);
    log.info(`Còn ${stories.length} kịch bản, chọn: ${storyFile.name} (${formatBytes(storyFile.size)})`);
    storyFile.localPath = path.join(workDir, `story-${broken.length + 1}.js`);
    await download(ftp, storyFile.remotePath, storyFile.localPath, "Tải kịch bản");
    return storyFile;
  } finally {
    ftp.close();
  }
}

/** Nếu list_mp3 có file trùng tên kịch bản thì tải về và dùng thay cho Google TTS. */
async function fetchCustomVoice(storyName, workDir) {
  const ftp = await connectFtp("Đăng nhập FTP");
  try {
    const hit = MP3_DIR ? await findMatchingMp3(ftp, MP3_DIR, path.basename(storyName, ".js")) : null;
    if (!hit) return null;
    const local = path.join(workDir, "custom-voice.mp3");
    await download(ftp, hit.remotePath, local, "Tải mp3 giọng đọc riêng");
    log.info(`Tìm thấy mp3 trùng tên kịch bản: ${hit.name} (${formatBytes(hit.size)}), bỏ qua Google TTS.`);
    return local;
  } finally {
    ftp.close();
  }
}

async function buildVideo(storyFile, musicLocal, baseDir, attempt) {
  const workDir = path.join(baseDir, `try-${attempt}`);
  await fs.mkdir(workDir, { recursive: true });

  log.step("4. Đọc và vẽ thử kịch bản");
  const code = await fs.readFile(storyFile.localPath, "utf8");
  const story = loadStory(code, storyFile.name);
  log.info(`Số cảnh: ${story.segments.length}`);
  validateStory(story);

  const metaName = path.basename(storyFile.name, ".js");
  let meta = buildYouTubeMeta(story, metaName);
  if (!meta.title) throw new StoryError("Đọc kịch bản", "Kịch bản không có YOUTUBE_METADATA.title.");
  log.info(`Tiêu đề YouTube: ${meta.title}`);
  log.info(`Số tag: ${meta.tags.length}`);

  const customVoice = await fetchCustomVoice(storyFile.name, workDir);
  let duration;
  if (customVoice) {
    log.step("5. Dùng mp3 riêng thay cho Google TTS");
    story.segments.forEach((s) => (s.narration = null));
    const mp3Duration = await probeDuration(customVoice, "Đọc mp3 giọng đọc riêng");
    duration = retimeSegments(story.segments, mp3Duration + 1);
    log.info(`Thời lượng mp3: ${mp3Duration.toFixed(1)}s, video: ${formatTimestamp(duration)} (${duration.toFixed(1)}s)`);
  } else {
    log.step("5. Tạo giọng đọc TTS cho từng cảnh");
    await synthesizeNarration(story.segments, workDir);
    duration = retimeSegments(story.segments);
    log.info(`Tổng thời lượng sau khi căn theo giọng đọc: ${formatTimestamp(duration)} (${duration.toFixed(1)}s)`);
  }

  // Phải dựng lại mô tả SAU retimeSegments: trước đó mọi seg.start = 0 nên chapters đều là 0:00.
  meta = buildYouTubeMeta(story, metaName);

  log.step("6. Trộn nhạc nền + giọng đọc");
  const audio = await buildAudio(story.segments, musicLocal, duration, workDir, customVoice);

  log.step("7. Dựng video 2K bằng canvas + ffmpeg");
  const video = await renderVideo(story, audio, duration, workDir, { width: WIDTH, height: HEIGHT, fps: FPS });
  return { meta, video, duration };
}

async function main() {
  log.step("1. Kiểm tra cấu hình");
  requireEnv(["FTP_HOST", "FTP_USER", "FTP_PASS"], "Kiểm tra cấu hình");
  if (!DRY_RUN) {
    requireEnv(DB_ENV, "Kiểm tra cấu hình");
    // Kiểm tra sớm để không mất hàng giờ dựng video rồi mới phát hiện DB không kết nối được.
    const { credentials, tokenColumn } = await loadCredentialPool();
    if (!credentials.length) {
      throw new StepError("Kiểm tra cấu hình", `Bảng secret không có dòng nào active=1 với ${tokenColumn} chứa refresh_token hợp lệ.`);
    }
    log.info(`MySQL OK: ${credentials.length} bộ YouTube secret sẵn sàng (cột ${tokenColumn}).`);
  }
  requireEnv(["STORY_DIR", "MUSIC_DIR"], "Kiểm tra cấu hình");
  log.info(`Thư mục FTP: lấy từ secret STORY_DIR, MUSIC_DIR${MP3_DIR ? ", MP3_DIR" : " (không đặt MP3_DIR → luôn dùng Google TTS)"}.`);
  log.info(`Độ phân giải: ${WIDTH}x${HEIGHT} @${FPS}fps${DRY_RUN ? " (DRY_RUN: không upload, không xoá)" : ""}`);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "story-video-"));
  const musicLocal = path.join(workDir, "music.mp3");

  log.step("2. Đăng nhập FTP và chọn ngẫu nhiên nhạc nền");
  const musicFile = await pickMusic(musicLocal);

  // Kịch bản hỏng (không chạy/không vẽ được bằng canvas) -> xoá và chọn kịch bản khác.
  // Mọi lỗi khác (FTP, TTS, ffmpeg, YouTube...) vẫn dừng ngay và báo nguyên nhân.
  const broken = [];
  let storyFile;
  let built;
  for (let attempt = 1; ; attempt++) {
    log.step(`3. Chọn ngẫu nhiên kịch bản (lần ${attempt})`);
    storyFile = await pickStory(workDir, broken);
    try {
      built = await buildVideo(storyFile, musicLocal, workDir, attempt);
      break;
    } catch (e) {
      if (!(e instanceof StoryError)) throw e;
      log.warn(`Kịch bản "${storyFile.name}" bị lỗi ở bước "${e.step}": ${e.message}`);
      if (DRY_RUN) {
        log.warn("DRY_RUN: không xoá, chỉ bỏ qua kịch bản này.");
      } else {
        await deleteRemote(storyFile.remotePath, "Xoá kịch bản bị lỗi trên FTP");
      }
      broken.push({ name: storyFile.name, reason: `${e.step}: ${e.message.split("\n")[0]}` });
      log.info("Chọn kịch bản khác...");
    }
  }
  const { meta, video, duration } = built;
  const brokenLines = broken.length
    ? [`- Kịch bản lỗi đã ${DRY_RUN ? "bỏ qua" : "xoá"} (${broken.length}):`, ...broken.map((b) => `  - \`${b.name}\` — ${b.reason}`)]
    : [];

  if (DRY_RUN) {
    const keep = path.resolve("output.mp4");
    await fs.copyFile(video, keep);
    log.info(`DRY_RUN: đã lưu ${keep}, bỏ qua upload và xoá kịch bản.`);
    await summary([`### DRY_RUN: ${meta.title}`, `- Kịch bản: \`${storyFile.name}\``, `- Nhạc nền: \`${musicFile.name}\``, ...brokenLines]);
    return;
  }

  log.step("8. Upload lên YouTube");
  const result = await uploadWithCredentialPool(video, meta);
  log.info(`Upload thành công bằng secret ${result.credential.label}: ${result.url}`);

  log.step("9. Xoá kịch bản đã dùng trên FTP");
  await deleteRemote(storyFile.remotePath, "Xoá kịch bản trên FTP");

  await summary([
    `### Đã upload: [${meta.title}](${result.url})`,
    `- Kịch bản: \`${storyFile.name}\` (đã xoá khỏi FTP)`,
    `- Nhạc nền: \`${musicFile.name}\``,
    `- Thời lượng: ${formatTimestamp(duration)} — ${WIDTH}x${HEIGHT} @${FPS}fps`,
    `- Tag đã dùng (${result.tags.length}): ${result.tags.join(", ") || "(không)"}`,
    `- Secret đã dùng: ${result.credential.label}`,
    ...(result.failures.length
      ? [`- Secret bị bỏ qua (${result.failures.length}):`, ...result.failures.map((f) => `  - ${f.label} — ${f.reason}`)]
      : []),
    ...brokenLines,
  ]);
  log.step("HOÀN TẤT");
  await fs.rm(workDir, { recursive: true, force: true });
}

main().catch(async (e) => {
  const step = e instanceof StepError ? e.step : "Lỗi không xác định";
  console.log(`\n========== THẤT BẠI ==========`);
  console.log(`Bước lỗi : ${step}`);
  console.log(`Nguyên nhân: ${e.message}`);
  if (!(e instanceof StepError) && e.stack) console.log(e.stack);
  log.error(step, e.message);
  await summary([`### Thất bại ở bước: ${step}`, "```", String(e.message).slice(0, 3000), "```"]);
  process.exit(1);
});
