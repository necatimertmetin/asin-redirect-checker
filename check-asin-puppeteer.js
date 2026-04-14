import puppeteer from "puppeteer";

/**
 * Puppeteer ile ASIN kontrolü (JS redirect dahil)
 */
export async function checkAsinWithPuppeteer(asin, options = {}) {
  const {
    amazonDomain = "amazon.com",
    waitMs = 10000,
    headless = true,
  } = options;
  const url = `https://www.${amazonDomain}/dp/${asin}`;
  let browser;
  try {
    browser = await puppeteer.launch({ headless });
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );
    let detectedUrl = url;
    let detectedAsin = asin.toUpperCase();
    let redirected = false;

    // Dinamik olarak URL değişimini dinle
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        const newUrl = frame.url();
        const match = newUrl.match(/\/dp\/([A-Z0-9]{10})/i);
        if (match) {
          detectedUrl = newUrl;
          detectedAsin = match[1].toUpperCase();
          redirected = detectedAsin !== asin.toUpperCase();
        }
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Konsolda window.location değişimini de dinle
    await page.exposeFunction("notifyRedirect", (newUrl) => {
      const match = newUrl.match(/\/dp\/([A-Z0-9]{10})/i);
      if (match) {
        detectedUrl = newUrl;
        detectedAsin = match[1].toUpperCase();
        redirected = detectedAsin !== asin.toUpperCase();
      }
    });
    await page.evaluate(() => {
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      function notify() {
        window.notifyRedirect(window.location.href);
      }
      history.pushState = function (...args) {
        origPush.apply(this, args);
        notify();
      };
      history.replaceState = function (...args) {
        origReplace.apply(this, args);
        notify();
      };
      window.addEventListener("popstate", notify);
      const origAssign = window.location.assign;
      window.location.assign = function (url) {
        origAssign.call(this, url);
        notify();
      };
      // window.location.href setter'ı kaldırıldı (hata veriyordu)
    });

    // 15 saniye boyunca URL değişimini dinle
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(waitMs, 15000)),
    );

    return {
      originalAsin: asin,
      finalAsin: detectedAsin,
      finalUrl: detectedUrl,
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
  } finally {
    if (browser) await browser.close();
  }
}
