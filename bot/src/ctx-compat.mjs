// @napi-rs/canvas kiểm tra kiểu tham số chặt hơn trình duyệt (ví dụ trình duyệt chấp nhận
// arc(x, y, r, a0, a1, Math.PI * 2) — tham số cuối được ép thành boolean). Lớp bọc này làm
// cho context cư xử giống Canvas 2D của trình duyệt để kịch bản viết cho web chạy y hệt.

const BOOL_ARG = { arc: 5, ellipse: 7, arcTo: -1 };
const PATH_METHODS = new Set([
  "moveTo", "lineTo", "quadraticCurveTo", "bezierCurveTo", "arc", "arcTo", "ellipse", "rect", "roundRect",
  "fillRect", "strokeRect", "clearRect", "translate", "scale", "rotate", "transform", "setTransform",
  "fillText", "strokeText", "drawImage",
]);

function hasNonFinite(args) {
  return args.some((a) => typeof a === "number" && !Number.isFinite(a));
}

function coerce(args) {
  return args.map((a) => (typeof a === "string" && a.trim() !== "" && Number.isFinite(Number(a)) ? Number(a) : a));
}

export function browserLikeContext(ctx) {
  const cache = new Map();
  return new Proxy(ctx, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      let wrapped = cache.get(prop);
      if (wrapped) return wrapped;
      const name = String(prop);
      const boolIdx = BOOL_ARG[name];
      const isPath = PATH_METHODS.has(name);
      wrapped = function (...args) {
        if (boolIdx >= 0 && args.length > boolIdx) args[boolIdx] = Boolean(args[boolIdx]);
        if (isPath && hasNonFinite(args)) return undefined; // trình duyệt bỏ qua lệnh có NaN/Infinity
        if (name === "arc" || name === "ellipse") {
          // bán kính âm do làm tròn số (vd -0.0001) -> coi như 0 thay vì ném lỗi
          if (name === "arc" && args[2] < 0 && args[2] > -1) args[2] = 0;
          if (name === "ellipse") {
            if (args[2] < 0 && args[2] > -1) args[2] = 0;
            if (args[3] < 0 && args[3] > -1) args[3] = 0;
          }
        }
        try {
          return value.apply(target, args);
        } catch (e) {
          if (/Expected|convert napi value/i.test(String(e.code || e.message))) {
            return value.apply(target, coerce(args));
          }
          throw e;
        }
      };
      cache.set(prop, wrapped);
      return wrapped;
    },
    set(target, prop, value) {
      try {
        Reflect.set(target, prop, value, target);
      } catch {
        // trình duyệt im lặng bỏ qua giá trị không hợp lệ (vd fillStyle = undefined)
      }
      return true;
    },
  });
}
