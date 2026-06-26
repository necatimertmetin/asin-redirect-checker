import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as cheerio from "cheerio";
import fs from "fs";

puppeteerExtra.use(StealthPlugin());

// ── Konfigürasyon ─────────────────────────────────────────────
const INPUT_FILE = "asins.txt";
const CONCURRENCY = 3;
const DELAY_MIN_MS = 1200;
const DELAY_MAX_MS = 2800;
const SAVE_EVERY = 10;

const MARKETS = [
  { key: "us", domain: "amazon.com", label: "Amazon US" },
  { key: "ae", domain: "amazon.ae", label: "Amazon AE" },
];

// ── URL'den ASIN çıkar ────────────────────────────────────────
function extractAsinFromUrl(url) {
  const m =
    url.match(/\/dp\/([A-Z0-9]{10})/i) ||
    url.match(/\/gp\/product\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

function randomDelay() {
  const ms = Math.floor(
    Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS) + DELAY_MIN_MS,
  );
  return new Promise((r) => setTimeout(r, ms));
}

// ── Sayfa analizi → FOUND | NOT_FOUND | CAPTCHA ───────────────
// NOT_FOUND kapsamı: ürün yok + farklı varyasyona yönlendirme
function classifyPage($, originalAsin, finalUrl) {
  const finalAsin = extractAsinFromUrl(finalUrl);

  // Captcha / robot check
  const pageTitle = $("title").text().toLowerCase();
  const hasCaptchaForm = $("form[action*='validateCaptcha']").length > 0;
  if (
    pageTitle.includes("robot check") ||
    pageTitle.includes("captcha") ||
    pageTitle.includes("sorry") ||
    hasCaptchaForm
  ) {
    return { status: "CAPTCHA", finalAsin };
  }

  // Farklı ASIN'e yönlendirme → NOT_FOUND
  if (finalAsin && finalAsin !== originalAsin.toUpperCase()) {
    return { status: "NOT_FOUND", finalAsin, note: `→ ${finalAsin}` };
  }

  // Ürün başlığı var mı?
  const hasTitle =
    $("#productTitle").length > 0 ||
    $("[data-feature-name='title']").length > 0 ||
    $("h1#title").length > 0;

  if (!hasTitle) {
    return { status: "NOT_FOUND", finalAsin: null };
  }

  return { status: "FOUND", finalAsin };
}

// ── Tek market üzerinde ASIN kontrolü ────────────────────────
async function checkAsinOnMarket(browser, asin, market) {
  const startUrl = `https://www.${market.domain}/dp/${asin}`;
  let page;

  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setViewport({ width: 1280, height: 800 });

    let finalUrl = startUrl;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) finalUrl = frame.url();
    });

    await page.goto(startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await new Promise((r) => setTimeout(r, 2500));
    finalUrl = page.url();

    if (finalUrl.includes("captcha") || finalUrl.includes("validateCaptcha")) {
      return { status: "CAPTCHA", finalUrl, finalAsin: null };
    }

    // Arama sayfasına yönlendirme = NOT_FOUND
    if (
      finalUrl.includes("/s?k=") ||
      finalUrl.includes("/s/?k=") ||
      finalUrl.includes("/s/ref=")
    ) {
      return { status: "NOT_FOUND", finalUrl, finalAsin: null };
    }

    const html = await page.content();
    const $ = cheerio.load(html);
    const { status, finalAsin, note } = classifyPage($, asin, finalUrl);

    return { status, finalUrl, finalAsin, note };
  } catch (error) {
    return {
      status: "ERROR",
      finalUrl: null,
      finalAsin: null,
      error: error.message,
    };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ── İki market için ASIN kontrolü ────────────────────────────
async function checkAsin(browser, asin) {
  const result = { asin };
  for (const market of MARKETS) {
    result[market.key] = await checkAsinOnMarket(browser, asin, market);
    await new Promise((r) => setTimeout(r, 800));
  }
  return result;
}

// ── Kombinasyon anahtarı ──────────────────────────────────────
// FOUND/NOT_FOUND/CAPTCHA/ERROR × FOUND/NOT_FOUND/CAPTCHA/ERROR
function comboKey(result) {
  const us = result.us?.status || "ERROR";
  const ae = result.ae?.status || "ERROR";
  return `${us}__${ae}`;
}

// ── Markdown rapor ────────────────────────────────────────────
function generateReport(results, totalCount, reportStatus = "IN_PROGRESS") {
  const now = new Date().toISOString();
  const checked = results.length;
  const fmt = (n) => n.toLocaleString("tr-TR");
  const pct = (n, d) => (d === 0 ? "0.0" : ((n / d) * 100).toFixed(1));

  // Tüm kombinasyonları topla
  const comboMap = {};
  for (const r of results) {
    const key = comboKey(r);
    if (!comboMap[key]) comboMap[key] = [];
    comboMap[key].push(r);
  }

  // Kombinasyon tanımları (öncelik sırasıyla)
  const COMBO_DEFS = [
    { key: "FOUND__FOUND", icon: "✅", label: "US: Found  |  AE: Found" },
    {
      key: "FOUND__NOT_FOUND",
      icon: "🟡",
      label: "US: Found  |  AE: Not Found",
    },
    {
      key: "NOT_FOUND__FOUND",
      icon: "🟠",
      label: "US: Not Found  |  AE: Found",
    },
    {
      key: "NOT_FOUND__NOT_FOUND",
      icon: "❌",
      label: "US: Not Found  |  AE: Not Found",
    },
    {
      key: "FOUND__CAPTCHA",
      icon: "🟡",
      label: "US: Found  |  AE: Captcha (belirsiz)",
    },
    {
      key: "CAPTCHA__FOUND",
      icon: "🟠",
      label: "US: Captcha (belirsiz)  |  AE: Found",
    },
    {
      key: "CAPTCHA__NOT_FOUND",
      icon: "⚠️",
      label: "US: Captcha  |  AE: Not Found",
    },
    {
      key: "NOT_FOUND__CAPTCHA",
      icon: "⚠️",
      label: "US: Not Found  |  AE: Captcha",
    },
    {
      key: "CAPTCHA__CAPTCHA",
      icon: "🤖",
      label: "US: Captcha  |  AE: Captcha",
    },
    { key: "ERROR__ERROR", icon: "💥", label: "US: Error  |  AE: Error" },
  ];

  // Dinamik olarak tanımda olmayan kombinasyonları da ekle
  const knownKeys = new Set(COMBO_DEFS.map((d) => d.key));
  for (const key of Object.keys(comboMap)) {
    if (!knownKeys.has(key)) {
      const [us, ae] = key.split("__");
      COMBO_DEFS.push({ key, icon: "⚠️", label: `US: ${us}  |  AE: ${ae}` });
    }
  }

  let md = "";
  md += `# ASIN List Raporu\n\n`;
  md += `**Tarih:** ${now}  \n`;
  md += `**Dosya:** \`${INPUT_FILE}\`  \n`;
  md += `**Durum:** ${reportStatus === "COMPLETE" ? "✅ Tamamlandı" : `⏳ Devam ediyor (${fmt(checked)}/${fmt(totalCount)})`}\n\n`;
  md += `---\n\n`;

  // Özet
  md += `## 📊 Özet\n\n`;
  md += `Toplam **${fmt(totalCount)}** ASIN içinden **${fmt(checked)}** kontrol edildi.\n\n`;
  md += `| Kombinasyon | Sayı | Oran |\n`;
  md += `|:------------|-----:|-----:|\n`;
  for (const def of COMBO_DEFS) {
    const items = comboMap[def.key];
    if (!items || items.length === 0) continue;
    md += `| ${def.icon} ${def.label} | ${fmt(items.length)} | %${pct(items.length, checked)} |\n`;
  }
  md += `\n---\n\n`;

  // Her kombinasyon için detay bölümü
  for (const def of COMBO_DEFS) {
    const items = comboMap[def.key];
    if (!items || items.length === 0) continue;

    md += `## ${def.icon} ${def.label} *(${fmt(items.length)} ASIN)*\n\n`;

    // NOT_FOUND olan sütuna "note" göster (farklı varyasyon ise → ASIN yaz)
    const [usStatus, aeStatus] = def.key.split("__");
    const showUsNote = usStatus === "NOT_FOUND";
    const showAeNote = aeStatus === "NOT_FOUND";

    if (showUsNote || showAeNote) {
      md += `| ASIN | US | AE |\n`;
      md += `|:-----|:---|:---|\n`;
      for (const r of items) {
        const usCell = r.us?.note
          ? `NOT_FOUND (${r.us.note})`
          : r.us?.status || "-";
        const aeCell = r.ae?.note
          ? `NOT_FOUND (${r.ae.note})`
          : r.ae?.status || "-";
        md += `| \`${r.asin}\` | ${usCell} | ${aeCell} |\n`;
      }
    } else {
      md += `| ASIN |\n`;
      md += `|:-----|\n`;
      for (const r of items) {
        md += `| \`${r.asin}\` |\n`;
      }
    }

    md += `\n---\n\n`;
  }

  return md;
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║        ASIN LIST CHECKER - US & AE               ║");
  console.log("╚══════════════════════════════════════════════════╝");

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌ Dosya bulunamadı: ${INPUT_FILE}`);
    process.exit(1);
  }

  const asins = fs
    .readFileSync(INPUT_FILE, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim().toUpperCase())
    .filter((l) => /^[A-Z0-9]{10}$/.test(l));

  if (asins.length === 0) {
    console.error(`❌ ${INPUT_FILE} içinde geçerli ASIN bulunamadı.`);
    process.exit(1);
  }

  const total = asins.length;
  console.log(`\n📋 ${total} ASIN yüklendi: ${INPUT_FILE}`);
  console.log(`🌐 Marketler: Amazon US & Amazon AE`);
  console.log(`⚙️  Eşzamanlı: ${CONCURRENCY} ASIN\n`);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportFile = `asin-list-report_${ts}.md`;

  const results = [];
  let completed = 0;
  const startTime = Date.now();

  const browsers = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      puppeteerExtra.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=en-US"],
      }),
    ),
  );

  let idx = 0;

  const workers = browsers.map(async (browser) => {
    while (idx < total) {
      const currentIdx = idx++;
      const asin = asins[currentIdx];

      const result = await checkAsin(browser, asin);
      results.push(result);
      completed++;

      const usS = result.us?.status || "?";
      const aeS = result.ae?.status || "?";
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (completed / (elapsed || 1)).toFixed(2);
      const eta =
        completed > 0 ? ((total - completed) / rate / 60).toFixed(1) : "?";

      const icon =
        usS === "FOUND" && aeS === "FOUND"
          ? "✅"
          : usS === "FOUND" || aeS === "FOUND"
            ? "🟡"
            : usS === "NOT_FOUND" && aeS === "NOT_FOUND"
              ? "❌"
              : "⚠️";

      process.stdout.write(
        `\r  ${icon} ${asin} | US: ${usS.padEnd(10)} AE: ${aeS.padEnd(10)} | ${completed}/${total} | ⏱${elapsed}s | ETA: ${eta}m   \n`,
      );

      if (completed % SAVE_EVERY === 0 || completed === total) {
        const md = generateReport(
          results,
          total,
          completed === total ? "COMPLETE" : "IN_PROGRESS",
        );
        fs.writeFileSync(reportFile, md, "utf8");
        process.stdout.write(`  💾 ${reportFile} güncellendi\n`);
      }

      await randomDelay();
    }
  });

  await Promise.all(workers);

  // ── Captcha retry döngüsü ─────────────────────────────────────
  let retryRound = 0;
  let captchaAsins = results
    .filter((r) => r.us?.status === "CAPTCHA" || r.ae?.status === "CAPTCHA")
    .map((r) => r.asin);

  while (captchaAsins.length > 0) {
    retryRound++;
    console.log(
      `\n🔄 Captcha retry turu ${retryRound}: ${captchaAsins.length} ASIN yeniden deneniyor...\n`,
    );

    const retryResults = [];
    let retryIdx = 0;

    const retryWorkers = browsers.map(async (browser) => {
      while (retryIdx < captchaAsins.length) {
        const ci = retryIdx++;
        const asin = captchaAsins[ci];

        await randomDelay();
        const result = await checkAsin(browser, asin);
        retryResults.push(result);

        const usS = result.us?.status || "?";
        const aeS = result.ae?.status || "?";
        process.stdout.write(
          `  🔄 [Tur ${retryRound}] ${asin} | US: ${usS.padEnd(10)} AE: ${aeS.padEnd(10)}\n`,
        );
      }
    });

    await Promise.all(retryWorkers);

    // Sonuçları güncelle
    for (const retryResult of retryResults) {
      const existingIdx = results.findIndex((r) => r.asin === retryResult.asin);
      if (existingIdx !== -1) {
        // Sadece CAPTCHA olan marketleri güncelle, diğerini koru
        const existing = results[existingIdx];
        if (existing.us?.status === "CAPTCHA") existing.us = retryResult.us;
        if (existing.ae?.status === "CAPTCHA") existing.ae = retryResult.ae;
      }
    }

    const md = generateReport(results, total, "COMPLETE");
    fs.writeFileSync(reportFile, md, "utf8");
    process.stdout.write(`  💾 ${reportFile} güncellendi\n`);

    // Hâlâ captcha kalanları bul
    captchaAsins = results
      .filter((r) => r.us?.status === "CAPTCHA" || r.ae?.status === "CAPTCHA")
      .map((r) => r.asin);

    if (captchaAsins.length > 0) {
      console.log(
        `  ⏳ ${captchaAsins.length} ASIN hâlâ captcha, tekrar denenecek...`,
      );
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  await Promise.all(browsers.map((b) => b.close().catch(() => {})));

  const finalMd = generateReport(results, total, "COMPLETE");
  fs.writeFileSync(reportFile, finalMd, "utf8");

  // Terminal özeti
  const comboMap = {};
  for (const r of results) {
    const k = comboKey(r);
    comboMap[k] = (comboMap[k] || 0) + 1;
  }

  console.log("\n" + "=".repeat(55));
  console.log("                    SONUÇ");
  console.log("=".repeat(55));
  for (const [k, count] of Object.entries(comboMap).sort()) {
    const [us, ae] = k.split("__");
    console.log(`  US: ${us.padEnd(12)} AE: ${ae.padEnd(12)} → ${count}`);
  }
  console.log(`${"─".repeat(55)}`);
  console.log(`  Toplam: ${results.length}`);
  console.log("=".repeat(55));
  console.log(`\n📄 Rapor: ${reportFile}\n`);
}

main().catch((err) => {
  console.error("❌ Beklenmeyen hata:", err);
  process.exit(1);
});
