import fs from "fs";

const account = {
  username: "ilayda",
  password: "Sesa2021.",
  environment: "production",
  storeId: 1,
};

const API_BASE = "https://api.syncrosale.com/api/v1";
const AUTH_URL =
  "https://auth.syncrosale.com/realms/syncrosale/protocol/openid-connect/token";

async function main() {
  // Login
  console.log("🔐 Giriş yapılıyor...");
  const loginRes = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "syncrosale",
      username: account.username,
      password: account.password,
    }),
  });

  if (!loginRes.ok) throw new Error(`Login hatası: ${loginRes.status}`);
  const { access_token } = await loginRes.json();
  console.log("✅ Giriş başarılı!");

  // CSV indir
  console.log("📦 CSV indiriliyor...");
  const csvRes = await fetch(
    `${API_BASE}/store/${account.storeId}/product/export`,
    {
      headers: { Authorization: `Bearer ${access_token}` },
    },
  );

  if (!csvRes.ok) throw new Error(`CSV hatası: ${csvRes.status}`);
  const csvText = await csvRes.text();

  const fileName = `ilayda_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  fs.writeFileSync(fileName, csvText, "utf-8");
  console.log(
    `✅ Kaydedildi: ${fileName} (${(csvText.length / 1024).toFixed(1)} KB)`,
  );
}

main().catch(console.error);
