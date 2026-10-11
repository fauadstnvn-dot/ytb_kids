import fs from "node:fs/promises";
import path from "node:path";
import { StepError, envNum, envStr, log, probeDuration, run, sleep } from "./utils.mjs";

const STEP = "Tạo giọng đọc TTS";
const CHUNK = 180;
const SAMPLE_RATE = 48000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const PAUSE = { sentence: 0.15, clause: 0.08, word: 0 };

/** Cắt một từ quá dài thành các mảnh <= CHUNK ký tự (không làm mất chữ). */
function hardSplit(word) {
  const out = [];
  for (let i = 0; i < word.length; i += CHUNK) out.push(word.slice(i, i + CHUNK));
  return out;
}

/** Gộp tham lam các mảnh nhỏ thành đoạn <= CHUNK ký tự. */
function pack(pieces, end) {
  const out = [];
  let cur = "";
  for (const p of pieces) {
    const next = cur ? `${cur} ${p}` : p;
    if (next.length > CHUNK && cur) {
      out.push({ text: cur, end });
      cur = p;
    } else {
      cur = next;
    }
  }
  if (cur) out.push({ text: cur, end });
  return out;
}

/**
 * Chia lời đọc thành các đoạn <= CHUNK ký tự theo thứ tự ưu tiên ngữ nghĩa:
 * câu -> mệnh đề (, ; : —) -> từ -> ký tự (chỉ khi một từ dài hơn giới hạn).
 * Mỗi đoạn kèm loại điểm ngắt (end) để chèn khoảng lặng tự nhiên khi ghép lại.
 */
export function splitText(text) {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?…]["'”’)\]]*)\s+/).filter(Boolean);
  const atoms = [];
  for (const sentence of sentences) {
    if (sentence.length <= CHUNK) {
      atoms.push({ text: sentence, end: "sentence" });
      continue;
    }
    const clauses = sentence.split(/(?<=[,;:—–])\s+/).filter(Boolean);
    const pieces = [];
    for (const clause of clauses) {
      if (clause.length <= CHUNK) {
        pieces.push(clause);
      } else {
        const words = clause.split(" ").flatMap((w) => (w.length > CHUNK ? hardSplit(w) : [w]));
        pieces.push(...pack(words, "word").map((x) => x.text));
      }
    }
    const packed = pack(pieces, "clause");
    packed[packed.length - 1].end = "sentence";
    atoms.push(...packed);
  }
  // Gộp các đoạn liền kề nếu còn vừa giới hạn để giảm số request.
  const merged = [];
  for (const a of atoms) {
    const last = merged[merged.length - 1];
    if (last && last.text.length + 1 + a.text.length <= CHUNK) {
      last.text += " " + a.text;
      last.end = a.end;
    } else {
      merged.push({ ...a });
    }
  }
  return merged;
}

/** Ghép nhiều MP3 thành một WAV: chuẩn hoá về cùng định dạng và chèn khoảng lặng giữa các đoạn. */
async function joinChunks(files, pauses, out) {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  files.forEach((f) => args.push("-i", f));
  const labels = files.map((_, i) => {
    const pad = pauses[i] > 0 ? `,apad=pad_dur=${pauses[i]}` : "";
    return `[${i}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=mono${pad}[a${i}]`;
  });
  const inputs = files.map((_, i) => `[a${i}]`).join("");
  const filter = `${labels.join(";")};${inputs}concat=n=${files.length}:v=0:a=1[out]`;
  await run("ffmpeg", [...args, "-filter_complex", filter, "-map", "[out]", "-ar", String(SAMPLE_RATE), "-ac", "1", out], { step: STEP });
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
/** Số nửa cung của lời dẫn khi kịch bản không khai báo (mặc định +5 = giọng trẻ em). Biến môi trường TTS_PITCH_SEMITONES (>0) ghi đè. */
const NARRATOR_PITCH_OVERRIDE = envNum("TTS_PITCH_SEMITONES", NaN);
/** Khoảng lặng giữa lời dẫn và các lượt thoại (giây). */
const GAP_AFTER_NARRATION = 0.4;
const GAP_BETWEEN_LINES = 0.3;

/**
 * Chuyển MP3 -> WAV mono 48kHz và đổi cao độ `semitones` nửa cung nhưng GIỮ NGUYÊN tốc độ đọc
 * (dương = giọng cao hơn: trẻ em/phụ nữ; âm = giọng trầm hơn: ông già/chó sói...).
 * Ưu tiên bộ lọc rubberband (chất lượng tốt); nếu bản ffmpeg không có thì dùng asetrate + atempo.
 */
async function toVoice(input, wav, semitones) {
  const base = ["-y", "-hide_banner", "-loglevel", "error", "-i", input];
  const tail = ["-ar", String(SAMPLE_RATE), "-ac", "1", wav];
  // Highshelf làm giọng cao sáng hơn; giọng trầm thì bỏ để không bị gắt.
  const shelf = semitones >= 3 ? "highshelf=f=3000:g=4" : semitones <= -3 ? "lowshelf=f=200:g=3" : "anull";
  if (!semitones) {
    await run("ffmpeg", [...base, "-af", shelf, ...tail], { step: STEP });
    return;
  }
  const ratio = Math.pow(2, semitones / 12);
  try {
    await run("ffmpeg", [...base, "-af", `rubberband=pitch=${ratio.toFixed(6)},${shelf}`, ...tail], { step: STEP });
  } catch {
    log.info("ffmpeg không có rubberband, dùng asetrate + atempo để đổi cao độ.");
    const af = `aresample=${SAMPLE_RATE},asetrate=${Math.round(SAMPLE_RATE * ratio)},aresample=${SAMPLE_RATE},atempo=${(1 / ratio).toFixed(6)},${shelf}`;
    await run("ffmpeg", [...base, "-af", af, ...tail], { step: STEP });
  }
}

/** Đọc một câu/đoạn bằng Google TTS rồi đổi cao độ -> WAV; trả {file, duration}. */
async function synthesizeLine(text, lang, semitones, dir, name) {
  const chunks = splitText(text);
  const files = [];
  for (let i = 0; i < chunks.length; i++) {
    const f = path.join(dir, `${name}_${i}.mp3`);
    await fs.writeFile(f, await fetchChunk(chunks[i].text, lang));
    files.push(f);
    await sleep(250);
  }
  const pauses = chunks.map((c, i) => (i === chunks.length - 1 ? 0 : PAUSE[c.end]));
  const joined = path.join(dir, `${name}_joined.wav`);
  const wav = path.join(dir, `${name}.wav`);
  await joinChunks(files, pauses, joined);
  await toVoice(joined, wav, semitones);
  return { file: wav, duration: await probeDuration(wav, STEP) };
}

/**
 * Tạo giọng đọc cho mỗi cảnh: lời dẫn (seg.narrationText, giọng trẻ em) rồi lần lượt từng lượt thoại
 * (seg.dialogues, mỗi nhân vật một cao độ). Ghép thành một WAV; gắn seg.narration = {file, duration}
 * và seg.voiceParts = [{kind, speaker, label, text, color, start, end}] (giây, tính từ đầu giọng của cảnh).
 */
export async function synthesizeNarration(segments, workDir) {
  const texts = segments.flatMap((s) => [s.narrationText, ...(s.dialogues || []).map((d) => d.text)]).filter(Boolean);
  const lang = detectLang(texts);
  log.info(`Ngôn ngữ giọng đọc: ${lang}`);
  const dir = path.join(workDir, "tts");
  await fs.mkdir(dir, { recursive: true });

  for (const seg of segments) {
    const lines = [];
    if (seg.narrationText) {
      const pitch = Number.isFinite(NARRATOR_PITCH_OVERRIDE) ? NARRATOR_PITCH_OVERRIDE : seg.narratorPitch;
      lines.push({ kind: "narration", speaker: "narrator", label: "Narrator", text: seg.narrationText, pitch, color: null });
    }
    for (const d of seg.dialogues || []) lines.push({ kind: "dialogue", ...d });

    if (!lines.length) {
      seg.narration = null;
      seg.voiceParts = [];
      continue;
    }

    const rendered = [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const r = await synthesizeLine(ln.text, lang, ln.pitch, dir, `seg_${seg.index}_p${i}`);
      rendered.push({ ...ln, ...r });
    }

    const pauses = rendered.map((p, i) => (i === rendered.length - 1 ? 0 : p.kind === "narration" ? GAP_AFTER_NARRATION : GAP_BETWEEN_LINES));
    let cursor = 0;
    seg.voiceParts = rendered.map((p, i) => {
      const part = { kind: p.kind, speaker: p.speaker, label: p.label, text: p.text, color: p.color, pitch: p.pitch, start: cursor, end: cursor + p.duration };
      cursor += p.duration + pauses[i];
      return part;
    });

    const wav = path.join(dir, `seg_${seg.index}.wav`);
    if (rendered.length === 1) {
      await fs.copyFile(rendered[0].file, wav);
    } else {
      await joinChunks(rendered.map((p) => p.file), pauses, wav);
    }
    const duration = await probeDuration(wav, STEP);
    seg.narration = { file: wav, duration };
    const who = rendered.filter((p) => p.kind === "dialogue").map((p) => `${p.label} ${p.pitch >= 0 ? "+" : ""}${p.pitch}`);
    log.info(`  Cảnh ${seg.index + 1} "${seg.title}": ${duration.toFixed(2)}s giọng (lời dẫn${who.length ? " + " + who.join(", ") : ""})`);
  }
}
