// Phụ đề karaoke cho phần "action" — chuyển từ drawVideoCaption() của index.php.

export const CAPTION_FONT_FAMILY = "'Noto Sans', 'DejaVu Sans', sans-serif";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapCache = new Map();

function wrapWords(ctx, text, font, maxW) {
  const cacheKey = `${font}|${maxW}|${text}`;
  const hit = wrapCache.get(cacheKey);
  if (hit) return hit;
  ctx.font = font;
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = [];
  for (const w of words) {
    const test = [...line, w].join(" ");
    if (line.length && ctx.measureText(test).width > maxW) {
      lines.push(line);
      line = [w];
    } else {
      line.push(w);
    }
  }
  if (line.length) lines.push(line);
  wrapCache.set(cacheKey, lines);
  return lines;
}

function karaokeProgress(seg, t) {
  const nd = seg.narration?.duration || 0;
  const dur = nd > 0 ? nd : seg.end - seg.start;
  return dur > 0 ? clamp(t / dur, 0, 1) : 0;
}

export function drawCaption(ctx, W, H, seg, t) {
  const text = seg.narrationText;
  if (!text) return;
  const S = H / 720;
  const padX = 56 * S;
  const padBottom = 48 * S;
  const maxW = W - padX * 2;
  const px = Math.round(28 * S);
  const font = `400 ${px}px ${CAPTION_FONT_FAMILY}`;
  const lineH = 38 * S;

  const lines = wrapWords(ctx, text, font, maxW);
  if (!lines.length) return;
  const topY = H - padBottom - lines.length * lineH;
  const gradTop = topY - 48 * S;

  ctx.save();
  const grad = ctx.createLinearGradient(0, H, 0, gradTop);
  grad.addColorStop(0, "rgba(0,0,0,0.80)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, gradTop, W, H - gradTop);

  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 8 * S;
  ctx.shadowOffsetY = 2 * S;

  const spaceW = ctx.measureText(" ").width;
  const totalWords = lines.reduce((a, l) => a + l.length, 0);
  const prog = karaokeProgress(seg, t) * totalWords;
  const cur = Math.floor(prog);
  const frac = clamp(prog - cur, 0, 1);
  const pop = 1 - Math.min(1, frac / 0.55);
  const scale = 1.14 + 0.16 * pop;
  const lift = 4 * pop * S;

  let y = topY;
  let gi = 0;
  for (const line of lines) {
    let x = padX;
    for (const word of line) {
      const ww = ctx.measureText(word).width;
      ctx.save();
      if (gi === cur) {
        const cx = x + ww / 2;
        const cy = y + px * 0.5;
        ctx.translate(0, -lift);
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);
        ctx.shadowOffsetY = 0;
        ctx.shadowColor = "rgba(255,180,40,0.55)";
        ctx.shadowBlur = 26 * S;
        ctx.fillStyle = "#ffd24a";
        ctx.fillText(word, x, y);
        ctx.shadowColor = "rgba(255,210,74,0.9)";
        ctx.shadowBlur = 14 * S;
        ctx.fillStyle = "#fff7c2";
        ctx.fillText(word, x, y);
        ctx.shadowBlur = 0;
        ctx.lineWidth = 0.8 * S;
        ctx.strokeStyle = "rgba(255,214,74,0.9)";
        ctx.strokeText(word, x, y);
      } else if (gi < cur) {
        ctx.fillStyle = "#ffd24a";
        ctx.fillText(word, x, y);
      } else {
        ctx.globalAlpha = 0.72;
        ctx.fillStyle = "#cfe6dc";
        ctx.fillText(word, x, y);
      }
      ctx.restore();
      x += ww + spaceW;
      gi++;
    }
    y += lineH;
  }
  ctx.restore();
}
