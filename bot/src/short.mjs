import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { CAPTION_FONT_FAMILY, drawCaption } from "./caption.mjs";
import { browserLikeContext } from "./ctx-compat.mjs";
import { loadFonts } from "./render.mjs";
import { cameraAt, talkingAt } from "./story.mjs";
import { synthesizeText } from "./tts.mjs";
import { StepError, envNum, formatBytes, log, probeDuration, run } from "./utils.mjs";

const STEP = "Dựng YouTube Short";
const DEFAULT_CTA = "Full video on my channel";
const MUSIC_VOLUME = 0.12; // bằng mức nhạc nền của video dài (render.mjs)
const VOICE_VOLUME = 0.95;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const clean = (s) => String(s || "").replace(/[<>]/g, "").replace(/\r\n/g, "\n").trim();

/**
 * Chuẩn hoá phần YOUTUBE_SHORT của kịch bản. Trả null nếu kịch bản không có phần Short (script cũ).
 *   { title, description, tags, hookText,
 *     clips: [ "scene_key" | { scene, maxSec, text } ],
 *     outro: { text, speech } }
 */
export function parseShortSpec(raw) {
  if (!raw || typeof raw !== "object") return null;
  const list = Array.isArray(raw.clips) ? raw.clips : Array.isArray(raw.scenes) ? raw.scenes : [];
  const clips = list
    .map((c) => (typeof c === "string" ? { scene: c } : c))
    .filter((c) => c && (c.scene || c.key))
    .map((c) => ({
      key: String(c.scene || c.key),
      maxSec: clamp(Number(c.maxSec) || 10, 3, 20),
      text: clean(c.text),
    }));
  if (!clips.length) return null;
  const outro = raw.outro && typeof raw.outro === "object" ? raw.outro : {};
  const text = clean(outro.text || raw.cta) || DEFAULT_CTA;
  return {
    title: clean(raw.title),
    description: clean(raw.description),
    tags: Array.isArray(raw.tags) ? raw.tags.map(clean).filter(Boolean) : [],
    hookText: clean(raw.hookText),
    clips,
    outro: { text, speech: clean(outro.speech) || text },
  };
}

/**
 * Chọn đoạn của một cảnh để đưa vào Short (thời gian theo timeline cảnh SAU khi đã retime theo giọng đọc).
 * Có mốc giọng đọc: lấy từ đầu lời dẫn, thêm lần lượt các câu cho tới khi chạm maxSec và dừng ở CUỐI một câu
 * (không cắt ngang lời). Không có (mp3 riêng): bỏ đoạn hiệu ứng mở đầu rồi lấy maxSec giây.
 */
function clipWindow(seg, maxSec) {
  const dur = seg.end - seg.start;
  const parts = seg.raw.voiceParts;
  const tail = seg.leadMax ? 0.9 : 0.05;
  let a;
  let b;
  if (parts?.length) {
    a = Math.max(0, parts[0].start - 0.1);
    let last = parts[0];
    for (const p of parts.slice(1)) {
      if (p.end + 0.4 - a > maxSec) break;
      last = p;
    }
    b = last.end + 0.5;
  } else {
    a = Math.min(seg.leadMax || 0, Math.max(0, dur - 3));
    b = a + maxSec;
  }
  b = Math.min(b, dur - tail);
  if (b - a < 1.5) b = Math.min(dur - 0.05, a + 1.5);
  return { a, b };
}

function planShort(story, spec, maxTotal, outroSec) {
  const byKey = new Map(story.segments.map((s) => [s.key, s]));
  const budget = maxTotal - outroSec;
  const plan = [];
  let cursor = 0;
  spec.clips.forEach((c, i) => {
    const seg = byKey.get(c.key);
    if (!seg) {
      log.warn(`Short: không có cảnh "${c.key}" trong kịch bản, bỏ qua clip này.`);
      return;
    }
    const w = clipWindow(seg, c.maxSec);
    let len = w.b - w.a;
    if (cursor + len > budget) {
      if (plan.length) {
        log.warn(`Short: bỏ clip "${c.key}" vì vượt ${maxTotal}s.`);
        return;
      }
      len = budget;
    }
    plan.push({ seg, a: w.a, b: w.a + len, start: cursor, dur: len, text: c.text || (i === 0 ? spec.hookText : "") });
    cursor += len;
  });
  return { plan, total: cursor };
}

async function buildShortAudio({ plan, total, musicFile, customVoice, cta, outroStart, duration }, workDir) {
  const out = path.join(workDir, "short-audio.wav");
  const dur = duration.toFixed(3);
  const fmt = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-i", musicFile];
  const filters = [`[0:a]${fmt},asetpts=N/SR/TB,atrim=0:${dur},volume=${MUSIC_VOLUME},afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, duration - 1.5).toFixed(3)}:d=1.5[m]`];
  const labels = ["[m]"];
  let idx = 1;

  for (const p of plan) {
    const lead = p.seg.lead || 0;
    let trimStart;
    let trimEnd;
    let delay = p.start;
    let file;
    if (customVoice) {
      file = customVoice;
      trimStart = p.seg.start + p.a;
      trimEnd = p.seg.start + p.b;
    } else if (p.seg.narration?.file) {
      file = p.seg.narration.file;
      const offset = p.a - lead;
      trimStart = Math.max(0, offset);
      trimEnd = p.b - lead;
      delay += Math.max(0, -offset);
    } else {
      continue;
    }
    if (trimEnd - trimStart < 0.2) continue;
    args.push("-i", file);
    const len = trimEnd - trimStart;
    filters.push(
      `[${idx}:a]${fmt},atrim=start=${trimStart.toFixed(3)}:end=${trimEnd.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `afade=t=out:st=${Math.max(0, len - 0.08).toFixed(3)}:d=0.08,volume=${VOICE_VOLUME},adelay=${Math.round(delay * 1000)}:all=1[v${idx}]`
    );
    labels.push(`[v${idx}]`);
    idx++;
  }
  if (cta) {
    args.push("-i", cta.file);
    filters.push(`[${idx}:a]${fmt},volume=${VOICE_VOLUME},adelay=${Math.round((outroStart + 0.3) * 1000)}:all=1[v${idx}]`);
    labels.push(`[v${idx}]`);
  }
  filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0:dropout_transition=0,apad=whole_dur=${dur}[out]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-t", dur, "-c:a", "pcm_s16le", out);
  await run("ffmpeg", args, { step: STEP });
  return out;
}

function wrapLines(ctx, text, maxW) {
  const lines = [];
  let line = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const test = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(test).width > maxW) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/** Chữ lớn viền đen (hook / câu giật tít) ở vùng phía trên khung hình. */
function drawOverlayText(ctx, W, y, text, alpha, px) {
  if (!text || alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `800 ${px}px ${CAPTION_FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const lines = wrapLines(ctx, text, W * 0.86);
  const lineH = px * 1.2;
  const pop = 0.9 + 0.1 * Math.min(1, alpha * 1.5);
  ctx.translate(W / 2, y + (lines.length * lineH) / 2);
  ctx.scale(pop, pop);
  ctx.translate(-W / 2, -(y + (lines.length * lineH) / 2));
  ctx.lineJoin = "round";
  ctx.lineWidth = px * 0.2;
  ctx.strokeStyle = "rgba(20,20,20,0.95)";
  ctx.fillStyle = "#ffd24a";
  lines.forEach((l, i) => {
    ctx.strokeText(l, W / 2, y + i * lineH);
    ctx.fillText(l, W / 2, y + i * lineH);
  });
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const easeOutBack = (t) => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);

/** Màn cuối: làm tối khung cuối, nút play đỏ nhịp đập + thẻ chữ "Full video on my channel". */
function drawOutro(ctx, W, H, text, p, time) {
  const S = W / 1080;
  const k = easeOutBack(clamp(p, 0, 1));
  ctx.save();
  ctx.fillStyle = `rgba(0,0,0,${0.55 * clamp(p * 2, 0, 1)})`;
  ctx.fillRect(0, 0, W, H);

  const pulse = 1 + 0.06 * Math.sin(time * 7);
  const cx = W / 2;
  const cy = H * 0.37;
  ctx.translate(cx, cy);
  ctx.scale(k * pulse, k * pulse);
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 30 * S;
  roundRect(ctx, -150 * S, -105 * S, 300 * S, 210 * S, 56 * S);
  ctx.fillStyle = "#ff2d2d";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.beginPath();
  ctx.moveTo(-42 * S, -66 * S);
  ctx.lineTo(-42 * S, 66 * S);
  ctx.lineTo(72 * S, 0);
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.restore();

  ctx.save();
  const px = Math.round(78 * S);
  ctx.font = `800 ${px}px ${CAPTION_FONT_FAMILY}`;
  const lines = wrapLines(ctx, text, W * 0.78);
  const lineH = px * 1.22;
  const cardW = W * 0.88;
  const cardH = lines.length * lineH + 70 * S;
  const cardY = H * 0.37 + 150 * S;
  ctx.translate(W / 2, cardY + cardH / 2);
  ctx.scale(k, k);
  ctx.translate(-W / 2, -(cardY + cardH / 2));
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 24 * S;
  roundRect(ctx, (W - cardW) / 2, cardY, cardW, cardH, 40 * S);
  ctx.fillStyle = "#fff4cf";
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 6 * S;
  ctx.strokeStyle = "#2b2b2b";
  ctx.stroke();
  ctx.fillStyle = "#2b2b2b";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, W / 2, cardY + 35 * S + i * lineH));
  ctx.restore();
}

async function encodeShort({ story, plan, total, outroStart, outroText, audio, duration, srcW, srcH, width, height, fps, out }) {
  const src = createCanvas(srcW, srcH);
  const srcRaw = src.getContext("2d");
  const srcCtx = browserLikeContext(srcRaw);
  try {
    story.init(srcCtx, srcW, srcH);
  } catch (e) {
    throw new StepError(STEP, `Storyboard.init() lỗi khi dựng Short: ${e.message}`, e);
  }

  const dest = createCanvas(width, height);
  const d = dest.getContext("2d");
  const blurW = 72;
  const blurH = Math.round((blurW * height) / width);
  const blurCanvas = createCanvas(blurW, blurH);
  const blurCtx = blurCanvas.getContext("2d");
  blurCtx.imageSmoothingEnabled = true;

  const fgH = Math.round((width * srcH) / srcW);
  const fgY = Math.round(height * 0.44 - fgH / 2);
  const S = width / 1080;
  const capOpts = { scale: 1.6 * S, bubbleMaxW: 0.84, bubbleTop: 0.2, padBottom: height * 0.17 };

  const totalFrames = Math.ceil(duration * fps);
  const ff = spawn(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-framerate", String(fps), "-i", "pipe:0",
      "-i", audio,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-profile:v", "high",
      "-pix_fmt", "yuv420p", "-g", String(fps * 2), "-r", String(fps),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-t", duration.toFixed(3), "-movflags", "+faststart", out,
    ],
    { stdio: ["pipe", "ignore", "pipe"] }
  );
  let ffErr = "";
  ff.stderr.on("data", (c) => (ffErr = (ffErr + c).slice(-6000)));
  const exited = new Promise((resolve, reject) => {
    ff.on("error", (e) => reject(new StepError(STEP, `Không chạy được ffmpeg: ${e.message}`, e)));
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

  const last = plan[plan.length - 1];
  let frameErrors = 0;
  for (let i = 0; i < totalFrames; i++) {
    if (pipeBroken) break;
    const T = i / fps;
    const item = T < outroStart ? plan.find((p) => T >= p.start && T < p.start + p.dur) || last : null;
    const seg = (item || last).seg;
    const localT = item ? item.a + (T - item.start) : last.b - 0.05;

    srcRaw.setTransform(1, 0, 0, 1, 0, 0);
    srcRaw.globalAlpha = 1;
    srcRaw.globalCompositeOperation = "source-over";
    srcRaw.fillStyle = "#000";
    srcRaw.fillRect(0, 0, srcW, srcH);
    seg.raw.lyric = "";
    srcRaw.save();
    try {
      const cam = cameraAt(seg, localT, srcW, srcH);
      if (cam) srcRaw.setTransform(cam.scale, 0, 0, cam.scale, cam.ox, cam.oy);
      const talk = item ? talkingAt(seg, localT) : { speaker: null, mouth: 0 };
      seg.raw.speaker = talk.speaker;
      seg.raw.mouth = talk.mouth;
      story.drawScene(seg.raw, localT);
    } catch (e) {
      if (++frameErrors > Math.max(10, totalFrames * 0.05)) {
        ff.stdin.destroy();
        ff.kill("SIGKILL");
        throw new StepError(STEP, `drawScene() lỗi ở ${frameErrors} khung hình của Short: ${e.message}`, e);
      }
    } finally {
      srcRaw.restore();
    }

    // Nền: cắt giữa khung rồi thu nhỏ rất bé -> phóng lại thành nền mờ (rẻ hơn blur thật).
    d.setTransform(1, 0, 0, 1, 0, 0);
    d.globalAlpha = 1;
    const cw = (srcH * width) / height;
    blurCtx.drawImage(src, (srcW - cw) / 2, 0, cw, srcH, 0, 0, blurW, blurH);
    d.imageSmoothingEnabled = true;
    d.drawImage(blurCanvas, 0, 0, width, height);
    d.fillStyle = "rgba(0,0,0,0.42)";
    d.fillRect(0, 0, width, height);
    // Khung chính: toàn bộ khung 16:9 nằm giữa, không cắt mất nhân vật.
    d.save();
    d.shadowColor = "rgba(0,0,0,0.55)";
    d.shadowBlur = 40 * S;
    d.fillStyle = "#000";
    d.fillRect(0, fgY, width, fgH);
    d.restore();
    d.drawImage(src, 0, fgY, width, fgH);

    if (item) {
      const lt = T - item.start;
      drawCaption(d, width, height, seg, localT, capOpts);
      if (item.text) {
        const a = Math.min(1, lt / 0.2, (2.8 - lt) / 0.3);
        drawOverlayText(d, width, height * 0.08, item.text, a, Math.round(88 * S));
      }
      // Chuyển clip mượt: mờ vào / mờ ra 0.12s.
      const fade = Math.min(lt, item.dur - lt, 0.12) / 0.12;
      if (fade < 1) {
        d.fillStyle = `rgba(0,0,0,${1 - clamp(fade, 0, 1)})`;
        d.fillRect(0, 0, width, height);
      }
    } else {
      drawOutro(d, width, height, outroText, (T - outroStart) / 0.45, T);
    }

    await write(Buffer.from(d.getImageData(0, 0, width, height).data.buffer));
  }
  ff.stdin.end();
  const code = await exited;
  if (code !== 0 || pipeBroken) throw new StepError(STEP, `ffmpeg mã hoá Short thất bại (mã ${code}).\n${ffErr}`);
}

/**
 * Dựng YouTube Short dọc 1080x1920 từ những cảnh hấp dẫn nhất mà kịch bản chọn (YOUTUBE_SHORT.clips),
 * dùng lại đúng hình + giọng đọc đã tạo cho video dài, rồi thêm chữ giật tít và màn cuối
 * "Full video on my channel" (có đọc). Trả null nếu kịch bản không có phần Short.
 */
export async function buildShort({ story, musicFile, customVoice, workDir, fps }) {
  const spec = parseShortSpec(story.shortSpec);
  if (!spec) return null;
  loadFonts();

  const maxTotal = clamp(envNum("SHORT_MAX_SEC", 58), 15, 175);
  const width = envNum("SHORT_WIDTH", 1080);
  const height = envNum("SHORT_HEIGHT", 1920);
  const srcW = envNum("SHORT_SRC_W", 1920);
  const srcH = Math.round((srcW * 9) / 16);
  const dir = path.join(workDir, "short");
  fs.mkdirSync(dir, { recursive: true });

  let cta = null;
  try {
    cta = await synthesizeText(spec.outro.speech, dir, "cta");
  } catch (e) {
    log.warn(`Short: không tạo được giọng đọc lời kêu gọi cuối (${e.message}); vẫn hiển thị chữ.`);
  }
  const outroSec = clamp((cta?.duration || 2) + 1.2, 3.5, 7);

  const { plan, total } = planShort(story, spec, maxTotal, outroSec);
  if (!plan.length) {
    log.warn("Short: không có clip hợp lệ nào (key cảnh không khớp), bỏ qua Short.");
    return null;
  }
  const duration = total + outroSec;
  log.info(`Short: ${plan.length} clip [${plan.map((p) => `${p.seg.key} ${p.dur.toFixed(1)}s`).join(", ")}] + màn cuối ${outroSec.toFixed(1)}s = ${duration.toFixed(1)}s`);

  const audio = await buildShortAudio({ plan, total, musicFile, customVoice, cta, outroStart: total, duration }, dir);
  const out = path.join(dir, "short.mp4");
  await encodeShort({ story, plan, total, outroStart: total, outroText: spec.outro.text, audio, duration, srcW, srcH, width, height, fps, out });

  const size = fs.statSync(out).size;
  const got = await probeDuration(out, STEP);
  if (size < 50_000 || got < duration - 1) {
    throw new StepError(STEP, `Short tạo ra không hợp lệ (${formatBytes(size)}, ${got.toFixed(1)}s).`);
  }
  log.info(`Short: ${out} — ${width}x${height} @${fps}fps, ${got.toFixed(1)}s, ${formatBytes(size)}`);
  return { video: out, duration: got, spec, clips: plan.map((p) => p.seg.key) };
}

/**
 * Metadata của Short: link video dài luôn nằm ở dòng đầu mô tả (hiện ngay ở bản xem trước),
 * thêm #Shorts để YouTube phân loại. Hỗ trợ {LONG_URL} trong mô tả của kịch bản.
 */
export function buildShortMeta(spec, longUrl, longMeta) {
  let title = clean(spec.title) || longMeta.title;
  title = title.replace(/\s+/g, " ");
  if (!/#shorts/i.test(title) && [...title].length <= 91) title += " #Shorts";
  if ([...title].length > 100) title = [...title].slice(0, 100).join("").trimEnd();

  let body = spec.description.replace(/\{\{?\s*LONG_URL\s*\}?\}/gi, longUrl);
  const lines = [];
  if (!body.includes(longUrl)) lines.push(`▶ Watch the full video: ${longUrl}`, "");
  lines.push(body);
  let description = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!/#shorts/i.test(description)) description += "\n\n#Shorts";

  const seen = new Set();
  const tags = [];
  for (const t of [...spec.tags, ...(longMeta.tags || []).slice(0, 5), "shorts"]) {
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    tags.push(t.replace(/[,\n]/g, " "));
  }
  return { title, description: description.slice(0, 4900), tags };
}
