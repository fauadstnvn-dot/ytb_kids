import fs from "node:fs/promises";
import path from "node:path";
import { StepError, envStr, log, probeDuration, run, sleep } from "./utils.mjs";

const STEP = "Tạo giọng đọc TTS";
const CHUNK = 180;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

/** Cắt text theo từ, mỗi đoạn <= 180 ký tự (giới hạn của Google Translate TTS). */
function splitText(text) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const chunks = [];
  let cur = "";
  for (const w of words) {
    if (!w) continue;
    if ((cur + " " + w).trim().length > CHUNK) {
      if (cur) chunks.push(cur);
      cur = w.length > CHUNK ? w.slice(0, CHUNK) : w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function detectLang(texts) {
  const forced = envStr("TTS_LANG", "");
  if (forced) return forced;
  const all = texts.join(" ");
  return /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(all) ? "vi" : "en";
}

async function fetchChunk(text, lang) {
  const url =
    `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}` +
    `&ttsspeed=0.9&q=${encodeURIComponent(text)}`;
  let lastErr = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Referer: "https://translate.google.com/" },
        signal: AbortSignal.timeout(20_000),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const isMp3 = buf.length > 256 && (buf.subarray(0, 3).toString() === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));
      if (res.ok && isMp3) return buf;
      lastErr = `HTTP ${res.status}, ${buf.length} byte, content-type=${res.headers.get("content-type")}`;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(1500 * attempt);
  }
  throw new StepError(STEP, `Google TTS không trả về MP3 cho đoạn "${text.slice(0, 60)}…" sau 4 lần thử (${lastErr}).`);
}

/** Tạo file WAV giọng đọc cho mỗi cảnh (đọc phần "action"), gắn {file, duration} vào seg.narration. */
export async function synthesizeNarration(segments, workDir) {
  const lang = detectLang(segments.map((s) => s.narrationText));
  log.info(`Ngôn ngữ giọng đọc: ${lang}`);
  const dir = path.join(workDir, "tts");
  await fs.mkdir(dir, { recursive: true });

  for (const seg of segments) {
    if (!seg.narrationText) {
      seg.narration = null;
      continue;
    }
    const parts = [];
    for (const chunk of splitText(seg.narrationText)) {
      parts.push(await fetchChunk(chunk, lang));
      await sleep(250);
    }
    const mp3 = path.join(dir, `seg_${seg.index}.mp3`);
    const wav = path.join(dir, `seg_${seg.index}.wav`);
    await fs.writeFile(mp3, Buffer.concat(parts));
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", mp3, "-ar", "48000", "-ac", "1", wav], { step: STEP });
    const duration = await probeDuration(wav, STEP);
    seg.narration = { file: wav, duration };
    log.info(`  Cảnh ${seg.index + 1} "${seg.title}": ${duration.toFixed(2)}s giọng đọc`);
  }
}
