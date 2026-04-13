import readline from "readline";
import fs from "fs";

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

// ==================== CONFIGURATION ====================
const CONFIG = {
  // Syncrosale API (set after account selection)
  API_BASE: "",
  STORE_ID: "",
  TOKEN: "",

  // Amazon
  AMAZON_DOMAIN: "amazon.com",

  // Timing
  REQUEST_TIMEOUT_MS: 10000, // HTTP istek timeout
  DELAY_BETWEEN_MS: 100, // İstekler arası bekleme (rate limit)

  // Concurrency
  CONCURRENCY: 20, // Aynı anda kaç istek

  // Pagination
  PAGE_SIZE: 100, // API'den kaç ürün çekilecek (sayfa başına)
  MAX_PRODUCTS: null, // null = hepsini çek, sayı = limit

  // Kayıt
  SAVE_EVERY: 500, // Kaç ASIN'de bir dosyaya kaydet
};
// ========================================================

/**
 * CLI'den hesap seçimi (interaktif)
 */
async function selectAccount() {
  // Eğer CLI argümanı varsa direkt kullan
  const arg = process.argv[2];
  if (arg && ACCOUNTS[arg]) {
    return { name: arg, ...ACCOUNTS[arg] };
  }
  if (arg && !ACCOUNTS[arg]) {
    console.log(`❌ Hesap bulunamadı: "${arg}"`);
  }

  const names = Object.keys(ACCOUNTS);
  console.log("\n📋 Hesap seçin:\n");
  names.forEach((name, i) => {
    const acc = ACCOUNTS[name];
    console.log(
      `  ${i + 1}) ${name}  (${acc.environment}, storeId: ${acc.storeId})`,
    );
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("\nSeçim (numara veya isim): ", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      // Numara ile seçim
      const idx = parseInt(trimmed, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= names.length) {
        const name = names[idx - 1];
        resolve({ name, ...ACCOUNTS[name] });
        return;
      }
      // İsim ile seçim
      if (ACCOUNTS[trimmed]) {
        resolve({ name: trimmed, ...ACCOUNTS[trimmed] });
        return;
      }
      console.log("❌ Geçersiz seçim.");
      process.exit(1);
    });
  });
}

/**
 * Keycloak'tan token al
 */
async function login(account) {
  const envCfg = ENV_CONFIG[account.environment];
  if (!envCfg) {
    throw new Error(`Bilinmeyen ortam: ${account.environment}`);
  }

  console.log(
    `\n🔐 Giriş yapılıyor: ${account.username} (${account.environment})...`,
  );

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
  console.log("✅ Giriş başarılı!");

  return {
    token: data.access_token,
    storeId: account.storeId,
    apiBase: envCfg.API_BASE,
  };
}

/**
 * Syncrosale API'den aktif ürünlerin ASIN listesini çeker
 */
async function fetchAsinsFromApi(storeId, token, page = 0, size = 100) {
  const url = `${CONFIG.API_BASE}/store/${storeId}/product/detailed2?page=${page}&size=${size}&storeProductStatus=ACTIVE`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`API hatası: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return {
    products: data.responseData || [],
    total: data.pageMetadata?.count || 0,
  };
}

/**
 * Tüm sayfalardaki ASIN'leri çeker
 */
async function fetchAllAsins(storeId, token) {
  const allAsins = [];
  let page = 0;
  const size = CONFIG.PAGE_SIZE;

  console.log("📦 Syncrosale API'den ASIN'ler çekiliyor...\n");

  const firstPage = await fetchAsinsFromApi(storeId, token, 0, size);
  const total = firstPage.total;
  const maxToFetch = CONFIG.MAX_PRODUCTS || total;

  console.log(`   Toplam aktif ürün: ${total}`);
  console.log(`   Kontrol edilecek: ${Math.min(maxToFetch, total)}\n`);

  for (const product of firstPage.products) {
    if (product.asin) allAsins.push(product.asin);
  }

  const totalPages = Math.ceil(Math.min(maxToFetch, total) / size);

  for (page = 1; page < totalPages; page++) {
    const result = await fetchAsinsFromApi(storeId, token, page, size);
    for (const product of result.products) {
      if (product.asin) allAsins.push(product.asin);
    }
    process.stdout.write(`\r   Sayfa ${page + 1}/${totalPages} çekildi...`);
  }

  if (totalPages > 1) console.log("");
  return allAsins;
}

/**
 * Amazon URL'sinden ASIN çıkarır
 */
function extractAsinFromUrl(url) {
  // /dp/ASIN pattern
  const dpMatch = url.match(/\/dp\/([A-Z0-9]{10})/i);
  if (dpMatch) return dpMatch[1].toUpperCase();

  // /gp/product/ASIN pattern
  const gpMatch = url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  if (gpMatch) return gpMatch[1].toUpperCase();

  return null;
}

/**
 * Tek bir ASIN'i HTTP fetch ile kontrol eder (Puppeteer'a gerek yok)
 */
async function checkAsin(asin) {
  const amazonUrl = `https://www.${CONFIG.AMAZON_DOMAIN}/dp/${asin}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.REQUEST_TIMEOUT_MS,
    );

    const res = await fetch(amazonUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    clearTimeout(timeout);

    const finalUrl = res.url;
    const finalAsin = extractAsinFromUrl(finalUrl);

    // Captcha kontrolü
    const isCaptcha =
      finalUrl.includes("captcha") ||
      finalUrl.includes("errors/validateCaptcha");

    if (isCaptcha) {
      return {
        originalAsin: asin,
        finalAsin: null,
        finalUrl,
        status: "CAPTCHA",
        redirected: false,
      };
    }

    const redirected =
      finalAsin !== null && finalAsin.toUpperCase() !== asin.toUpperCase();

    return {
      originalAsin: asin,
      finalAsin,
      finalUrl,
      status: redirected ? "REDIRECTED" : "OK",
      redirected,
    };
  } catch (error) {
    return {
      originalAsin: asin,
      finalAsin: null,
      finalUrl: null,
      status: "ERROR",
      redirected: false,
      error: error.message,
    };
  }
}

/**
 * Concurrent pool ile ASIN'leri kontrol eder, anlık sonuç gösterir
 */
async function checkAllAsins(asins) {
  const results = [];
  let completed = 0;
  let redirectCount = 0;
  let captchaCount = 0;
  let errorCount = 0;
  const total = asins.length;
  const startTime = Date.now();

  const resultFile = `results_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

  function printProgress() {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const rate = (completed / (elapsed || 1)).toFixed(1);
    const eta = completed > 0 ? (((total - completed) / rate) / 60).toFixed(1) : "?";
    process.stdout.write(
      `\r  [${completed}/${total}] ⏱${elapsed}s | ${rate}/s | ETA: ${eta}m | 🔀${redirectCount} 🤖${captchaCount} ❌${errorCount}   `,
    );
  }

  function saveProgressiveResults() {
    const report = {
      timestamp: new Date().toISOString(),
      status: completed >= total ? "COMPLETE" : "IN_PROGRESS",
      config: {
        domain: CONFIG.AMAZON_DOMAIN,
        storeId: CONFIG.STORE_ID,
      },
      summary: {
        total,
        checked: completed,
        ok: results.filter((r) => r.status === "OK").length,
        redirected: redirectCount,
        captcha: captchaCount,
        errors: errorCount,
      },
      redirectedAsins: results
        .filter((r) => r.status === "REDIRECTED")
        .map((r) => ({
          original: r.originalAsin,
          redirectedTo: r.finalAsin,
          url: r.finalUrl,
        })),
      allResults: results,
    };
    fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
  }

  // Concurrent pool
  let idx = 0;
  const workers = Array.from({ length: CONFIG.CONCURRENCY }, async () => {
    while (idx < total) {
      const currentIdx = idx++;
      const asin = asins[currentIdx];

      const result = await checkAsin(asin);
      results.push(result);
      completed++;

      if (result.status === "REDIRECTED") {
        redirectCount++;
        // Anlık göster
        process.stdout.write(
          `\n  🔀 ${result.originalAsin} → ${result.finalAsin}\n`,
        );
      } else if (result.status === "CAPTCHA") {
        captchaCount++;
      } else if (result.status === "ERROR") {
        errorCount++;
      }

      printProgress();

      // Periyodik kayıt
      if (completed % CONFIG.SAVE_EVERY === 0) {
        saveProgressiveResults();
      }

      // Küçük delay (rate limit)
      if (CONFIG.DELAY_BETWEEN_MS > 0) {
        await new Promise((r) => setTimeout(r, CONFIG.DELAY_BETWEEN_MS));
      }
    }
  });

  await Promise.all(workers);

  // Son kayıt
  saveProgressiveResults();
  console.log(`\n\n💾 Sonuçlar kaydedildi: ${resultFile}`);

  return results;
}

/**
 * Sonuçları raporla
 */
function printReport(results) {
  const redirected = results.filter((r) => r.status === "REDIRECTED");
  const ok = results.filter((r) => r.status === "OK");
  const captcha = results.filter((r) => r.status === "CAPTCHA");
  const errors = results.filter((r) => r.status === "ERROR");

  console.log("\n" + "=".repeat(80));
  console.log("                         ASIN REDIRECT CHECKER - RAPOR");
  console.log("=".repeat(80));

  console.log(`\n✅ Aynı kalan (OK):        ${ok.length}`);
  console.log(`🔀 Yönlendirilen:          ${redirected.length}`);
  console.log(`🤖 Captcha:                ${captcha.length}`);
  console.log(`❌ Hata:                   ${errors.length}`);
  console.log(`📊 Toplam kontrol edilen:  ${results.length}`);

  if (redirected.length > 0) {
    console.log("\n" + "-".repeat(80));
    console.log("🔀 YÖNLENDİRİLEN ASIN'LER:");
    console.log("-".repeat(80));

    for (const r of redirected) {
      console.log(`  ${r.originalAsin} → ${r.finalAsin}`);
      console.log(`    URL: ${r.finalUrl}\n`);
    }
  }

  if (captcha.length > 0) {
    console.log("\n⚠️  Captcha'ya takılan ASIN'ler:");
    for (const r of captcha) {
      console.log(`  ${r.originalAsin}`);
    }
  }

  if (errors.length > 0) {
    console.log("\n❌ Hatalı ASIN'ler:");
    for (const r of errors) {
      console.log(`  ${r.originalAsin}: ${r.error}`);
    }
  }

  console.log("\n" + "=".repeat(80));

  return { redirected, ok, captcha, errors };
}

/**
 * JSON olarak sonuçları kaydet (artık checkAllAsins içinde yapılıyor)
 */

// ==================== MAIN ====================
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║         ASIN REDIRECT CHECKER v1.0              ║");
  console.log("║  Syncrosale Envanter → Amazon Redirect Testi    ║");
  console.log("╚══════════════════════════════════════════════════╝");

  // Hesap seç
  const account = await selectAccount();

  // Login & token al
  let auth;
  try {
    auth = await login(account);
  } catch (err) {
    console.error("❌ Login hatası:", err.message);
    process.exit(1);
  }

  CONFIG.API_BASE = auth.apiBase;
  CONFIG.STORE_ID = auth.storeId;
  CONFIG.TOKEN = auth.token;

  // ASIN'leri API'den çek
  let asins;
  try {
    asins = await fetchAllAsins(CONFIG.STORE_ID, CONFIG.TOKEN);
  } catch (err) {
    console.error("❌ API'den ASIN çekerken hata:", err.message);
    process.exit(1);
  }

  if (asins.length === 0) {
    console.log("⚠️  Aktif ürün bulunamadı.");
    process.exit(0);
  }

  console.log(
    `\n🌐 Amazon (${CONFIG.AMAZON_DOMAIN}) üzerinde kontrol başlıyor...`,
  );
  console.log(
    `   ${CONFIG.CONCURRENCY} eşzamanlı istek ile çalışılıyor\n`,
  );

  // HTTP fetch ile concurrent kontrol
  const results = await checkAllAsins(asins);

  // Rapor
  printReport(results);
}

main().catch((err) => {
  console.error("Beklenmeyen hata:", err);
  process.exit(1);
});
