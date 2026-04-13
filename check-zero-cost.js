import fs from "fs";
import XLSX from "xlsx";

// ==================== ACCOUNTS ====================
const ACCOUNTS = {
  beyzakamar: {
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

const ENV_CONFIG = {
  development: {
    API_BASE: "https://api.dev.syncrosale.com/api/v1",
    AUTH_URL:
      "https://auth.dev.syncrosale.com/realms/syncrosale/protocol/openid-connect/token",
  },
  production: {
    API_BASE: "https://api.syncrosale.com/api/v1",
    AUTH_URL:
      "https://auth.syncrosale.com/realms/syncrosale/protocol/openid-connect/token",
  },
};

const CLIENT_ID = "syncrosale";

const CONCURRENCY = 100;

async function login(account) {
  const envCfg = ENV_CONFIG[account.environment];
  if (!envCfg) {
    throw new Error(`Bilinmeyen ortam: ${account.environment}`);
  }

  const res = await fetch(envCfg.AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: CLIENT_ID,
      username: account.username,
      password: account.password,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login başarısız (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    token: data.access_token,
    storeId: account.storeId,
    apiBase: envCfg.API_BASE,
  };
}

/**
 * CSV export endpoint'inden ASIN listesini çeker
 */
async function fetchAsinsFromCsv(apiBase, storeId, token) {
  const url = `${apiBase}/store/${storeId}/product/export`;

  console.log("📦 CSV export indiriliyor...\n");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `CSV export hatası: ${response.status} ${response.statusText}`,
    );
  }

  const csvText = await response.text();
  console.log(`   CSV boyutu: ${(csvText.length / 1024).toFixed(1)} KB`);

  const lines = csvText.split("\n");
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const asinIdx = headers.findIndex((h) => h.toLowerCase() === "asin");

  if (asinIdx === -1) {
    console.log("   Mevcut sütunlar:", headers.join(", "));
    throw new Error("CSV'de ASIN sütunu bulunamadı!");
  }

  const asins = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCsvLine(line);
    const asin = values[asinIdx]?.trim();
    if (asin) asins.push(asin);
  }

  console.log(`   Toplam ASIN: ${asins.length}\n`);
  return asins;
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Tek ASIN için detail endpoint'ine istek atar
 */
async function fetchAsinDetail(apiBase, storeId, token, asin) {
  const url = `${apiBase}/store/${storeId}/product/${asin}`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      return { asin, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    const rd = data.responseData;
    if (!rd) return { asin, error: "responseData yok" };

    return {
      asin: rd.asin,
      productCost: rd.price?.productCost ?? null,
      shippingCost: rd.price?.shippingCost ?? null,
      warehouseCost: rd.price?.warehouseCost ?? null,
      finalPrice: rd.price?.finalPrice ?? null,
      priceCurrency: rd.price?.priceCurrency ?? null,
      status: rd.storeProductStatus ?? null,
      itemName: rd.marketplaceProduct?.itemName ?? null,
      sku: rd.sku ?? null,
      stock: rd.stock ?? null,
      supplierCost: rd.supplier?.cost ?? null,
    };
  } catch (err) {
    return { asin, error: err.message };
  }
}

/**
 * Tüm ASIN'leri concurrent olarak kontrol eder
 */
async function checkAllAsins(asins, apiBase, storeId, token, accountName) {
  const results = [];
  const zeroCostResults = [];
  let completed = 0;
  let errorCount = 0;
  let zeroCostCount = 0;
  const total = asins.length;
  const startTime = Date.now();

  function printProgress() {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (completed / (elapsed || 1)).toFixed(1);
    const eta =
      completed > 0 ? ((total - completed) / rate / 60).toFixed(1) : "?";
    process.stdout.write(
      `\r  [${completed}/${total}] ⏱${elapsed}s | ${rate}/s | ETA: ${eta}m | 🔴 zeroCost: ${zeroCostCount} | ❌ hata: ${errorCount}   `,
    );
  }

  let idx = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (idx < total) {
      const currentIdx = idx++;
      const asin = asins[currentIdx];

      const detail = await fetchAsinDetail(apiBase, storeId, token, asin);
      detail.account = accountName;
      results.push(detail);
      completed++;

      if (detail.error) {
        errorCount++;
      } else if (
        (detail.productCost === 0 || detail.productCost === null) &&
        detail.status === "ACTIVE"
      ) {
        zeroCostCount++;
        zeroCostResults.push(detail);
        process.stdout.write(
          `\n  🔴 ${zeroCostCount}) ${detail.asin}  |  productCost: ${detail.productCost ?? "null"}  |  ${(detail.itemName || "").substring(0, 50)}\n`,
        );
      }

      printProgress();
    }
  });

  await Promise.all(workers);
  console.log("\n");

  return { results, zeroCostResults };
}

// ==================== MAIN ====================
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║      ZERO PRODUCT COST CHECKER v3.0             ║");
  console.log("║  Tüm hesaplar → CSV → Detail → productCost      ║");
  console.log("╚══════════════════════════════════════════════════╝");

  const allZeroCostResults = [];
  let globalTotal = 0;
  let globalZero = 0;
  let globalErrors = 0;

  const accountNames = Object.keys(ACCOUNTS);

  for (const name of accountNames) {
    const account = { name, ...ACCOUNTS[name] };
    console.log("\n" + "━".repeat(80));
    console.log(
      `📌 Hesap: ${name} (${account.environment}, storeId: ${account.storeId})`,
    );
    console.log("━".repeat(80));

    // Login
    let auth;
    try {
      console.log(`  🔐 Giriş yapılıyor: ${account.username}...`);
      auth = await login(account);
      console.log("  ✅ Giriş başarılı!");
    } catch (err) {
      console.error(`  ❌ Login hatası: ${err.message} — atlanıyor.`);
      continue;
    }

    // CSV'den ASIN'leri çek
    let asins;
    try {
      asins = await fetchAsinsFromCsv(auth.apiBase, auth.storeId, auth.token);
    } catch (err) {
      console.error(`  ❌ CSV export hatası: ${err.message} — atlanıyor.`);
      continue;
    }

    if (asins.length === 0) {
      console.log("  ⚠️  ASIN bulunamadı, atlanıyor.");
      continue;
    }

    // Detail kontrol
    console.log(
      `  🔍 ${asins.length} ASIN kontrol ediliyor (concurrency: ${CONCURRENCY})...\n`,
    );
    const { results, zeroCostResults } = await checkAllAsins(
      asins,
      auth.apiBase,
      auth.storeId,
      auth.token,
      name,
    );

    const errors = results.filter((r) => r.error);
    globalTotal += results.length;
    globalZero += zeroCostResults.length;
    globalErrors += errors.length;
    allZeroCostResults.push(...zeroCostResults);

    console.log(
      `  📊 ${name}: ${results.length} ASIN | 🔴 ${zeroCostResults.length} zeroCost | ❌ ${errors.length} hata`,
    );
  }

  // Genel rapor
  console.log("\n\n" + "=".repeat(80));
  console.log("                  GENEL ZERO PRODUCT COST RAPORU");
  console.log("=".repeat(80));

  console.log(`\n📊 Toplam ASIN (tüm hesaplar): ${globalTotal}`);
  console.log(`🔴 productCost = 0:            ${allZeroCostResults.length}`);
  console.log(
    `🟢 productCost > 0:            ${globalTotal - allZeroCostResults.length - globalErrors}`,
  );
  console.log(`❌ Hata:                       ${globalErrors}`);

  if (allZeroCostResults.length > 0) {
    console.log("\n" + "-".repeat(80));
    console.log("🔴 PRODUCT COST = 0 OLAN ASIN'LER:");
    console.log("-".repeat(80));

    allZeroCostResults.forEach((r, i) => {
      console.log(
        `  ${i + 1}) [${r.account}] ASIN: ${r.asin}  |  productCost: ${r.productCost ?? "null"}  |  finalPrice: ${r.finalPrice ?? "N/A"} ${r.priceCurrency || ""}  |  ${(r.itemName || "N/A").substring(0, 50)}`,
      );
    });
  } else {
    console.log(
      "\n✅ Tüm hesaplarda tüm ürünlerin productCost değeri 0'dan büyük!",
    );
  }

  // XLSX'e kaydet
  const resultFile = `zero-cost_${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`;

  const xlsxData = allZeroCostResults.map((r, i) => ({
    "#": i + 1,
    Account: r.account,
    ASIN: r.asin,
    productCost: r.productCost ?? "",
    shippingCost: r.shippingCost ?? "",
    warehouseCost: r.warehouseCost ?? "",
    finalPrice: r.finalPrice ?? "",
    priceCurrency: r.priceCurrency ?? "",
    status: r.status ?? "",
    itemName: r.itemName ?? "",
    SKU: r.sku ?? "",
    stock: r.stock ?? "",
    supplierCost: r.supplierCost ?? "",
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(xlsxData);
  XLSX.utils.book_append_sheet(wb, ws, "Zero Cost ASINs");
  XLSX.writeFile(wb, resultFile);

  console.log(`\n💾 Sonuçlar kaydedildi: ${resultFile}`);
  console.log("=".repeat(80));
}

main().catch((err) => {
  console.error("Beklenmeyen hata:", err);
  process.exit(1);
});
