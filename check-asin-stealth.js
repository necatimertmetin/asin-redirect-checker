import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as cheerio from "cheerio";

puppeteerExtra.use(StealthPlugin());

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
  return (
    $("#productTitle").length > 0 || $("[data-feature-name='title']").length > 0
  );
}

function extractLandingAsin($) {
  // 1) #dp[data-asin]
  const dp = $("#dp[data-asin]").first();
  if (dp.length && dp.attr("data-asin")) return dp.attr("data-asin").trim().toUpperCase();

  // 2) #centerCol [data-asin]
  const centerCol = $("#centerCol [data-asin]").first();
  if (centerCol.length && centerCol.attr("data-asin")) return centerCol.attr("data-asin").trim().toUpperCase();

  // 3) [data-asin][data-marketplace]
  const marketplace = $("[data-asin][data-marketplace]").first();
  if (marketplace.length && marketplace.attr("data-asin")) return marketplace.attr("data-asin").trim().toUpperCase();

  // 4) input#ASIN
  const asinInput = $("input#ASIN").first();
  if (asinInput.length && asinInput.attr("value")) return asinInput.attr("value").trim().toUpperCase();

  return null;
}

function extractStockFromHtml($) {
  let availSpan = $("#primeSavingsUpsellAccordionRow");
  if (!availSpan.length) availSpan = $("#newAccordionRow_0");
  let availabilityText = null;

  if (availSpan.length) {
    const availEl = availSpan.find("#availability span").first();
    if (!availEl.length) {
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
    const lowered = availabilityText.replace(/ /g, " ").toLowerCase();
    const match = lowered.match(/(\d+)\s+left in stock/);
    if (match) return parseInt(match[1], 10);
    if (lowered.includes("in stock")) return 1000;
  }

  const opts = $("select#quantity option");
  if (opts.length) {
    let max = 0;
    opts.each((_, el) => {
      const val = parseInt($(el).attr("value"), 10);
      if (!isNaN(val) && val > max) max = val;
    });
    if (max > 0) return max;
  }

  return 0;
}

async function checkAsinOnPage(page, asin, parseDetails) {
  const url = `https://www.amazon.com/dp/${asin}`;
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 600 + Math.random() * 400));

    const currentUrl = page.url();
    const pageTitle = await page.title();
    const lowerTitle = pageTitle.toLowerCase();

    const isCaptcha =
      currentUrl.includes("captcha") ||
      currentUrl.includes("validateCaptcha") ||
      lowerTitle.includes("robot check") ||
      lowerTitle.includes("captcha") ||
      lowerTitle.includes("sorry");

    if (isCaptcha) {
      return {
        originalAsin: asin,
        finalAsin: null,
        finalUrl: currentUrl,
        status: "CAPTCHA",
        redirected: false,
        price: null,
        stock: null,
        durationMs: Date.now() - t0,
      };
    }

    const html = await page.content();
    const $ = cheerio.load(html);

    if (!isValidProductPage($)) {
      return {
        originalAsin: asin,
        finalAsin: null,
        finalUrl: currentUrl,
        status: "CAPTCHA",
        redirected: false,
        price: null,
        stock: null,
        durationMs: Date.now() - t0,
      };
    }

    // HTML içindeki data-asin ile redirect kontrolü
    const landingAsin = extractLandingAsin($);
    if (landingAsin && landingAsin !== asin.toUpperCase()) {
      return {
        originalAsin: asin,
        finalAsin: landingAsin,
        finalUrl: currentUrl,
        status: "REDIRECTED",
        redirected: true,
        price: null,
        stock: null,
        durationMs: Date.now() - t0,
      };
    }

    const price = parseDetails ? extractPriceFromHtml($) : null;
    const stock = parseDetails ? extractStockFromHtml($) : null;

    return {
      originalAsin: asin,
      finalAsin: landingAsin,
      finalUrl: currentUrl,
      status: "OK",
      redirected: false,
      price,
      stock,
      durationMs: Date.now() - t0,
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
      durationMs: Date.now() - t0,
    };
  }
}

/**
 * Amazon'da teslimat konumunu verilen zip koduna ayarlar.
 * Tarayıcı başına bir kez çağrılır.
 */
async function setDeliveryZip(page, zipCode) {
  try {
    await page.goto("https://www.amazon.com", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await new Promise((r) => setTimeout(r, 1500));

    await page.click("#nav-global-location-popover-link").catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    const zipInput = await page.$("#GLUXZipUpdateInput").catch(() => null);
    if (!zipInput) {
      process.stdout.write(
        `\n   ⚠️  Konum popup'ı açılmadı (browser ${zipCode})\n`,
      );
      return;
    }

    await zipInput.click({ clickCount: 3 });
    await zipInput.type(zipCode, { delay: 60 });

    await page.click("#GLUXZipUpdate input[type='submit']").catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    // Popup'ı kapat
    await page.click(".a-popover-footer .a-button-primary").catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    process.stdout.write(`\n   📍 Konum ayarlandı: ${zipCode}\n`);
  } catch (err) {
    process.stdout.write(`\n   ⚠️  Konum ayarlanamadı: ${err.message}\n`);
  }
}

const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-zygote",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  "--metrics-recording-only",
  "--disable-default-apps",
  "--mute-audio",
  "--no-default-browser-check",
  "--disk-cache-size=0",
  "--media-cache-size=0",
];

async function launchBrowser() {
  const browser = await puppeteerExtra.launch({
    executablePath:
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: CHROME_ARGS,
  });
  return browser;
}

async function createPage(browser, zipCode) {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({
    width: 1280 + Math.floor(Math.random() * 120),
    height: 720 + Math.floor(Math.random() * 80),
  });
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (type === "image" || type === "stylesheet" || type === "font" || type === "media") {
      req.abort();
    } else {
      req.continue();
    }
  });

  if (zipCode) {
    await setDeliveryZip(page, zipCode);
  }

  return page;
}

/**
 * Stealth Puppeteer browser pool ile ASIN listesini kontrol eder.
 * onResult(result, completedCount, total) callback'i her sonuçta çağrılır.
 * Bellek sızıntısını önlemek için her BROWSER_RESTART_EVERY sayfada tarayıcı yeniden başlatılır.
 */
export async function checkAsinsWithStealth(asins, options = {}) {
  const {
    concurrency = 8,
    minDelayMs = 2000,
    maxDelayMs = 5000,
    parseDetails = true,
    zipCode = "07004",
    onResult = null,
    browserRestartEvery = 150,
  } = options;

  const results = [];
  let idx = 0;
  const total = asins.length;

  async function worker(workerIndex) {
    let browser = await launchBrowser();
    let page = await createPage(browser, zipCode);
    let pageCount = 0;

    while (idx < total) {
      const currentIdx = idx++;
      const asin = asins[currentIdx];

      // Restart browser periodically to prevent memory accumulation
      if (pageCount > 0 && pageCount % browserRestartEvery === 0) {
        await browser.close().catch(() => {});
        browser = await launchBrowser();
        page = await createPage(browser, zipCode);
        process.stdout.write(`\n  ♻️  Worker ${workerIndex}: tarayıcı yeniden başlatıldı (${pageCount} sayfa)\n`);
      }

      const result = await checkAsinOnPage(page, asin, parseDetails);
      results.push(result);
      pageCount++;

      if (onResult) onResult(result, results.length, total);

      const delay = minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs));
      await new Promise((r) => setTimeout(r, delay));
    }

    await browser.close().catch(() => {});
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

  return results;
}
