import fs from "fs";
import path from "path";

const accounts = {
  beyza: {
    username: "beyzakamar",
    password: "Sesa2021.",
    environment: "development",
    storeId: 18,
  },
  ilayda: {
    username: "ilayda",
    password: "Sesa2021.",
    environment: "production",
    storeId: 1,
  },
  erkan: {
    username: "erkan",
    password: "Sesa2021.",
    environment: "production",
    storeId: 1,
  },
  arda: {
    username: "ardackr.001@gmail.com",
    password: "Sesa2021.",
    environment: "production",
    storeId: 1,
  },
};

const EXPORT_DIR = "exports";

const API_BASE = "https://api.syncrosale.com/api/v1";
const AUTH_URL =
  "https://auth.syncrosale.com/realms/syncrosale/protocol/openid-connect/token";
const API_DEV_BASE = "https://api.dev.syncrosale.com/api/v1";
const AUTH_DEV_URL =
  "https://auth.dev.syncrosale.com/realms/syncrosale/protocol/openid-connect/token";
async function login(account) {
  let res;
  if (account.environment === "development") {
    res = await fetch(AUTH_DEV_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "syncrosale",
        username: account.username,
        password: account.password,
      }),
    });
  } else {
    res = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "syncrosale",
        username: account.username,
        password: account.password,
      }),
    });
  }

  if (!res.ok) throw new Error(`Login hatası: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function exportCSV(accountName, account) {
  console.log(`🔐 [${accountName}] giriş yapılıyor...`);

  const token = await login(account);
  console.log(`✅ [${accountName}] giriş başarılı`);

  console.log(`📦 [${accountName}] CSV indiriliyor...`);

  const apiBase =
    account.environment === "development" ? API_DEV_BASE : API_BASE;
  const res = await fetch(
    `${apiBase}/store/${account.storeId}/product/export`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (!res.ok) throw new Error(`CSV hatası: ${res.status}`);

  const csvText = await res.text();

  const fileName = `${accountName}_${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.csv`;

  const filePath = path.join(EXPORT_DIR, fileName);

  fs.writeFileSync(filePath, csvText, "utf-8");

  console.log(
    `✅ [${accountName}] kaydedildi: ${filePath} (${(
      csvText.length / 1024
    ).toFixed(1)} KB)`,
  );

  console.log(
    `✅ [${accountName}] kaydedildi: ${fileName} (${(
      csvText.length / 1024
    ).toFixed(1)} KB)`,
  );
}

async function main() {
  if (!fs.existsSync(EXPORT_DIR)) {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
  }

  await Promise.all(
    Object.entries(accounts).map(([name, acc]) =>
      exportCSV(name, acc).catch((err) =>
        console.error(`❌ [${name}] hata:`, err.message),
      ),
    ),
  );

  console.log("🎉 Tüm işlemler bitti");
}

main();
