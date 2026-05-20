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

    const finalAsinMatch = currentUrl.match(/\/dp\/([A-Z0-9]{10})/i);
    const finalAsin = finalAsinMatch ? finalAsinMatch[1].toUpperCase() : null;
    const redirected = finalAsin !== null && finalAsin !== asin.toUpperCase();

    if (redirected) {
      return {
        originalAsin: asin,
        finalAsin,
        finalUrl: currentUrl,
        status: "REDIRECTED",
        redirected: true,
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

    const price = parseDetails ? extractPriceFromHtml($) : null;
    const stock = parseDetails ? extractStockFromHtml($) : null;

    return {
      originalAsin: asin,
      finalAsin,
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

/**
 * Stealth Puppeteer browser pool ile ASIN listesini kontrol eder.
 * onResult(result, completedCount, total) callback'i her sonuçta çağrılır.
 */
export async function checkAsinsWithStealth(asins, options = {}) {
  const {
    concurrency = 8,
    minDelayMs = 2000,
    maxDelayMs = 5000,
    parseDetails = true,
    zipCode = "07004",
    onResult = null,
  } = options;

  const results = [];
  let idx = 0;
  const total = asins.length;

  const browsers = [];
  const pages = [];

  for (let i = 0; i < concurrency; i++) {
    const browser = await puppeteerExtra.launch({
      executablePath:
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({
      width: 1280 + Math.floor(Math.random() * 120),
      height: 720 + Math.floor(Math.random() * 80),
    });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    // Block unnecessary resources to speed up page loads
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (
        type === "image" ||
        type === "stylesheet" ||
        type === "font" ||
        type === "media"
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    if (zipCode) {
      await setDeliveryZip(page, zipCode);
    }

    browsers.push(browser);
    pages.push(page);
  }

  async function worker(page) {
    while (idx < total) {
      const currentIdx = idx++;
      const asin = asins[currentIdx];

      const result = await checkAsinOnPage(page, asin, parseDetails);
      results.push(result);

      if (onResult) onResult(result, results.length, total);

      const delay =
        minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs));
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  await Promise.all(pages.map((p) => worker(p)));

  for (const b of browsers) await b.close().catch(() => {});

  return results;
}
