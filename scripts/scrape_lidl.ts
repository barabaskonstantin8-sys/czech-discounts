// @ts-nocheck
// scripts/scrape_lidl.ts
// Собирает максимум акций Lidl CZ: обходит разделы, кликает "показать ещё", крутит до конца.
// Результат пишет в public/data/offers.json

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { addDays, format } from "date-fns";

const CHAIN = "Lidl";

// Точки входа (можно расширять при желании)
const ENTRY_URLS = [
  "https://www.lidl.cz/akce",
  "https://www.lidl.cz/specialni-nabidky",
  "https://www.lidl.cz/letak",
];

// Сколько дней считать акцию действительной, если на странице нет явных дат
const DAYS_VALID = 7;

const OUT_FILE = path.join(process.cwd(), "public", "data", "offers.json");

function round2(n: number) { return Math.round(n * 100) / 100; }
function normalizeTitle(s: string) { return s.replace(/\s+/g, " ").trim(); }
function idFrom(title: string, price: number) {
  const base = normalizeTitle(title).toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  return `lidl-${base}-${Math.round(price * 100)}`;
}
function dedupeById(list: any[]) {
  const seen = new Set<string>(); const res: any[] = [];
  for (const x of list) { if (!seen.has(x.id)) { seen.add(x.id); res.push(x); } }
  return res;
}
function mergeIntoOffersJson(newOnes: any[]) {
  let current: any[] = [];
  try { current = JSON.parse(fs.readFileSync(OUT_FILE, "utf-8")); } catch {}
  const withoutLidl = current.filter(o => o.chain !== CHAIN);
  const merged = [...withoutLidl, ...newOnes];
  merged.sort((a, b) => (b.discount ?? 0) - (a.discount ?? 0) || a.price - b.price);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(merged, null, 2), "utf-8");
}

async function autoScroll(page: any) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let total = 0, step = 1200;
      const t = setInterval(() => {
        window.scrollBy(0, step); total += step;
        if (total > document.body.scrollHeight * 3) { clearInterval(t); resolve(); }
      }, 200);
    });
  });
}

// Нажимает все подходящие кнопки "Показать ещё", пока они есть
async function clickMoreLoop(page: any) {
  const selectors = [
    // тексты часто меняются, охватываем популярные варианты
    "button:has-text('Načíst více')",
    "button:has-text('Zobrazit další')",
    "button:has-text('Načíst další')",
    "button:has-text('Další')",
    "a:has-text('Načíst více')",
    "a:has-text('Zobrazit další')",
  ];

  for (let i = 0; i < 20; i++) {
    let clicked = false;
    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        try {
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ timeout: 3000 });
          await page.waitForTimeout(1000);
          clicked = true;
          break; // к следующей итерации внешнего цикла
        } catch {}
      }
    }
    if (!clicked) break;
  }
}

// Ищем дополнительные ссылки на разделы/категории акций и возвращаем уникальный список
async function getCategoryLinks(page: any, base: string) {
  const links: string[] = await page.evaluate((baseURL) => {
    const out = new Set<string>();
    document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach(a => {
      const href = a.getAttribute("href") || "";
      // интересуют только внутренние страницы акций
      if (/akce|specialni|letak|nabidk/i.test(href)) {
        try {
          const u = new URL(href, baseURL).toString();
          if (u.startsWith(baseURL.split("/").slice(0, 3).join("/"))) out.add(u);
        } catch {}
      }
    });
    return Array.from(out);
  }, base);
  // ограничим до разумного количества, чтобы не улететь навсегда
  return Array.from(new Set(links)).slice(0, 40);
}

// Вытаскиваем карточки со страницы (выполняется внутри браузера)
async function extractOffersFromPage(page: any, currentUrl: string) {
  const raw = await page.evaluate((url) => {
    function norm(s: string) { return s ? s.replace(/\s+/g, " ").trim() : ""; }
    function parsePrice(text: string) {
      const m = text.replace(/\s+/g, " ").match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*Kč/i);
      return m ? parseFloat(m[1].replace(",", ".")) : null;
    }
    function parsePercent(text: string) {
      const m = text.replace(/\s+/g, " ").match(/-?\s?(\d{1,2})\s?%/);
      return m ? parseInt(m[1], 10) : null;
    }

    const blocks = Array.from(document.querySelectorAll("article, li, section, div"));
    const res: any[] = [];
    for (const el of blocks) {
      const text = norm(el.textContent || "");
      if (!/Kč/.test(text)) continue;

      // заголовок
      let title = "";
      const tNode = el.querySelector("h3, h2, .title, .headline, .product__title, .pricebox__product-name, .product-title");
      if (tNode) title = norm(tNode.textContent || "");
      if (!title || title.length < 3) {
        const parts = text.split("\n").map(s => norm(s)).filter(Boolean);
        const cand = parts.find(s => !/Kč|%|-\d+%|^\d/.test(s) && s.length > 2);
        if (cand) title = cand;
      }
      if (!title) continue;

      const priceNow = parsePrice(text);
      if (priceNow == null) continue;

      // старая цена/скидка (эвристика)
      let oldPrice: number | null = null;
      const matches = text.match(/(\d{1,4}(?:[.,]\d{1,2})?)\s*Kč/gi);
      if (matches && matches.length >= 2) {
        const nums = matches.map(x => parseFloat(x.replace(/[^\d.,]/g, "").replace(",", ".")));
        const max = Math.max(...nums); const min = Math.min(...nums);
        oldPrice = max > priceNow ? max : (min < priceNow ? priceNow : null);
        if (oldPrice === priceNow) oldPrice = null;
      }

      const discount = parsePercent(text);

      res.push({
        title,
        price: priceNow,
        oldPrice: oldPrice ?? undefined,
        discount: discount ?? undefined,
        url
      });
    }
    return res;
  }, currentUrl);
  return raw;
}

async function scrape() {
  const browser = await chromium.launch({
    headless: true,         // когда отлаживаешь — поставь false
    slowMo: 0
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    bypassCSP: true,
    viewport: { width: 1440, height: 900 }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  await context.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "font" || t === "media") return route.abort();
    route.continue();
  });

  const page = await context.newPage();

  // очередь ссылок к посещению
  const toVisit = new Set<string>(ENTRY_URLS);
  const visited = new Set<string>();
  const all: any[] = [];

  let cookiesClicked = false;

  while (true) {
    const next = Array.from(toVisit).find(u => !visited.has(u));
    if (!next) break;
    visited.add(next);

    try {
      await page.goto(next, { waitUntil: "domcontentloaded", timeout: 90000 });

      if (!cookiesClicked) {
        try {
          await page.waitForTimeout(1500);
          const btn = page.getByRole('button', { name: /Přijmout vše|Souhlasím|Akceptovat|Accept/i });
          await btn.click({ timeout: 4000 });
          cookiesClicked = true;
        } catch {}
      }

      // прокрутка и нажатия "показать ещё"
      await page.keyboard.press("End"); await page.waitForTimeout(600);
      await page.keyboard.press("End"); await page.waitForTimeout(600);
      await autoScroll(page);
      await clickMoreLoop(page);
      await autoScroll(page);

      // извлечение карточек
      const raw = await extractOffersFromPage(page, next);
      all.push(...raw);

      // собрать новые ссылки на категории/подразделы
      const links = await getCategoryLinks(page, next);
      links.forEach(l => toVisit.add(l));
    } catch (e) {
      console.warn("Lidl: ошибка при обработке", next, e);
    }
  }

  await browser.close();

  // постобработка и запись
  const now = new Date();
  const validFrom = format(now, "yyyy-MM-dd");
  const validTo = format(addDays(now, DAYS_VALID), "yyyy-MM-dd");

  const prepared = all.map((r: any) => ({
    id: idFrom(r.title, r.price),
    chain: CHAIN,
    title: normalizeTitle(r.title),
    price: round2(r.price),
    oldPrice: r.oldPrice ? round2(r.oldPrice) : undefined,
    discount: r.discount,
    validFrom,
    validTo,
    url: r.url
  }));

  const unique = dedupeById(prepared);

  if (unique.length === 0) {
    fs.mkdirSync("tmp", { recursive: true });
    fs.writeFileSync("tmp/lidl_last.html", (await (await context.newPage()).content?.()) ?? "", "utf-8");
    console.warn("Lidl: карточек не найдено — смотри tmp/lidl_last.html (если создался).");
  }

  mergeIntoOffersJson(unique);
  console.log(`Lidl: собрано сырьём ${all.length}, уникальных ${unique.length}. Обновлено: ${OUT_FILE}`);
}

scrape().catch(err => {
  console.error("Scrape error:", err);
  process.exit(1);
});