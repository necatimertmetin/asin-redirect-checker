import readline from "readline";
import fs from "fs";
import * as cheerio from "cheerio";
import { checkAsinsWithStealth } from "./check-asin-stealth.js";

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
  REQUEST_TIMEOUT_MS: 15000, // HTTP istek timeout
  DELAY_BETWEEN_MS: 500, // İstekler arası bekleme (rate limit)

  // Concurrency
  CONCURRENCY: 20, // Aynı anda kaç istek

  // Pagination
  PAGE_SIZE: 100, // API'den kaç ürün çekilecek (sayfa başına)
  MAX_PRODUCTS: null, // null = hepsini çek, sayı = limit

  // Kayıt
  SAVE_EVERY: 500, // Kaç ASIN'de bir dosyaya kaydet (JSON)
  SAVE_EVERY_MD: 10, // Kaç ASIN'de bir MD raporu güncelle
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
 * Syncrosale API'den NO_DATA ürünlerini tam obje olarak çeker
 */
async function fetchNotFoundProductsFromApi(
  storeId,
  token,
  page = 0,
  size = 100,
) {
  const predicate = encodeURIComponent(JSON.stringify({
    type: "and",
    predicates: [{ property: "storeProductStatus", type: "eq", value: "NO_DATA" }],
  }));
  const url = `${CONFIG.API_BASE}/store/${storeId}/product/detailed2?page=${page}&size=${size}&predicate=${predicate}`;

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
 * Tüm NO_DATA ürünleri (tam obje) çeker
 */
async function fetchAllNotFoundProducts(storeId, token) {
  const allProducts = [];
  const size = CONFIG.PAGE_SIZE;

  console.log("📦 Syncrosale API'den NO_DATA ürünler çekiliyor...\n");

  const firstPage = await fetchNotFoundProductsFromApi(storeId, token, 0, size);
  const total = firstPage.total;

  console.log(`   Toplam NO_DATA ürün: ${total}\n`);

  for (const product of firstPage.products) {
    if (product.asin) allProducts.push(product);
  }

  const totalPages = Math.ceil(total / size);

  for (let page = 1; page < totalPages; page++) {
    const result = await fetchNotFoundProductsFromApi(
      storeId,
      token,
      page,
      size,
    );
    for (const product of result.products) {
      if (product.asin) allProducts.push(product);
    }
    process.stdout.write(`\r   Sayfa ${page + 1}/${totalPages} çekildi...`);
  }

  if (totalPages > 1) console.log("");
  return allProducts;
}

// ==================== AMAZON HTML PARSER ====================
// Java'daki AmazonProductPageParser + BaseAmazonParser mantığı

const PRICE_SELECTORS = [
  "#apex-pricetopay-accessibility-label",
  ".aok-offscreen",
  "#priceblock_ourprice",
  "#priceblock_dealprice",
  "#priceblock_saleprice",
  "#price_inside_buybox",
  ".apexPriceToPay .a-offscreen",
  "#corePriceDisplay_desktop_feature_div .a-offscreen",
  ".a-price .a-offscreen",
  ".a-price",
];

// BaseAmazonParser.parsePriceString: rakam ve nokta dışındaki her şeyi sil,
// birden fazla nokta varsa ilkini decimal olarak kullan
function parsePriceString(str) {
  if (!str) return null;
  let s = str.replace(/[^0-9.]/g, "");
  if (!s) return null;
  const first = s.indexOf(".");
  const last = s.lastIndexOf(".");
  if (first !== last && first !== -1) {
    s = s.slice(0, first + 1) + s.slice(first + 1).replace(/\./g, "");
  }
  const num = parseFloat(s);
  return isNaN(num) ? null : num;
}

// AmazonProductPageParser.extractMainPrice
function extractPriceFromHtml($) {
  for (const sel of PRICE_SELECTORS) {
    const el = $(sel).first();
    if (el.length) {
      const price = parsePriceString(el.text().trim());
      if (price !== null && price > 0) return price;
    }
  }
  return null;
}

function isValidProductPage($) {
  return $("#productTitle").length > 0 || $("[data-feature-name='title']").length > 0;
}

// AmazonProductPageParser.extractStock
function extractStockFromHtml($) {
  // primeSavingsUpsellAccordionRow → newAccordionRow_0 öncelik sırası
  let availSpan = $("#primeSavingsUpsellAccordionRow");
  if (!availSpan.length) availSpan = $("#newAccordionRow_0");

  let availabilityText = null;

  if (availSpan.length) {
    const availEl = availSpan.find("#availability span").first();
    if (!availEl.length) {
      // stok bilgisi yoksa = stokta var (usedOnlyBuybox içinde değilse)
      if (!availSpan.closest("#usedOnlyBuybox").length) return 1000;
    } else {
      availabilityText = availEl.text().trim();
    }
  }

  if (!availabilityText) {
    const availEl = $("#availability span").first();
    if (availEl.length && !availEl.closest("#usedOnlyBuybox").length) {
      availabilityText = availEl.text().trim();
    }
  }

  if (availabilityText) {
    const lowered = availabilityText.replace(/ /g, " ").toLowerCase();
    const match = lowered.match(/(\d+)\s+left in stock/);
    if (match) return parseInt(match[1], 10);
    if (lowered.includes("in stock")) return 1000;
  }

  // Fallback: quantity select dropdown'ın max değeri
  const options = $("select#quantity option");
  if (options.length) {
    let max = 0;
    options.each((_, el) => {
      const val = parseInt($(el).attr("value"), 10);
      if (!isNaN(val) && val > max) max = val;
    });
    if (max > 0) return max;
  }

  return 0;
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
 * Tek bir ASIN'i HTTP fetch ile kontrol eder.
 * parseDetails=true ise Amazon HTML'ini parse edip price ve stock da döner.
 */
async function checkAsin(asin, parseDetails = false) {
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

    const isCaptchaUrl =
      finalUrl.includes("captcha") ||
      finalUrl.includes("errors/validateCaptcha");

    if (isCaptchaUrl) {
      return {
        originalAsin: asin,
        finalAsin: null,
        finalUrl,
        status: "CAPTCHA",
        redirected: false,
        price: null,
        stock: null,
      };
    }

    const redirected =
      finalAsin !== null && finalAsin.toUpperCase() !== asin.toUpperCase();

    let price = null;
    let stock = null;

    if (!redirected) {
      const html = await res.text();
      const $ = cheerio.load(html);

      // HTML içinde inline captcha veya bot engeli var mı kontrol et
      const title = $("title").text().toLowerCase();
      const hasCaptchaForm = $("form[action*='validateCaptcha']").length > 0;
      const isRobotCheck =
        title.includes("robot check") ||
        title.includes("captcha") ||
        title.includes("sorry") ||
        hasCaptchaForm;

      if (isRobotCheck) {
        return {
          originalAsin: asin,
          finalAsin: null,
          finalUrl,
          status: "CAPTCHA",
          redirected: false,
          price: null,
          stock: null,
        };
      }

      // Soft bot-block: Amazon served a structureless page without redirecting to captcha
      if (!isValidProductPage($)) {
        return {
          originalAsin: asin,
          finalAsin: null,
          finalUrl,
          status: "CAPTCHA",
          redirected: false,
          price: null,
          stock: null,
        };
      }

      if (parseDetails) {
        price = extractPriceFromHtml($);
        stock = extractStockFromHtml($);
      }
    }

    return {
      originalAsin: asin,
      finalAsin,
      finalUrl,
      status: redirected ? "REDIRECTED" : "OK",
      redirected,
      price,
      stock,
    };
  } catch (error) {
    return {
      originalAsin: asin,
      finalAsin: null,
      finalUrl: null,
      status: "ERROR",
      redirected: false,
      price: null,
      stock: null,
      error: error.message,
    };
  }
}

/**
 * Concurrent pool ile ASIN'leri kontrol eder, anlık sonuç gösterir
 */
async function checkAllAsins(asins, options = {}) {
  const { parseDetails = false } = options;
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
    const eta =
      completed > 0 ? ((total - completed) / rate / 60).toFixed(1) : "?";
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

      const result = await checkAsin(asin, parseDetails);
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

// ==================== NO_DATA MD RAPORU ====================

function generateNoDataReport(amazonResults, totalNotFound, storeId, syncroDataMap = {}, status = "IN_PROGRESS") {
  const okResults = amazonResults.filter((r) => r.status === "OK");
  const redirected = amazonResults.filter((r) => r.status === "REDIRECTED");
  const captcha = amazonResults.filter((r) => r.status === "CAPTCHA");
  const errors = amazonResults.filter((r) => r.status === "ERROR");

  const detailIssues = [];
  for (const result of okResults) {
    const issues = [];
    if (result.price === null) issues.push("price bulunamadı (Amazon)");
    else if (result.price <= 0) issues.push(`price geçersiz (${result.price})`);
    if (result.stock === null || result.stock <= 0) issues.push("stok yok (Amazon)");
    if (issues.length > 0) {
      detailIssues.push({ asin: result.originalAsin, issues, fields: { price: result.price, stock: result.stock } });
    }
  }

  const onlyPriceIssue = detailIssues.filter(
    (i) => i.issues.some((x) => x.includes("price")) && !i.issues.some((x) => x.includes("stok"))
  );
  const onlyStockIssue = detailIssues.filter(
    (i) => !i.issues.some((x) => x.includes("price")) && i.issues.some((x) => x.includes("stok"))
  );
  const bothIssues = detailIssues.filter(
    (i) => i.issues.some((x) => x.includes("price")) && i.issues.some((x) => x.includes("stok"))
  );
  const healthyAsins = okResults.filter(
    (r) => !detailIssues.some((d) => d.asin === r.originalAsin)
  );
  const healthyCount = healthyAsins.length;

  const checked = amazonResults.length;
  const pct = (n, d) => (d === 0 ? "0.0" : ((n / d) * 100).toFixed(1));
  const bar = (n, d, w = 24) => {
    const filled = d === 0 ? 0 : Math.round((n / d) * w);
    return "█".repeat(filled) + "░".repeat(w - filled);
  };
  const fmt = (n) => n.toLocaleString("tr-TR");
  const now = new Date().toISOString();

  let md = "";
  md += `# NO_DATA Ürün Analiz Raporu\n\n`;
  md += `**Tarih:** ${now}  \n`;
  md += `**Store ID:** ${storeId}  \n`;
  md += `**Durum:** ${status === "COMPLETE" ? "✅ Tamamlandı" : `⏳ Devam ediyor (${fmt(checked)}/${fmt(totalNotFound)})`}\n\n`;
  md += `---\n\n`;

  md += `## 📋 Genel Özet\n\n`;
  md += `Toplam **${fmt(totalNotFound)}** NO_DATA ürün içinden **${fmt(checked)}** Amazon'da kontrol edildi.\n\n`;
  md += `| Amazon Durumu | Sayı | Oran | Grafik |\n`;
  md += `|--------------|-----:|-----:|--------|\n`;
  md += `| ✅ Geçerli (OK) | ${fmt(okResults.length)} | %${pct(okResults.length, checked)} | \`${bar(okResults.length, checked)}\` |\n`;
  md += `| 🔀 Yönlendirilen | ${fmt(redirected.length)} | %${pct(redirected.length, checked)} | \`${bar(redirected.length, checked)}\` |\n`;
  md += `| 🤖 Captcha | ${fmt(captcha.length)} | %${pct(captcha.length, checked)} | \`${bar(captcha.length, checked)}\` |\n`;
  md += `| ❌ Hata | ${fmt(errors.length)} | %${pct(errors.length, checked)} | \`${bar(errors.length, checked)}\` |\n`;
  md += `\n---\n\n`;

  md += `## 📊 Price / Stock Analizi\n\n`;
  md += `> Amazon'da geçerli bulunan **${fmt(okResults.length)}** ürün üzerinden.\n\n`;
  md += `| Kategori | Sayı | Oran | Grafik |\n`;
  md += `|---------|-----:|-----:|--------|\n`;
  md += `| ✅ Sorunsuz (price ✓, stock ✓) | ${fmt(healthyCount)} | %${pct(healthyCount, okResults.length)} | \`${bar(healthyCount, okResults.length)}\` |\n`;
  md += `| 🔴 Sadece price sorunu | ${fmt(onlyPriceIssue.length)} | %${pct(onlyPriceIssue.length, okResults.length)} | \`${bar(onlyPriceIssue.length, okResults.length)}\` |\n`;
  md += `| 🟡 Sadece stok sorunu | ${fmt(onlyStockIssue.length)} | %${pct(onlyStockIssue.length, okResults.length)} | \`${bar(onlyStockIssue.length, okResults.length)}\` |\n`;
  md += `| 🟠 Price + Stok sorunu | ${fmt(bothIssues.length)} | %${pct(bothIssues.length, okResults.length)} | \`${bar(bothIssues.length, okResults.length)}\` |\n`;
  md += `| **Toplam sorunlu** | **${fmt(detailIssues.length)}** | **%${pct(detailIssues.length, okResults.length)}** | \`${bar(detailIssues.length, okResults.length)}\` |\n`;
  md += `\n---\n\n`;

  const stockLabel = (v) =>
    v === null ? "-" : v >= 1000 ? "In Stock" : v === 0 ? "Out of Stock" : String(v);

  const asinRow = (item) => {
    const p = item.fields.price !== null ? `$${item.fields.price.toFixed(2)}` : "-";
    const s = stockLabel(item.fields.stock);
    return `| \`${item.asin}\` | ${p} | ${s} |\n`;
  };
  const healthyRow = (r) => {
    const p = r.price !== null ? `$${r.price.toFixed(2)}` : "-";
    const s = stockLabel(r.stock);
    const sd = syncroDataMap[r.originalAsin] || {};
    const sp = sd.price != null ? `$${Number(sd.price).toFixed(2)}` : "-";
    const ss = stockLabel(sd.stock ?? null);
    return `| \`${r.originalAsin}\` | ${p} | ${s} | ${sp} | ${ss} |\n`;
  };
  const tableHeader = `| ASIN | Price | Stock |\n|:-----|------:|------:|\n`;
  const healthyTableHeader = `| ASIN | Amazon Price | Amazon Stock | Syncrosale Price | Syncrosale Stock |\n|:-----|------:|------:|------:|------:|\n`;

  if (healthyAsins.length > 0) {
    md += `## ✅ Sorunsuz ASIN'ler *(${fmt(healthyAsins.length)} ürün)*\n\n`;
    md += `Amazon'da hem fiyat hem stok bilgisi eksiksiz olan ürünler.\n\n`;
    md += healthyTableHeader;
    for (const r of healthyAsins) md += healthyRow(r);
    md += `\n---\n\n`;
  }

  if (redirected.length > 0) {
    md += `## 🔀 Yönlendirilen ASIN'ler *(${fmt(redirected.length)} adet)*\n\n`;
    md += `| Orijinal ASIN | Yönlendirilen ASIN | URL |\n`;
    md += `|:-------------|:------------------|:----|\n`;
    for (const r of redirected) {
      md += `| \`${r.originalAsin}\` | \`${r.finalAsin || "-"}\` | ${r.finalUrl || "-"} |\n`;
    }
    md += `\n---\n\n`;
  }

  if (onlyPriceIssue.length > 0) {
    md += `## 🔴 Sadece Price Sorunu *(${fmt(onlyPriceIssue.length)} ürün)*\n\n`;
    md += `Amazon sayfasında fiyat bilgisi bulunamayan veya geçersiz olan ürünler.\n\n`;
    md += tableHeader;
    for (const item of onlyPriceIssue) md += asinRow(item);
    md += `\n---\n\n`;
  }

  if (onlyStockIssue.length > 0) {
    md += `## 🟡 Sadece Stok Sorunu *(${fmt(onlyStockIssue.length)} ürün)*\n\n`;
    md += `Fiyatı olan fakat Amazon'da stokta bulunmayan ürünler.\n\n`;
    md += tableHeader;
    for (const item of onlyStockIssue) md += asinRow(item);
    md += `\n---\n\n`;
  }

  if (bothIssues.length > 0) {
    md += `## 🟠 Price + Stok Sorunu *(${fmt(bothIssues.length)} ürün)*\n\n`;
    md += `Amazon sayfasında hem fiyat hem stok bilgisi eksik/geçersiz olan ürünler.\n\n`;
    md += tableHeader;
    for (const item of bothIssues) md += asinRow(item);
    md += `\n---\n\n`;
  }

  if (captcha.length > 0) {
    md += `## 🤖 Captcha'ya Takılan ASIN'ler *(${fmt(captcha.length)} adet)*\n\n`;
    md += captcha.map((r) => `- \`${r.originalAsin}\``).join("\n");
    md += `\n\n---\n\n`;
  }

  if (errors.length > 0) {
    md += `## ❌ Hata Alan ASIN'ler *(${fmt(errors.length)} adet)*\n\n`;
    md += `| ASIN | Hata |\n|:-----|:-----|\n`;
    for (const r of errors) {
      md += `| \`${r.originalAsin}\` | ${r.error || "-"} |\n`;
    }
    md += `\n`;
  }

  return md;
}

// ==================== MAIN ====================
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║         ASIN REDIRECT CHECKER v1.0              ║");
  console.log("║  Syncrosale Envanter → Amazon Redirect Testi    ║");
  console.log("╚══════════════════════════════════════════════════╝");

  // Eğer parametre olarak bir ASIN verildiyse sadece onu kontrol et
  const arg = process.argv[2];
  if (arg && /^[A-Z0-9]{10}$/i.test(arg)) {
    // Tek ASIN kontrolü (önce Puppeteer ile dene)
    console.log(`\n🔎 Tekil ASIN kontrolü (Puppeteer): ${arg}\n`);
    let result;
    try {
      const { checkAsinWithPuppeteer } =
        await import("./check-asin-puppeteer.js");
      result = await checkAsinWithPuppeteer(arg, { waitMs: 10000 });
    } catch (e) {
      console.log("❌ Puppeteer ile kontrol başarısız: ", e.message);
      console.log("npm install puppeteer komutunu çalıştırın.");
      process.exit(1);
    }
    console.log(result);
    if (result.status === "REDIRECTED") {
      console.log(
        `\n🔀 Yönlendirildi: ${result.originalAsin} → ${result.finalAsin}`,
      );
      console.log(`URL: ${result.finalUrl}`);
    } else if (result.status === "OK") {
      console.log("\n✅ Yönlendirme yok, ASIN aynı kaldı.");
    } else {
      console.log(`\n❌ Hata: ${result.error || result.status}`);
    }
    return;
  }

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

  // Kullanıcıya seçenek sun
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function askMenu() {
    return new Promise((resolve) => {
      console.log("\nNe kontrol edilsin?");
      console.log("  1) Aktif ürünler");
      console.log("  2) Not Found ürünler");
      rl.question("Seçim (1/2): ", (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  const menuChoice = await askMenu();

  if (menuChoice === "1") {
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
    console.log(`   ${CONFIG.CONCURRENCY} eşzamanlı istek ile çalışılıyor\n`);

    // HTTP fetch ile concurrent kontrol
    const results = await checkAllAsins(asins);

    // Rapor
    printReport(results);
  } else if (menuChoice === "2") {
    const asinCacheFile = `NO_DATA_asins_store${CONFIG.STORE_ID}.txt`;
    const syncroCacheFile = `NO_DATA_syncro_store${CONFIG.STORE_ID}.json`;
    let notFoundAsins;
    let syncroDataMap = {};

    if (fs.existsSync(asinCacheFile)) {
      console.log(`\n📂 Cache dosyası bulundu: ${asinCacheFile}`);
      notFoundAsins = fs.readFileSync(asinCacheFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      console.log(`   ${notFoundAsins.length} ASIN cache'den yüklendi.`);
      if (fs.existsSync(syncroCacheFile)) {
        try {
          syncroDataMap = JSON.parse(fs.readFileSync(syncroCacheFile, "utf8"));
        } catch {}
      }
    } else {
      let notFoundProducts;
      try {
        notFoundProducts = await fetchAllNotFoundProducts(
          CONFIG.STORE_ID,
          CONFIG.TOKEN,
        );
      } catch (err) {
        console.error("❌ NO_DATA ürünler çekilirken hata:", err.message);
        process.exit(1);
      }

      if (notFoundProducts.length === 0) {
        console.log("⚠️  NO_DATA ürün bulunamadı.");
        process.exit(0);
      }

      notFoundAsins = notFoundProducts.map((p) => p.asin);
      for (const p of notFoundProducts) {
        if (!p.asin) continue;
        syncroDataMap[p.asin] = {
          price: p.price?.finalPrice ?? p.finalPrice ?? null,
          stock: p.stock ?? null,
        };
      }
      fs.writeFileSync(asinCacheFile, notFoundAsins.join("\n"), "utf8");
      fs.writeFileSync(syncroCacheFile, JSON.stringify(syncroDataMap), "utf8");
      console.log(`\n💾 ${notFoundAsins.length} ASIN cache'e yazıldı: ${asinCacheFile}`);
    }

    const total = notFoundAsins.length;
    console.log(
      `\n🥷 Amazon'da ${total} ASIN stealth mod ile kontrol ediliyor (3 tarayıcı)...\n`,
    );

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const reportFile = `NO_DATA_report_${ts}.md`;
    const detailFile = `NO_DATA_detail_issues_${ts}.json`;

    const accumulatedResults = [];
    const startTime = Date.now();
    let captchaCount = 0;
    let okCount = 0;
    let redirectCount = 0;

    function printStealthProgress(completed) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (completed / (elapsed || 1)).toFixed(2);
      const eta = completed > 0 ? ((total - completed) / rate / 60).toFixed(1) : "?";
      process.stdout.write(
        `\r  [${completed}/${total}] ⏱${elapsed}s | ${rate}/s | ETA: ${eta}m | ✅${okCount} 🤖${captchaCount} 🔀${redirectCount}   `,
      );
    }

    const amazonResults = await checkAsinsWithStealth(notFoundAsins, {
      concurrency: 3,
      minDelayMs: 2000,
      maxDelayMs: 5000,
      parseDetails: true,
      onResult: (result, completed) => {
        accumulatedResults.push(result);
        if (result.status === "CAPTCHA") captchaCount++;
        else if (result.status === "OK") okCount++;
        else if (result.status === "REDIRECTED") {
          redirectCount++;
          process.stdout.write(`\n  🔀 ${result.originalAsin} → ${result.finalAsin}\n`);
        }
        printStealthProgress(completed);

        if (completed % CONFIG.SAVE_EVERY_MD === 0) {
          const mdContent = generateNoDataReport(accumulatedResults, total, CONFIG.STORE_ID, syncroDataMap, "IN_PROGRESS");
          fs.writeFileSync(reportFile, mdContent);
        }
      },
    });

    console.log("\n");
    printReport(amazonResults);

    // Final MD raporu
    const finalMd = generateNoDataReport(amazonResults, total, CONFIG.STORE_ID, syncroDataMap, "COMPLETE");
    fs.writeFileSync(reportFile, finalMd);
    console.log(`\n📄 Markdown raporu kaydedildi: ${reportFile}`);

    // JSON özet
    const okResults = amazonResults.filter((r) => r.status === "OK");
    const redirected = amazonResults.filter((r) => r.status === "REDIRECTED");
    const captcha = amazonResults.filter((r) => r.status === "CAPTCHA");
    const errors = amazonResults.filter((r) => r.status === "ERROR");

    const detailIssues = [];
    for (const result of okResults) {
      const issues = [];
      if (result.price === null) issues.push("price bulunamadı (Amazon)");
      else if (result.price <= 0) issues.push(`price geçersiz (${result.price})`);
      if (result.stock === null || result.stock <= 0) issues.push("stok yok (Amazon)");
      if (issues.length > 0) {
        detailIssues.push({ asin: result.originalAsin, issues, fields: { price: result.price, stock: result.stock } });
      }
    }

    fs.writeFileSync(
      detailFile,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          totalNotFound: total,
          amazonSummary: {
            ok: okResults.length,
            redirected: redirected.length,
            captcha: captcha.length,
            errors: errors.length,
          },
          detailIssues,
        },
        null,
        2,
      ),
    );
    console.log(`💾 Detay sorunları kaydedildi: ${detailFile}`);
  } else {
    console.log("❌ Geçersiz seçim. Çıkılıyor.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Beklenmeyen hata:", err);
  process.exit(1);
});
