// Chạy trên máy tính của bạn để lấy token cho 1 dòng trong bảng tb_bao_secret:
//   YT_CLIENT_ID=xxx YT_CLIENT_SECRET=yyy npm run token
// Trong Google Cloud Console, OAuth client loại "Desktop app" (khuyên dùng),
// hoặc loại "Web application" có Authorized redirect URI = http://localhost:8765
import http from "node:http";

const clientId = process.env.YT_CLIENT_ID;
const clientSecret = process.env.YT_CLIENT_SECRET;
const PORT = 8765;
const redirectUri = `http://localhost:${PORT}`;

if (!clientId || !clientSecret) {
  console.error("Thiếu YT_CLIENT_ID hoặc YT_CLIENT_SECRET.\nVí dụ: YT_CLIENT_ID=xxx YT_CLIENT_SECRET=yyy npm run token");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.upload",
    access_type: "offline",
    prompt: "consent",
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Thiếu ?code");
    return;
  }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const json = await r.json();
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  if (json.refresh_token) {
    res.end("Đã lấy refresh token. Quay lại cửa sổ terminal.");
    console.log("\n=== Dán JSON dưới đây vào cột token_kid của dòng tương ứng trong tb_bao_secret ===\n");
    console.log(JSON.stringify({ ...json, saved_at: Math.floor(Date.now() / 1000) }));
    console.log("");
  } else {
    res.end("Lỗi: " + JSON.stringify(json));
    console.error("Không nhận được refresh_token:", json);
  }
  server.close();
});

server.listen(PORT, () => {
  console.log("Mở link sau trên trình duyệt, đăng nhập đúng tài khoản sở hữu kênh YouTube và cho phép:\n");
  console.log(authUrl + "\n");
});
