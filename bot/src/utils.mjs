import { spawn } from "node:child_process";

export class StepError extends Error {
  constructor(step, message, cause) {
    super(message);
    this.name = "StepError";
    this.step = step;
    if (cause) this.cause = cause;
  }
}

/** Lỗi do chính file kịch bản (không chạy/không vẽ được) -> xoá kịch bản đó và chọn kịch bản khác. */
export class StoryError extends StepError {
  constructor(step, message, cause) {
    super(step, message, cause);
    this.name = "StoryError";
  }
}

const startedAt = Date.now();

function stamp() {
  const s = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(7, " ");
  return `[${s}s]`;
}

export const log = {
  step(title) {
    console.log(`\n${stamp()} ===== ${title} =====`);
  },
  info(msg) {
    console.log(`${stamp()} ${msg}`);
  },
  warn(msg) {
    console.log(`::warning::${msg}`);
  },
  error(title, msg) {
    console.log(`::error title=${title.replace(/[\r\n:,]/g, " ")}::${String(msg).replace(/\r?\n/g, "%0A")}`);
  },
};

export function requireEnv(names, step) {
  const missing = names.filter((n) => !process.env[n] || !String(process.env[n]).trim());
  if (missing.length) {
    throw new StepError(
      step,
      `Thiếu GitHub Secret: ${missing.join(", ")}. Vào Settings → Secrets and variables → Actions → New repository secret để tạo.`
    );
  }
}

export function envStr(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function formatTimestamp(sec) {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chạy một tiến trình, gom stderr để báo lỗi rõ ràng khi exit code != 0. */
export function run(cmd, args, { step, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      err += d;
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    child.on("error", (e) =>
      reject(new StepError(step, `Không chạy được "${cmd}": ${e.message}. Kiểm tra ${cmd} đã được cài trên runner chưa.`, e))
    );
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new StepError(step, `${cmd} thoát với mã ${code}.\n--- log cuối ---\n${err.slice(-3000)}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function probeDuration(file, step) {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
    { step }
  );
  const d = parseFloat(stdout.trim());
  if (!Number.isFinite(d)) throw new StepError(step, `ffprobe không đọc được thời lượng của ${file}`);
  return d;
}
