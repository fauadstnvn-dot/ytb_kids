import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import { drawCaption } from "./caption.mjs";
import { browserLikeContext } from "./ctx-compat.mjs";
import { StepError, StoryError, envStr, formatBytes, log, probeDuration, run } from "./utils.mjs";

const AUDIO_STEP = "Trộn nhạc nền + giọng đọc";
const VIDEO_STEP = "Dựng video bằng canvas + ffmpeg";
const MUSIC_VOLUME = 0.12;
const VOICE_VOLUME = 0.95;

const BUNDLED_FONT = fileURLToPath(new URL("../fonts/NotoSans-Regular.ttf", import.meta.url));

let fontsLoaded = false;
function loadFonts() {
  if (fontsLoaded) return;
  if (fs.existsSync(BUNDLED_FONT)) GlobalFonts.registerFromPath(BUNDLED_FONT, "Noto Sans");
  for (const dir of ["/usr/share/fonts", "/usr/local/share/fonts"]) {
    if (fs.existsSync(dir)) GlobalFonts.loadFontsFromDir(dir);
  }
  if (!GlobalFonts.families.length) {
    throw new StepError(VIDEO_STEP, `Không có font nào để vẽ phụ đề. Thiếu file ${BUNDLED_FONT}.`);
  }
  fontsLoaded = true;
}

/**
 * Nhạc nền lặp lại/cắt đúng độ dài video ở mức 12% (như MUSIC_DUCK của index.php),
 * mỗi cảnh chèn giọng đọc đúng mốc bắt đầu của cảnh. Fade-out 2s cuối video.
 */
export async function buildAudio(segments, musicFile, duration, workDir, fullVoiceFile = null) {
  const out = path.join(workDir, "audio.wav");
  const dur = duration.toFixed(3);
  const fadeStart = Math.max(0, duration - 2).toFixed(3);
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", musicFile];
  const voiced = segments.filter((s) => s.narration);
  voiced.forEach((s) => args.push("-i", s.narration.file));
  if (fullVoiceFile) args.push("-i", fullVoiceFile);

  const fmt = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
  // asetpts: -stream_loop làm lệch timestamp mỗi vòng lặp (hụt ~1s/5 phút với mp3 ngắn) -> đánh lại theo số mẫu.
  const filters = [`[0:a]${fmt},asetpts=N/SR/TB,atrim=0:${dur},volume=${MUSIC_VOLUME},afade=t=out:st=${fadeStart}:d=2[m]`];
  const labels = ["[m]"];
  voiced.forEach((s, i) => {
    const ms = Math.round((s.start + (s.lead || 0)) * 1000);
    filters.push(`[${i + 1}:a]${fmt},volume=${VOICE_VOLUME},adelay=${ms}:all=1[v${i}]`);
    labels.push(`[v${i}]`);
  });
  if (fullVoiceFile) {
    // mp3 riêng chạy từ giây 0 đến hết, cùng âm lượng với giọng TTS.
    filters.push(`[${voiced.length + 1}:a]${fmt},volume=${VOICE_VOLUME}[full]`);
    labels.push("[full]");
  }
  filters.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0:dropout_transition=0,apad=whole_dur=${dur}[out]`
  );

  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-t", dur, "-c:a", "pcm_s16le", out);
  await run("ffmpeg", args, { step: AUDIO_STEP });

  const got = await probeDuration(out, AUDIO_STEP);
  if (got < duration - 1) {
    throw new StepError(AUDIO_STEP, `File âm thanh chỉ dài ${got.toFixed(1)}s, cần ${duration.toFixed(1)}s. File nhạc nền có thể bị hỏng.`);
  }
  log.info(`Âm thanh: ${got.toFixed(1)}s (${fullVoiceFile ? "mp3 riêng chạy suốt video" : `${voiced.length} đoạn giọng đọc`}, nhạc nền ${Math.round(MUSIC_VOLUME * 100)}%)`);
  return out;
}

const CHECK_STEP = "Kiểm tra kịch bản bằng canvas";

function isBlank(data) {
  const step = 4 * 997;
  for (let i = step; i < data.length; i += step) {
    if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) return false;
  }
  return true;
}

/**
 * Vẽ thử nhanh (độ phân giải thấp) đầu/giữa/cuối mỗi cảnh trước khi tốn thời gian TTS + dựng 2K.
 * Kịch bản bị coi là hỏng nếu: init() lỗi, có cảnh mà mọi khung thử đều lỗi,
 * quá 30% khung thử lỗi, hoặc mọi khung đều trống (không vẽ ra gì).
 */
export function validateStory(story, { width = 640, height = 360 } = {}) {
  loadFonts();
  const canvas = createCanvas(width, height);
  const rawCtx = canvas.getContext("2d");
  const ctx = browserLikeContext(rawCtx);
  try {
    story.init(ctx, width, height);
  } catch (e) {
    throw new StoryError(CHECK_STEP, `Storyboard.init() lỗi: ${e.message}`, e);
  }

  let samples = 0;
  let errors = 0;
  let drawn = 0;
  let firstError = "";
  for (const seg of story.segments) {
    const d = Math.max(0.1, seg.origDuration || 1);
    let segErrors = 0;
    for (const t of [0, d / 2, Math.max(0, d - 0.05)]) {
      samples++;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      seg.raw.lyric = "";
      rawCtx.save();
      try {
        story.drawScene(seg.raw, t);
        if (!isBlank(rawCtx.getImageData(0, 0, width, height).data)) drawn++;
      } catch (e) {
        errors++;
        segErrors++;
        if (!firstError) firstError = `cảnh "${seg.key}" (t=${t.toFixed(2)}s): ${e.message}`;
      } finally {
        rawCtx.restore();
      }
    }
    if (segErrors === 3) {
      throw new StoryError(CHECK_STEP, `Cảnh "${seg.key}" không vẽ được ở mọi thời điểm thử. Lỗi: ${firstError}`);
    }
  }
  if (errors > samples * 0.3) {
    throw new StoryError(CHECK_STEP, `drawScene() lỗi ở ${errors}/${samples} khung thử. Lỗi đầu tiên tại ${firstError}`);
  }
  if (!drawn) {
    throw new StoryError(CHECK_STEP, `drawScene() chạy nhưng không vẽ ra hình nào (mọi khung thử đều trống).`);
  }
  log.info(`Vẽ thử ${samples} khung: ${samples - errors} OK${errors ? `, ${errors} lỗi (bỏ qua được)` : ""}`);
}

function segAt(segments, time) {
  for (const s of segments) if (time >= s.start && time < s.end) return s;
  return segments[segments.length - 1];
}

/**
 * Vẽ từng khung bằng Canvas 2D (Skia) rồi đẩy pixel RGBA thô vào ffmpeg qua stdin,
 * ghép âm thanh và mã hoá H.264 2K (2560x1440) + AAC.
 */
export async function renderVideo(story, audioFile, duration, workDir, { width, height, fps }) {
  loadFonts();
  const out = path.join(workDir, "video.mp4");
  const showCaption = envStr("SHOW_CAPTION", "true") !== "false";
  const preset = envStr("X264_PRESET", "veryfast");
  const crf = envStr("X264_CRF", "18");

  const canvas = createCanvas(width, height);
  const rawCtx = canvas.getContext("2d");
  const ctx = browserLikeContext(rawCtx);
  try {
    story.init(ctx, width, height);
  } catch (e) {
    throw new StoryError(VIDEO_STEP, `Storyboard.init() lỗi: ${e.message}`, e);
  }

  const totalFrames = Math.ceil(duration * fps);
  const ff = spawn(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-framerate", String(fps), "-i", "pipe:0",
      "-i", audioFile,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-preset", preset, "-crf", crf, "-profile:v", "high", "-level:v", "5.1",
      "-pix_fmt", "yuv420p", "-g", String(fps * 2), "-bf", "2", "-r", String(fps),
      "-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2",
      "-t", duration.toFixed(3), "-movflags", "+faststart", out,
    ],
    { stdio: ["pipe", "ignore", "pipe"] }
  );

  let ffErr = "";
  ff.stderr.on("data", (d) => (ffErr = (ffErr + d).slice(-8000)));
  const exited = new Promise((resolve, reject) => {
    ff.on("error", (e) => reject(new StepError(VIDEO_STEP, `Không chạy được ffmpeg: ${e.message}`, e)));
    ff.on("close", (code) => resolve(code));
  });
  let pipeBroken = false;
  ff.stdin.on("error", () => (pipeBroken = true));

  const write = (buf) =>
    new Promise((resolve) => {
      if (ff.stdin.write(buf)) return resolve();
      const done = () => {
        ff.stdin.off("drain", done);
        ff.off("close", done);
        resolve();
      };
      ff.stdin.once("drain", done);
      ff.once("close", done);
    });

  const t0 = Date.now();
  let lastLog = 0;
  let frameErrors = 0;
  let firstFrameError = "";
  for (let i = 0; i < totalFrames; i++) {
    if (pipeBroken) break;
    const time = i / fps;
    const seg = segAt(story.segments, time);
    const localT = Math.max(0, time - seg.start);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);

    seg.raw.lyric = "";
    // Giống renderAt() của index.php: lỗi ở 1 khung không làm hỏng cả video,
    // nhưng nếu lỗi quá nhiều khung thì dừng hẳn và báo nguyên nhân.
    rawCtx.save();
    try {
      story.drawScene(seg.raw, localT);
    } catch (e) {
      frameErrors++;
      if (!firstFrameError) firstFrameError = `cảnh "${seg.key}" (t=${localT.toFixed(2)}s): ${e.message}`;
      if (frameErrors > Math.max(10, totalFrames * 0.02)) {
        ff.stdin.destroy();
        ff.kill("SIGKILL");
        throw new StoryError(VIDEO_STEP, `drawScene() lỗi ở ${frameErrors} khung hình. Lỗi đầu tiên tại ${firstFrameError}`, e);
      }
    } finally {
      rawCtx.restore();
    }
    if (showCaption) {
      rawCtx.setTransform(1, 0, 0, 1, 0, 0);
      drawCaption(rawCtx, width, height, seg, localT);
    }

    await write(Buffer.from(rawCtx.getImageData(0, 0, width, height).data.buffer));

    const now = Date.now();
    if (now - lastLog > 15_000 || i === totalFrames - 1) {
      lastLog = now;
      const done = i + 1;
      const rate = done / ((now - t0) / 1000);
      const eta = (totalFrames - done) / rate;
      log.info(`  Khung ${done}/${totalFrames} (${((done / totalFrames) * 100).toFixed(1)}%) — ${rate.toFixed(1)} fps, còn ~${Math.ceil(eta / 60)} phút`);
    }
  }
  ff.stdin.end();

  const code = await exited;
  if (code !== 0 || pipeBroken) {
    throw new StepError(VIDEO_STEP, `ffmpeg mã hoá video thất bại (mã ${code}).\n--- log ffmpeg ---\n${ffErr}`);
  }
  const size = fs.statSync(out).size;
  const got = await probeDuration(out, VIDEO_STEP);
  if (size < 100_000 || got < duration - 1) {
    throw new StepError(VIDEO_STEP, `Video tạo ra không hợp lệ (${formatBytes(size)}, ${got.toFixed(1)}s).\n${ffErr}`);
  }
  log.info(`Video: ${out} — ${width}x${height} @${fps}fps, ${got.toFixed(1)}s, ${formatBytes(size)}`);
  return out;
}
