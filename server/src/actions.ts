// 投資合伙戶口管理系統 v3.3.0 — Muse 版
// 計算邏輯同獨立站 v3.0.0 server.js 嘅 computeState() 睇齊（伺服器做唯一真相）：
//   本金 = DEPOSIT 總和；總盈虧 = 總資產 − 本金
//   合夥人實際存入 = DEPOSIT 總和；持股比例 = 實際存入 ÷ 總本金
//   應存 = 每月應存 × 由起始日期起計嘅月數
// v3.1.0：股價改做自動更新（唔再手動輸入）——refreshPrices 經騰訊報價／
// Muse 金融數據渠道攞價，寫入 quotes 表同 stocks.price；
// 定時（每 30 分鐘）同開頁／手動掣都會觸發。監察清單（watchlist）入面嘅
// 股票就算未持有都會一齊更新價錢。
// v3.2.0：取消現金對帳表；監察股票獨立成欄（monitor），以高息股資料為主：
// 每股股息（帳目近 12 個月股息 ÷ 現持股數，或用戶手動輸入，或渠道股息率）、
// 息率、現價喺 52 週波幅嘅位置（是否高位），同按固定規則計出嘅買賣建議。
// v3.2.1：監察卡加每手股數＋一手價錢（現價 × 每手股數，唔計手續費；每手
// 股數有已核實預設值，亦可手動改）；加趨勢（上升軌／下降軌／橫行整固，
// 按現價對 MA20／MA50 嘅固定規則，用 Yahoo v8 chart 半年日線，每日計一次）；
// 監察頁加「購買股票結餘」＝ 現金結餘 − 合夥人差額總和（差額＝實際存入−應存）。
// v3.2.2：純 UI 改動——監察頁加「顯示／隱藏公式」一鍵開關（預設隱藏，
// 選擇記喺瀏覽器 localStorage）；收起時隱藏公式說明同每卡嘅公式輸入
// 數值行（MA20／MA50、52 週高低、一手算式、結餘算式等），計算、趨勢
// 邏輯、買賣建議公式全部不變，後端 VERSION 同步升 3.2.2。
// v3.3.0：自動派息——refreshPrices 順手去 Yahoo 抓每隻受追蹤股票嘅派息
// 歷史（v8 chart 加 events=div，取 5 年半；EPS 經 quoteSummary crumb
// 流程攞 trailingEps），每日每隻最多成功抓一次，存入 dividend_history
// 表：TTM DPS（過去 12 個月派息總和）、過去 5 個曆年每年 DPS、派息趨勢
// （最近兩個完整曆年比較，±3% 內當平穩）、每股盈利。監察欄每股股息
// 優先次序改為：手動輸入 > 自動 TTM DPS > 帳目派息 > 報價渠道；派息
// 比率 = 採用中嘅每股股息 ÷ EPS。抓唔到嗰次保留上次成功嘅數，唔清走。
// 買賣建議公式、趨勢計算、購買股票結餘全部不變。

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, desc, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";

export const VERSION = "3.3.0";

const ACTIONS = ["BUY", "SELL", "DIVIDEND", "RED_STOCK", "INTEREST", "DEPOSIT", "FEE"] as const;
type TxAction = (typeof ACTIONS)[number];

const DEFAULT_PARTNERS: Array<{ key: string; name: string; sort: number }> = [
  { key: "A", name: "樂", sort: 1 },
  { key: "B", name: "暉", sort: 2 },
  { key: "C", name: "源", sort: 3 },
  { key: "D", name: "啤", sort: 4 },
  { key: "E", name: "英", sort: 5 },
];

const txInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  code: z.string().min(1).max(20),
  currency: z.string().min(1).max(8).default("HKD"),
  action: z.enum(ACTIONS),
  price: z.number().finite().default(0),
  qty: z.number().finite().default(0),
  fee: z.number().finite().default(0),
  partner: z.string().min(1).max(20).default("NONE"),
  note: z.string().max(500).default(""),
});
type TxInput = z.infer<typeof txInput>;

// 金額按動作計（v2.26 錯得最多嘅地方，呢度跟獨立站 import-csv.js 嘅定義）：
//   DEPOSIT / INTEREST：金額 = Price
//   DIVIDEND：Quantity > 0 就 Price × Quantity，否則 = Price
//   BUY / SELL：金額 = Price × Quantity（手費另計）
//   FEE：金額 = FEE 欄
//   RED_STOCK：金額 0
function amountFor(t: { action: TxAction; price: number; qty: number; fee: number }): number {
  switch (t.action) {
    case "BUY":
    case "SELL":
      return t.price * t.qty;
    case "DEPOSIT":
    case "INTEREST":
      return t.price;
    case "DIVIDEND":
      return t.qty > 0 ? t.price * t.qty : t.price;
    case "FEE":
      return t.fee;
    case "RED_STOCK":
      return 0;
  }
}

function dedupeKey(t: TxInput): string {
  return [t.date, t.code.toUpperCase(), t.action, t.price, t.qty, t.fee, t.partner.toUpperCase(), t.note].join("|");
}

function normalizeTx(t: TxInput): TxInput & { amount: number; dedupeKey: string } {
  const n: TxInput = {
    ...t,
    code: t.code.trim().toUpperCase() || "CASH",
    currency: (t.currency || "HKD").trim().toUpperCase() || "HKD",
    partner: (t.partner || "NONE").trim().toUpperCase() || "NONE",
    note: t.note.trim(),
  };
  return { ...n, amount: amountFor(n), dedupeKey: dedupeKey(n) };
}

type Db = ReturnType<Ctx["db"]>;

async function ensureDefaults(db: Db) {
  const existing = await db.select().from(schema.partners);
  if (existing.length === 0) {
    await db.insert(schema.partners).values(DEFAULT_PARTNERS).onConflictDoNothing();
  }
  const rows = await db.select().from(schema.settings);
  const have = new Set(rows.map((r) => r.key));
  const missing: Array<{ key: string; value: string }> = [];
  if (!have.has("monthlyDeposit")) missing.push({ key: "monthlyDeposit", value: "500" });
  if (!have.has("startDate")) missing.push({ key: "startDate", value: "2018-03-01" });
  if (missing.length > 0) {
    await db.insert(schema.settings).values(missing).onConflictDoNothing();
  }
  const stockRows = await db.select().from(schema.stocks);
  if (stockRows.length === 0) {
    await db.insert(schema.stocks).values({ code: "00003.HK", price: 0 }).onConflictDoNothing();
  }
}

async function getSetting(db: Db, key: string, fallback: string): Promise<string> {
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.key, key));
  return rows[0]?.value ?? fallback;
}

async function setSetting(db: Db, key: string, value: string) {
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

// Months from startDate's month to the current month (Asia/Macau wall clock,
// matching the standalone's local-month arithmetic for a Macau user).
function monthsSince(startDate: string): number {
  const [sy = 2018, sm = 3] = startDate.split("-").map(Number);
  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Macau",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  const ny = Number(nowParts.find((p) => p.type === "year")?.value ?? sy);
  const nm = Number(nowParts.find((p) => p.type === "month")?.value ?? sm);
  return Math.max(0, (ny - sy) * 12 + (nm - sm));
}

// Local ledger codes use the 5-digit HK form (00003.HK, from the user's CSV);
// the quote channel wants the 4-digit Yahoo form (0003.HK). Non-HK codes pass
// through unchanged.
function quoteSymbol(code: string): string {
  const m = code.match(/^(\d+)\.HK$/i);
  if (!m || !m[1]) return code;
  return `${String(parseInt(m[1], 10)).padStart(4, "0")}.HK`;
}

// 每手股數（board lot）已核實預設值（2026-11-18 查證）：煤氣／中海油／
// 頤海國際／德翔海運都係 1,000 股一手，老鋪黃金 100 股一手。新加入嘅
// 股票預設 1,000；用戶喺 stocks.lot_size 手動改咗就以手動值為準。
const DEFAULT_LOT_SIZES: Record<string, number> = {
  "00003.HK": 1000,
  "00883.HK": 1000,
  "01579.HK": 1000,
  "02510.HK": 1000,
  "06181.HK": 100,
};
const FALLBACK_LOT_SIZE = 1000;

function lotSizeFor(code: string, manual: number | null | undefined): number {
  if (manual !== null && manual !== undefined && manual > 0) return manual;
  return DEFAULT_LOT_SIZES[code] ?? FALLBACK_LOT_SIZE;
}

// Asia/Macau 今日日期（YYYY-MM-DD），趨勢「每日計一次」嘅分界。
function macauToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Macau",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type QuoteData = {
  price: number;
  change: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  week52High: number | null;
  week52Low: number | null;
  dividendYield: number | null;
  dividendRate: number | null;
  name: string;
  marketStatus: string;
  asOf: string;
};

// Managed finance channel. Its HK coverage is patchy (some tickers don't
// resolve, and 0003.HK once came back with a price far outside its own
// 52-week range), so a quote whose price contradicts its 52-week range is
// rejected as bad data instead of being stored.
async function fetchViaChannel(ctx: Ctx, code: string): Promise<QuoteData | null> {
  try {
    const res = await ctx.tool.finance_ticker(quoteSymbol(code));
    const inst = res.content?.instrument ?? null;
    if (!inst || typeof inst.price !== "number" || !Number.isFinite(inst.price) || inst.price <= 0) {
      return null;
    }
    if (
      inst.week_52_low != null &&
      inst.week_52_high != null &&
      (inst.price < inst.week_52_low * 0.98 || inst.price > inst.week_52_high * 1.02)
    ) {
      return null;
    }
    // 股息欄位唔喺渠道嘅文件欄位表入面，有就用、冇就 null，唔好估。
    const raw = inst as unknown as Record<string, unknown>;
    const numOrNull = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    return {
      price: inst.price,
      change: inst.change ?? null,
      changePct: inst.change_percent ?? null,
      dayHigh: inst.high ?? null,
      dayLow: inst.low ?? null,
      week52High: inst.week_52_high ?? null,
      week52Low: inst.week_52_low ?? null,
      dividendYield: numOrNull(raw["dividend_yield"]),
      dividendRate: numOrNull(raw["dividend_rate"] ?? raw["trailing_annual_dividend_rate"]),
      name: inst.name ?? "",
      marketStatus: inst.market_status ?? "",
      asOf: inst.as_of ?? "",
    };
  } catch {
    return null;
  }
}

// 只攞渠道嘅附加欄位（52 週波幅、股息），唔用佢個價。渠道對港股個價試過
// 離晒譜（0.8，連自己報嘅 52 週波幅都包唔住），所以 fetchViaChannel 成個
// reject；但佢報嘅 52 週波幅本身同真價吻合（6.4–7.76 對真價約 7.4），
// 淨係攞波幅嚟計「係咪高位」係合理用法——個價永遠唔會混入。
async function fetchChannelExtras(
  ctx: Ctx,
  code: string,
): Promise<Pick<QuoteData, "week52High" | "week52Low" | "dividendYield" | "dividendRate"> | null> {
  try {
    const res = await ctx.tool.finance_ticker(quoteSymbol(code));
    const inst = res.content?.instrument ?? null;
    if (!inst) return null;
    const lo = inst.week_52_low ?? null;
    const hi = inst.week_52_high ?? null;
    const rangeOk = lo !== null && hi !== null && lo > 0 && hi > lo;
    const raw = inst as unknown as Record<string, unknown>;
    const numOrNull = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
    return {
      week52High: rangeOk ? hi : null,
      week52Low: rangeOk ? lo : null,
      dividendYield: numOrNull(raw["dividend_yield"]),
      dividendRate: numOrNull(raw["dividend_rate"] ?? raw["trailing_annual_dividend_rate"]),
    };
  } catch {
    return null;
  }
}

// Tencent quote endpoint (qt.gtimg.cn) — purpose-built for HK stocks, plain
// text, no key. Layout: [1]=name [2]=code [3]=current [4]=prev close
// [5]=open … [33]=day high [34]=day low, plus a "YYYY/MM/DD HH:MM:SS" field.
// Change figures are computed from current vs prev close; day high/low are
// only kept when they bracket the current price.
async function fetchViaTencent(code: string): Promise<QuoteData | null> {
  const m = code.match(/^(\d+)\.HK$/i);
  if (!m || !m[1]) return null;
  const digits = m[1].padStart(5, "0");
  try {
    const resp = await fetch(`https://qt.gtimg.cn/q=hk${digits}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    let text: string;
    try {
      text = new TextDecoder("gbk").decode(buf);
    } catch {
      text = new TextDecoder().decode(buf);
    }
    const mm = text.match(/="([^"]*)"/);
    if (!mm || !mm[1]) return null;
    const f = mm[1].split("~");
    const price = parseFloat(f[3] ?? "");
    const prev = parseFloat(f[4] ?? "");
    if (!Number.isFinite(price) || price <= 0) return null;
    const change = Number.isFinite(prev) && prev > 0 ? price - prev : null;
    const changePct = change !== null && prev > 0 ? (change / prev) * 100 : null;
    let dayHigh = parseFloat(f[33] ?? "");
    let dayLow = parseFloat(f[34] ?? "");
    if (!(Number.isFinite(dayLow) && Number.isFinite(dayHigh) && dayLow <= price && price <= dayHigh)) {
      dayHigh = NaN;
      dayLow = NaN;
    }
    const dt = f.find((x) => /^\d{4}\/\d{2}\/\d{2}/.test(x)) ?? "";
    return {
      price,
      change,
      changePct,
      dayHigh: Number.isFinite(dayHigh) ? dayHigh : null,
      dayLow: Number.isFinite(dayLow) ? dayLow : null,
      week52High: null,
      week52Low: null,
      dividendYield: null,
      dividendRate: null,
      name: f[1] ?? "",
      marketStatus: "",
      asOf: dt,
    };
  } catch {
    return null;
  }
}

// HK codes try Tencent first (the channel is unreliable for them), then the
// channel; everything else goes channel first, then Tencent (HK-only anyway).
// When the primary quote lacks the 52-week range or dividend data (Tencent
// carries neither), the other source is asked to fill just those fields —
// its price is never mixed in.
async function fetchQuote(ctx: Ctx, code: string): Promise<QuoteData | null> {
  const isHk = /\.HK$/i.test(code);
  const primary = isHk ? await fetchViaTencent(code) : await fetchViaChannel(ctx, code);
  if (!primary) {
    return isHk ? await fetchViaChannel(ctx, code) : await fetchViaTencent(code);
  }
  const lacksExtras =
    primary.week52High === null || primary.week52Low === null || primary.dividendYield === null;
  if (lacksExtras) {
    const extras = await fetchChannelExtras(ctx, code);
    if (extras) {
      if (primary.week52High === null) primary.week52High = extras.week52High;
      if (primary.week52Low === null) primary.week52Low = extras.week52Low;
      if (primary.dividendYield === null) primary.dividendYield = extras.dividendYield;
      if (primary.dividendRate === null) primary.dividendRate = extras.dividendRate;
    }
    if (!primary.name) {
      const secondary = isHk ? await fetchViaChannel(ctx, code) : await fetchViaTencent(code);
      if (secondary?.name) primary.name = secondary.name;
    }
  }
  return primary;
}

type TrendData = { trend: "up" | "down" | "sideways"; ma20: number; ma50: number };

// 趨勢：Yahoo v8 chart 半年日線收市價，計 MA20／MA50 同兩線斜率（同 5 個
// 交易日前比較）。規則固定，唔係估：現價 > MA20 > MA50 而且兩線向上 →
// up（上升軌）；現價 < MA20 < MA50 而且兩線向下 → down（下降軌）；
// 其餘 → sideways（橫行／整固）。數據唔夠（少過 55 個收市價）或者攞唔到
// 就 null，UI 顯示「未有趨勢數據」，唔扮有。
async function fetchTrend(code: string): Promise<TrendData | null> {
  const sym = quoteSymbol(code);
  try {
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=6mo&interval=1d`,
      {
        signal: AbortSignal.timeout(15000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      chart?: {
        result?: Array<{
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }> | null;
      };
    };
    const closesRaw = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    const closes = closesRaw.filter(
      (c): c is number => typeof c === "number" && Number.isFinite(c) && c > 0,
    );
    if (closes.length < 55) return null;
    const ma = (n: number, back = 0): number => {
      const end = closes.length - back;
      const seg = closes.slice(end - n, end);
      return seg.reduce((s, v) => s + v, 0) / seg.length;
    };
    const price = closes[closes.length - 1] ?? 0;
    const ma20 = ma(20);
    const ma50 = ma(50);
    const ma20Prev = ma(20, 5);
    const ma50Prev = ma(50, 5);
    if (price > ma20 && ma20 > ma50 && ma20 > ma20Prev && ma50 > ma50Prev) {
      return { trend: "up", ma20, ma50 };
    }
    if (price < ma20 && ma20 < ma50 && ma20 < ma20Prev && ma50 < ma50Prev) {
      return { trend: "down", ma20, ma50 };
    }
    return { trend: "sideways", ma20, ma50 };
  } catch {
    return null;
  }
}

// 每隻受追蹤股票每日（Asia/Macau）最多成功計一次趨勢：今日已經有好結果
// 嘅跳過；失敗就記低 ok=0，下次 refresh 再試，唔會洗走上次好值。
async function refreshTrends(ctx: Ctx, codes: string[]): Promise<void> {
  const db = ctx.db<typeof schema>();
  const today = macauToday();
  const existing = await db.select().from(schema.trends);
  const byCode = new Map(existing.map((t) => [t.code, t]));
  const todo = codes.filter((c) => {
    const t = byCode.get(c);
    return !(t && t.ok === 1 && t.day === today);
  });
  if (todo.length === 0) return;
  const at = Date.now();
  const results = await Promise.all(
    todo.map(async (code) => ({ code, t: await fetchTrend(code) })),
  );
  const statements: BatchItem<"sqlite">[] = [];
  for (const r of results) {
    if (!r.t) {
      statements.push(
        db
          .insert(schema.trends)
          .values({ code: r.code, trend: "", updatedAt: at, ok: 0 })
          .onConflictDoUpdate({
            target: schema.trends.code,
            set: { updatedAt: at, ok: 0 },
          }),
      );
      continue;
    }
    statements.push(
      db
        .insert(schema.trends)
        .values({
          code: r.code,
          trend: r.t.trend,
          ma20: r.t.ma20,
          ma50: r.t.ma50,
          day: today,
          updatedAt: at,
          ok: 1,
        })
        .onConflictDoUpdate({
          target: schema.trends.code,
          set: { trend: r.t.trend, ma20: r.t.ma20, ma50: r.t.ma50, day: today, updatedAt: at, ok: 1 },
        }),
    );
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
}

type DividendData = {
  ttmDps: number;
  yearly: Array<{ year: number; dps: number }>;
  trend: "up" | "flat" | "down" | null;
  eps: number | null;
};

// Yahoo quoteSummary 需要 crumb：先去 fc.yahoo.com 攞 cookie，再換 crumb，
// 成個 process 內 cache 30 分鐘。任何一步失敗就當攞唔到 EPS，唔阻派息
// 歷史本身入庫（派息比率嗰陣顯示未有數據）。
let yahooCrumbCache: { crumb: string; cookie: string; at: number } | null = null;

async function yahooCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  if (yahooCrumbCache && Date.now() - yahooCrumbCache.at < 30 * 60 * 1000) {
    return yahooCrumbCache;
  }
  const ua = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  };
  try {
    const seed = await fetch("https://fc.yahoo.com", {
      signal: AbortSignal.timeout(10000),
      headers: ua,
    });
    const rawCookies =
      typeof seed.headers.getSetCookie === "function"
        ? seed.headers.getSetCookie()
        : [seed.headers.get("set-cookie") ?? ""];
    const cookie = rawCookies
      .map((c) => c.split(";")[0] ?? "")
      .filter(Boolean)
      .join("; ");
    if (!cookie) return null;
    const cr = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      signal: AbortSignal.timeout(10000),
      headers: { ...ua, Cookie: cookie },
    });
    if (!cr.ok) return null;
    const crumb = (await cr.text()).trim();
    if (!crumb || crumb.length > 64 || /\s/.test(crumb)) return null;
    yahooCrumbCache = { crumb, cookie, at: Date.now() };
    return yahooCrumbCache;
  } catch {
    return null;
  }
}

// 每股盈利（trailing EPS）：Yahoo quoteSummary defaultKeyStatistics 嘅
// trailingEps。攞唔到就 null，派息比率唔計，唔估。
async function fetchTrailingEps(code: string): Promise<number | null> {
  const auth = await yahooCrumb();
  if (!auth) return null;
  try {
    const resp = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(quoteSymbol(code))}?modules=defaultKeyStatistics&crumb=${encodeURIComponent(auth.crumb)}`,
      {
        signal: AbortSignal.timeout(15000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Cookie: auth.cookie,
        },
      },
    );
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) yahooCrumbCache = null;
      return null;
    }
    const data = (await resp.json()) as {
      quoteSummary?: {
        result?: Array<{
          defaultKeyStatistics?: { trailingEps?: { raw?: unknown } };
        }> | null;
      };
    };
    const raw = data.quoteSummary?.result?.[0]?.defaultKeyStatistics?.trailingEps?.raw;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  } catch {
    return null;
  }
}

// 自動派息歷史：Yahoo v8 chart 加 events=div，取 5 年半派息事件。
// TTM DPS = 過去 365 日派息總和；每年 DPS 按除息日嘅澳門曆年分組，
// 取最近 5 個曆年（升序）；派息趨勢比較最近兩個完整曆年（今年未完，
// 唔攞嚟比），變幅 ±3% 內當平穩，完整曆年唔夠兩年就用 TTM 對上一個
// 完整曆年（TTM 高／低過佢 3% 以上先當升／跌）。冇派息事件但 chart
// 本身攞到 = 成功（TTM 0、冇年度數據）；chart 攞唔到先至 null。
async function fetchDividendHistory(code: string): Promise<DividendData | null> {
  const sym = quoteSymbol(code);
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - Math.floor(5.5 * 365.25 * 86400);
  try {
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${fromSec}&period2=${nowSec}&interval=1d&events=div`,
      {
        signal: AbortSignal.timeout(20000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      chart?: {
        result?: Array<{
          events?: {
            dividends?: Record<string, { amount?: unknown; date?: unknown }>;
          };
        }> | null;
      };
    };
    const result = data.chart?.result?.[0];
    if (!result) return null;
    const events = Object.values(result.events?.dividends ?? {}).filter(
      (e): e is { amount: number; date: number } =>
        typeof e?.amount === "number" &&
        Number.isFinite(e.amount) &&
        e.amount >= 0 &&
        typeof e?.date === "number" &&
        Number.isFinite(e.date),
    );
    const cutoffMs = Date.now() - 365 * 86400000;
    let ttmDps = 0;
    for (const e of events) {
      if (e.date * 1000 >= cutoffMs) ttmDps += e.amount;
    }
    const yearFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Macau",
      year: "numeric",
    });
    const byYear = new Map<number, number>();
    for (const e of events) {
      const y = Number(yearFmt.format(new Date(e.date * 1000)));
      if (Number.isFinite(y)) byYear.set(y, (byYear.get(y) ?? 0) + e.amount);
    }
    const yearly = [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(-5)
      .map(([year, dps]) => ({ year, dps }));
    const curYear = Number(yearFmt.format(new Date()));
    const complete = yearly.filter((y) => y.year < curYear);
    let trend: DividendData["trend"] = null;
    const cmp = (recent: number, base: number): DividendData["trend"] => {
      if (base > 0) {
        const chg = ((recent - base) / base) * 100;
        return chg > 3 ? "up" : chg < -3 ? "down" : "flat";
      }
      return recent > 0 ? "up" : "flat";
    };
    if (complete.length >= 2) {
      const last = complete[complete.length - 1];
      const prev = complete[complete.length - 2];
      if (last && prev) trend = cmp(last.dps, prev.dps);
    } else if (complete.length === 1 && complete[0]) {
      trend = cmp(ttmDps, complete[0].dps);
    }
    const eps = await fetchTrailingEps(code);
    return { ttmDps, yearly, trend, eps };
  } catch {
    return null;
  }
}

// 每隻受追蹤股票每日（Asia/Macau）最多成功抓一次派息歷史：今日已經有
// 好結果嘅跳過；失敗就記低 ok=0，下次 refresh 再試，唔會洗走上次好值。
async function refreshDividends(ctx: Ctx, codes: string[]): Promise<void> {
  const db = ctx.db<typeof schema>();
  const today = macauToday();
  const existing = await db.select().from(schema.dividendHistory);
  const byCode = new Map(existing.map((d) => [d.code, d]));
  const todo = codes.filter((c) => {
    const d = byCode.get(c);
    return !(d && d.ok === 1 && d.day === today);
  });
  if (todo.length === 0) return;
  const at = Date.now();
  const results = await Promise.all(
    todo.map(async (code) => ({ code, d: await fetchDividendHistory(code) })),
  );
  const statements: BatchItem<"sqlite">[] = [];
  for (const r of results) {
    if (!r.d) {
      statements.push(
        db
          .insert(schema.dividendHistory)
          .values({ code: r.code, updatedAt: at, ok: 0 })
          .onConflictDoUpdate({
            target: schema.dividendHistory.code,
            set: { updatedAt: at, ok: 0 },
          }),
      );
      continue;
    }
    const yearlyJson = JSON.stringify(r.d.yearly);
    const trend = r.d.trend ?? "";
    statements.push(
      db
        .insert(schema.dividendHistory)
        .values({
          code: r.code,
          ttmDps: r.d.ttmDps,
          yearly: yearlyJson,
          trend,
          eps: r.d.eps,
          day: today,
          updatedAt: at,
          ok: 1,
        })
        .onConflictDoUpdate({
          target: schema.dividendHistory.code,
          set: {
            ttmDps: r.d.ttmDps,
            yearly: yearlyJson,
            trend,
            eps: r.d.eps,
            day: today,
            updatedAt: at,
            ok: 1,
          },
        }),
    );
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
}

function parseYearly(json: string): Array<{ year: number; dps: number }> {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is { year: number; dps: number } =>
        !!x &&
        typeof x === "object" &&
        typeof (x as { year?: unknown }).year === "number" &&
        typeof (x as { dps?: unknown }).dps === "number",
    );
  } catch {
    return [];
  }
}

type QuoteFetch = { updated: number; failed: string[]; at: number };

// Fetches fresh quotes for every tracked code (holdings ∪ watchlist ∪ known
// stock rows) and stores them: quotes table gets the full quote, stocks.price
// mirrors the latest good price so computeState stays a pure DB read. A code
// whose fetch fails keeps its previous price and is reported in `failed`.
async function fetchAndStoreQuotes(ctx: Ctx, onlyCodes?: string[]): Promise<QuoteFetch> {
  const db = ctx.db<typeof schema>();
  await ensureDefaults(db);
  let codes: string[];
  if (onlyCodes) {
    codes = [...new Set(onlyCodes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  } else {
    const stockRows = await db.select().from(schema.stocks);
    const watchRows = await db.select().from(schema.watchlist);
    const txRows = await db.select({ code: schema.transactions.code }).from(schema.transactions);
    const set = new Set<string>();
    for (const s of stockRows) set.add(s.code);
    for (const w of watchRows) set.add(w.code);
    for (const t of txRows) {
      if (t.code !== "CASH" && t.code !== "MANUAL") set.add(t.code);
    }
    codes = [...set];
  }
  const at = Date.now();
  let updated = 0;
  const failed: string[] = [];
  const results = await Promise.all(
    codes.map(async (code) => ({ code, q: await fetchQuote(ctx, code) })),
  );
  // 今次攞唔到嘅附加欄位（52 週波幅、股息）唔好洗走上次存低嘅好值。
  const existingQuotes = await db.select().from(schema.quotes);
  const existingByCode = new Map(existingQuotes.map((q) => [q.code, q]));
  const statements: BatchItem<"sqlite">[] = [];
  for (const r of results) {
    if (!r.q) {
      failed.push(r.code);
      statements.push(
        db
          .insert(schema.quotes)
          .values({ code: r.code, price: 0, updatedAt: at, ok: 0 })
          .onConflictDoUpdate({
            target: schema.quotes.code,
            set: { updatedAt: at, ok: 0 },
          }),
      );
      continue;
    }
    updated++;
    const q = r.q;
    const prev = existingByCode.get(r.code);
    const week52High = q.week52High ?? prev?.week52High ?? null;
    const week52Low = q.week52Low ?? prev?.week52Low ?? null;
    const dividendYield = q.dividendYield ?? prev?.dividendYield ?? null;
    const dividendRate = q.dividendRate ?? prev?.dividendRate ?? null;
    statements.push(
      db
        .insert(schema.quotes)
        .values({
          code: r.code,
          price: q.price,
          change: q.change,
          changePct: q.changePct,
          dayHigh: q.dayHigh,
          dayLow: q.dayLow,
          week52High,
          week52Low,
          dividendYield,
          dividendRate,
          name: q.name,
          marketStatus: q.marketStatus,
          asOf: q.asOf,
          updatedAt: at,
          ok: 1,
        })
        .onConflictDoUpdate({
          target: schema.quotes.code,
          set: {
            price: q.price,
            change: q.change,
            changePct: q.changePct,
            dayHigh: q.dayHigh,
            dayLow: q.dayLow,
            week52High,
            week52Low,
            dividendYield,
            dividendRate,
            name: q.name,
            marketStatus: q.marketStatus,
            asOf: q.asOf,
            updatedAt: at,
            ok: 1,
          },
        }),
    );
    statements.push(
      db
        .insert(schema.stocks)
        .values({ code: r.code, price: q.price })
        .onConflictDoUpdate({ target: schema.stocks.code, set: { price: q.price } }),
    );
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  // 順手更新趨勢（每日最多成功計一次，入面自己會跳過今日已計好嘅）。
  await refreshTrends(ctx, codes);
  // 順手抓自動派息歷史（每日最多成功抓一次，同趨勢一樣入面自己跳過）。
  await refreshDividends(ctx, codes);
  return { updated, failed, at };
}

const txOut = z.object({
  id: z.number(),
  date: z.string(),
  code: z.string(),
  currency: z.string(),
  action: z.enum(ACTIONS),
  price: z.number(),
  qty: z.number(),
  fee: z.number(),
  amount: z.number(),
  partner: z.string(),
  note: z.string(),
});

const quoteOut = z.object({
  code: z.string(),
  price: z.number(),
  change: z.number().nullable(),
  changePct: z.number().nullable(),
  dayHigh: z.number().nullable(),
  dayLow: z.number().nullable(),
  week52High: z.number().nullable(),
  week52Low: z.number().nullable(),
  dividendYield: z.number().nullable(),
  dividendRate: z.number().nullable(),
  name: z.string(),
  marketStatus: z.string(),
  asOf: z.string(),
  updatedAt: z.number(),
  ok: z.boolean(),
});

// 監察欄每一行：高息股資料（每股股息、息率）、52 週位置（是否高位）、
// 每手股數＋一手價錢、趨勢（上升／下降／橫行），同按固定規則計出嘅買賣
// 建議。signal 決定顯示顏色，suggestion 係完整句子。
const monitorOut = z.object({
  code: z.string(),
  name: z.string(),
  watched: z.boolean(),
  price: z.number(),
  changePct: z.number().nullable(),
  quoteOk: z.boolean(),
  asOf: z.string(),
  week52High: z.number().nullable(),
  week52Low: z.number().nullable(),
  positionPct: z.number().nullable(),
  positionLabel: z.string(),
  dps: z.number().nullable(),
  dpsSource: z.enum(["manual", "auto", "ledger", "channel"]).nullable(),
  yieldPct: z.number().nullable(),
  // 自動派息（Yahoo 派息歷史，每日抓一次）：TTM DPS、過去 5 個曆年
  // 每年 DPS、派息趨勢（升／平／跌）、每股盈利同派息比率（採用中嘅
  // 每股股息 ÷ EPS）。未抓過／攞唔到就 null／空陣列，唔估。
  autoTtmDps: z.number().nullable(),
  divYears: z.array(z.object({ year: z.number(), dps: z.number() })),
  divTrend: z.enum(["up", "flat", "down"]).nullable(),
  divTrendLabel: z.string(),
  eps: z.number().nullable(),
  payoutRatio: z.number().nullable(),
  lotSize: z.number(),
  lotSizeManual: z.boolean(),
  lotValue: z.number().nullable(),
  trend: z.enum(["up", "down", "sideways"]).nullable(),
  trendLabel: z.string(),
  ma20: z.number().nullable(),
  ma50: z.number().nullable(),
  heldShares: z.number(),
  avgCost: z.number(),
  unrealisedPct: z.number().nullable(),
  signal: z.enum(["buy", "reduce", "hold", "watch", "none"]),
  suggestion: z.string(),
});

const stateResponse = z.object({
  version: z.string(),
  cash: z.number(),
  principal: z.number(),
  totalAssets: z.number(),
  totalProfit: z.number(),
  totalDividend: z.number(),
  totalInterest: z.number(),
  buyCost: z.number(),
  buyFees: z.number(),
  feeRows: z.number(),
  sellProceeds: z.number(),
  stockValue: z.number(),
  totalReturnPct: z.number(),
  cagrPct: z.number(),
  years: z.number(),
  months: z.number(),
  monthlyDeposit: z.number(),
  startDate: z.string(),
  txCount: z.number(),
  quotesUpdatedAt: z.number(),
  holdings: z.array(
    z.object({
      code: z.string(),
      shares: z.number(),
      avgCost: z.number(),
      price: z.number(),
      value: z.number(),
      unrealised: z.number(),
      changePct: z.number().nullable(),
      dayChangeValue: z.number(),
    }),
  ),
  partners: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      expected: z.number(),
      actual: z.number(),
      diff: z.number(),
      sharePct: z.number(),
      pnlShare: z.number(),
    }),
  ),
  stocks: z.array(
    z.object({
      code: z.string(),
      price: z.number(),
      dps: z.number().nullable(),
      lotSize: z.number().nullable(),
    }),
  ),
  quotes: z.array(quoteOut),
  watchlist: z.array(z.object({ code: z.string() })),
  monitor: z.array(monitorOut),
  // 購買股票結餘：現金結餘 − 合夥人差額總和（差額＝實際存入−應存，
  // 有人未存夠就照實扣減總和）。parts 係每位合夥人嘅差額分項。
  buyBalance: z.object({
    cash: z.number(),
    totalDiff: z.number(),
    balance: z.number(),
    parts: z.array(
      z.object({ key: z.string(), name: z.string(), diff: z.number() }),
    ),
  }),
});
type StateOut = z.infer<typeof stateResponse>;

async function computeState(ctx: Ctx): Promise<StateOut> {
  const db = ctx.db<typeof schema>();
  await ensureDefaults(db);
  const txs = await db
    .select()
    .from(schema.transactions)
    .orderBy(asc(schema.transactions.date), asc(schema.transactions.id));
  const partnerRows = await db.select().from(schema.partners).orderBy(asc(schema.partners.sort));
  const stockRows = await db.select().from(schema.stocks).orderBy(asc(schema.stocks.code));
  const quoteRows = await db.select().from(schema.quotes);
  const watchRows = await db.select().from(schema.watchlist).orderBy(asc(schema.watchlist.code));
  const trendRows = await db.select().from(schema.trends);
  const trendByCode = new Map(trendRows.map((t) => [t.code, t]));
  const divRows = await db.select().from(schema.dividendHistory);
  const divByCode = new Map(divRows.map((d) => [d.code, d]));
  const quoteByCode = new Map(quoteRows.map((q) => [q.code, q]));
  const quotesUpdatedAt = quoteRows.reduce((m, q) => Math.max(m, q.updatedAt || 0), 0);
  const prices: Record<string, number> = {};
  for (const s of stockRows) prices[s.code] = s.price || 0;
  const monthlyDeposit = parseFloat(await getSetting(db, "monthlyDeposit", "500")) || 0;
  const startDate = (await getSetting(db, "startDate", "2018-03-01")) || "2018-03-01";

  let cash = 0;
  let principal = 0;
  let totalDividend = 0;
  let totalInterest = 0;
  let buyCost = 0;
  let buyFees = 0;
  let feeRows = 0;
  let sellProceeds = 0;
  const holdingsQty: Record<string, number> = {};
  const boughtQty: Record<string, number> = {};
  const boughtCost: Record<string, number> = {};
  const deposits: Record<string, number> = {};
  // 近 12 個月每隻股收到嘅股息總額（計監察欄嘅每股股息用）。
  const divTrailing: Record<string, number> = {};
  const divCutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  for (const p of partnerRows) deposits[p.key] = 0;

  for (const tx of txs) {
    const amt = tx.amount || 0;
    const fee = tx.fee || 0;
    if (tx.action === "DEPOSIT") {
      cash += amt;
      principal += amt;
      deposits[tx.partner] = (deposits[tx.partner] ?? 0) + amt;
    } else if (tx.action === "INTEREST") {
      cash += amt;
      totalInterest += amt;
    } else if (tx.action === "DIVIDEND") {
      cash += amt;
      totalDividend += amt;
      if (tx.date >= divCutoff) divTrailing[tx.code] = (divTrailing[tx.code] ?? 0) + amt;
    } else if (tx.action === "BUY") {
      cash -= tx.price * tx.qty + fee;
      buyCost += tx.price * tx.qty;
      buyFees += fee;
      holdingsQty[tx.code] = (holdingsQty[tx.code] ?? 0) + tx.qty;
      boughtQty[tx.code] = (boughtQty[tx.code] ?? 0) + tx.qty;
      boughtCost[tx.code] = (boughtCost[tx.code] ?? 0) + tx.price * tx.qty;
    } else if (tx.action === "SELL") {
      cash += tx.price * tx.qty - fee;
      sellProceeds += tx.price * tx.qty;
      buyFees += fee;
      holdingsQty[tx.code] = (holdingsQty[tx.code] ?? 0) - tx.qty;
    } else if (tx.action === "FEE") {
      cash -= amt;
      feeRows += amt;
    } else if (tx.action === "RED_STOCK") {
      holdingsQty[tx.code] = (holdingsQty[tx.code] ?? 0) + tx.qty;
    }
  }

  const holdings = Object.keys(holdingsQty)
    .filter((code) => (holdingsQty[code] ?? 0) !== 0)
    .sort()
    .map((code) => {
      const shares = holdingsQty[code] ?? 0;
      const bq = boughtQty[code] ?? 0;
      const avgCost = bq > 0 ? (boughtCost[code] ?? 0) / bq : 0;
      const price = prices[code] ?? 0;
      const q = quoteByCode.get(code);
      return {
        code,
        shares,
        avgCost,
        price,
        value: shares * price,
        unrealised: shares * price - shares * avgCost,
        changePct: q && q.ok === 1 ? q.changePct : null,
        dayChangeValue: q && q.ok === 1 && q.change !== null ? shares * q.change : 0,
      };
    });
  const stockValue = holdings.reduce((s, r) => s + r.value, 0);
  const totalAssets = cash + stockValue;
  const totalProfit = totalAssets - principal;
  const startMs = new Date(`${startDate}T00:00:00+08:00`).getTime();
  const years = Math.max(0, (Date.now() - startMs) / (365.25 * 86400000));
  const totalReturnPct = principal > 0 ? (totalProfit / principal) * 100 : 0;
  const cagrPct =
    principal > 0 && years > 0 && totalAssets > 0
      ? (Math.pow(totalAssets / principal, 1 / years) - 1) * 100
      : 0;
  const months = monthsSince(startDate);
  const expectedPerPartner = monthlyDeposit * months;
  const partners = partnerRows.map((p) => {
    const actual = deposits[p.key] ?? 0;
    const sharePct = principal > 0 ? (actual / principal) * 100 : 0;
    return {
      key: p.key,
      name: p.name || p.key,
      expected: expectedPerPartner,
      actual,
      diff: actual - expectedPerPartner,
      sharePct,
      pnlShare: (totalProfit * sharePct) / 100,
    };
  });

  // 購買股票結餘：現金結餘 − 差額總和。差額有人負數（未存夠）就照實計，
  // 總和會細啲，結餘自然大啲，唔好夾硬當零。
  const totalDiff = partners.reduce((s, p) => s + p.diff, 0);
  const buyBalance = {
    cash,
    totalDiff,
    balance: cash - totalDiff,
    parts: partners.map((p) => ({ key: p.key, name: p.name, diff: p.diff })),
  };

  // ---- 監察欄：高息股資料 + 52 週位置 + 規則建議 ----
  const holdingByCode = new Map(holdings.map((h) => [h.code, h]));
  const stockByCode = new Map(stockRows.map((s) => [s.code, s]));
  const watchedSet = new Set(watchRows.map((w) => w.code));
  const monitorCodes = new Set<string>();
  for (const h of holdings) monitorCodes.add(h.code);
  for (const w of watchRows) monitorCodes.add(w.code);
  for (const s of stockRows) {
    if (s.code !== "CASH" && s.code !== "MANUAL") monitorCodes.add(s.code);
  }
  const monitor = [...monitorCodes].sort().map((code) => {
    const q = quoteByCode.get(code);
    const quoteOk = !!q && q.ok === 1 && q.price > 0;
    const price = prices[code] ?? 0;
    const held = holdingByCode.get(code);
    const heldShares = held?.shares ?? 0;
    const avgCost = held?.avgCost ?? 0;
    const wHigh = q?.week52High ?? null;
    const wLow = q?.week52Low ?? null;
    let positionPct: number | null = null;
    if (price > 0 && wHigh !== null && wLow !== null && wHigh > wLow) {
      positionPct = Math.min(100, Math.max(0, ((price - wLow) / (wHigh - wLow)) * 100));
    }
    const positionLabel =
      positionPct === null
        ? "未有 52 週數據"
        : positionPct >= 80
          ? "高位"
          : positionPct >= 60
            ? "偏高"
            : positionPct >= 40
              ? "中位"
              : positionPct >= 20
                ? "偏低"
                : "低位";
    // 每股股息優先次序：手動輸入 > 自動抓取 TTM DPS（Yahoo 派息歷史）
    // > 帳目近 12 個月股息 ÷ 現持股數 > 渠道俾嘅每股股息（dividend_rate）。
    const manualDps = stockByCode.get(code)?.dps ?? null;
    const divRow = divByCode.get(code);
    const autoTtmDps =
      divRow && divRow.ttmDps !== null && divRow.ttmDps > 0 ? divRow.ttmDps : null;
    const divYears = divRow ? parseYearly(divRow.yearly) : [];
    const divTrend: "up" | "flat" | "down" | null =
      divRow && (divRow.trend === "up" || divRow.trend === "flat" || divRow.trend === "down")
        ? divRow.trend
        : null;
    const divTrendLabel =
      divTrend === "up"
        ? "派息上升"
        : divTrend === "down"
          ? "派息下降"
          : divTrend === "flat"
            ? "派息平穩"
            : "未有派息趨勢";
    const eps = divRow?.eps ?? null;
    let dps: number | null = null;
    let dpsSource: "manual" | "auto" | "ledger" | "channel" | null = null;
    if (manualDps !== null && manualDps > 0) {
      dps = manualDps;
      dpsSource = "manual";
    } else if (autoTtmDps !== null) {
      dps = autoTtmDps;
      dpsSource = "auto";
    } else if (heldShares > 0 && (divTrailing[code] ?? 0) > 0) {
      dps = (divTrailing[code] ?? 0) / heldShares;
      dpsSource = "ledger";
    } else if (q && q.dividendRate !== null && q.dividendRate > 0) {
      dps = q.dividendRate;
      dpsSource = "channel";
    }
    // 派息比率 = 採用中嘅每股股息 ÷ 每股盈利（EPS ≤ 0 就唔計，冇意思）。
    const payoutRatio =
      dps !== null && eps !== null && eps > 0 ? (dps / eps) * 100 : null;
    let yieldPct: number | null = null;
    if (dps !== null && price > 0) yieldPct = (dps / price) * 100;
    else if (q && q.dividendYield !== null && q.dividendYield > 0) yieldPct = q.dividendYield;
    const unrealisedPct =
      heldShares !== 0 && avgCost > 0 && price > 0 ? ((price - avgCost) / avgCost) * 100 : null;
    // 每手股數：一手價錢 = 現價 × 每手股數（唔計手續費）。
    const manualLot = stockByCode.get(code)?.lotSize ?? null;
    const lotSize = lotSizeFor(code, manualLot);
    const lotSizeManual = manualLot !== null && manualLot > 0;
    const lotValue = price > 0 ? price * lotSize : null;
    // 趨勢：refreshPrices 每日計一次存低；未計過／攞唔到就 null。
    const trendRow = trendByCode.get(code);
    const trend: "up" | "down" | "sideways" | null =
      trendRow &&
      trendRow.ok === 1 &&
      (trendRow.trend === "up" || trendRow.trend === "down" || trendRow.trend === "sideways")
        ? trendRow.trend
        : null;
    const trendLabel =
      trend === "up"
        ? "上升軌"
        : trend === "down"
          ? "下降軌"
          : trend === "sideways"
            ? "橫行／整固"
            : "未有趨勢數據";
    const ma20 = trend !== null && trendRow ? trendRow.ma20 : null;
    const ma50 = trend !== null && trendRow ? trendRow.ma50 : null;
    // 買賣建議：固定規則，睇息率 + 52 週位置 + 是否持有，唔係預測。
    let signal: "buy" | "reduce" | "hold" | "watch" | "none" = "none";
    let suggestion = "未有報價，未能判斷";
    if (price > 0) {
      if (positionPct !== null && positionPct >= 85) {
        if (heldShares > 0) {
          signal = "reduce";
          suggestion = "處於 52 週高位：考慮分批止賺／減持，唔好喺呢個位加注";
        } else {
          signal = "watch";
          suggestion = "處於 52 週高位：唔好追買，等回落先再考慮";
        }
      } else if (
        yieldPct !== null &&
        yieldPct >= 5 &&
        (positionPct === null || positionPct <= 50)
      ) {
        signal = "buy";
        suggestion =
          heldShares > 0
            ? "息率高、位置未算高：可考慮加注收息"
            : "息率高、位置未算高：可分批買入收息";
      } else if (
        yieldPct !== null &&
        yieldPct < 3 &&
        positionPct !== null &&
        positionPct >= 70
      ) {
        signal = "watch";
        suggestion =
          heldShares > 0
            ? "息率偏低又近高位：持有住先，唔加注"
            : "息率偏低又近高位：觀望，唔值得喺高位追";
      } else if (heldShares > 0) {
        signal = "hold";
        suggestion = "未有明顯訊號：繼續持有收息";
      } else {
        signal = "watch";
        suggestion = "未有明顯訊號：觀望，等息率或位置更好先買";
      }
    }
    return {
      code,
      name: q?.name ?? "",
      watched: watchedSet.has(code),
      price,
      changePct: quoteOk ? (q?.changePct ?? null) : null,
      quoteOk,
      asOf: q?.asOf ?? "",
      week52High: wHigh,
      week52Low: wLow,
      positionPct,
      positionLabel,
      dps,
      dpsSource,
      yieldPct,
      autoTtmDps,
      divYears,
      divTrend,
      divTrendLabel,
      eps,
      payoutRatio,
      lotSize,
      lotSizeManual,
      lotValue,
      trend,
      trendLabel,
      ma20,
      ma50,
      heldShares,
      avgCost,
      unrealisedPct,
      signal,
      suggestion,
    };
  });

  return {
    version: VERSION,
    cash,
    principal,
    totalAssets,
    totalProfit,
    totalDividend,
    totalInterest,
    buyCost,
    buyFees,
    feeRows,
    sellProceeds,
    stockValue,
    totalReturnPct,
    cagrPct,
    years,
    months,
    monthlyDeposit,
    startDate,
    txCount: txs.length,
    quotesUpdatedAt,
    holdings,
    partners,
    stocks: stockRows.map((s) => ({
      code: s.code,
      price: s.price,
      dps: s.dps ?? null,
      lotSize: s.lotSize ?? null,
    })),
    quotes: quoteRows
      .map((q) => ({
        code: q.code,
        price: q.price,
        change: q.change,
        changePct: q.changePct,
        dayHigh: q.dayHigh,
        dayLow: q.dayLow,
        week52High: q.week52High,
        week52Low: q.week52Low,
        dividendYield: q.dividendYield,
        dividendRate: q.dividendRate,
        name: q.name,
        marketStatus: q.marketStatus,
        asOf: q.asOf,
        updatedAt: q.updatedAt,
        ok: q.ok === 1,
      }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    watchlist: watchRows.map((w) => ({ code: w.code })),
    monitor,
    buyBalance,
  };
}

const okResponse = z.object({ ok: z.literal(true) });

export const Actions = {
  getState: defineAction({
    description: "Returns the computed partnership overview: cash, holdings, partner balances, the dividend-monitor rows (yield, dividend source with manual > auto-TTM > ledger priority, payout ratio, five-year dividend history and trend, 52-week position, board-lot value, price trend, rule-based suggestion), the buy-stock balance (cash minus total partner surplus), latest stored quotes, watchlist and settings.",
    request: z.object({}),
    response: stateResponse,
    async handler(ctx): Promise<StateOut> {
      return computeState(ctx);
    },
  }),

  refreshPrices: defineAction({
    description: "Fetches fresh quotes for all holdings and watchlist stocks from the finance channel and stores them, refreshes each stock's trend (MA20/MA50, at most once per day) and auto dividend history (Yahoo TTM DPS, five-year yearly DPS, trailing EPS; at most once per day); returns how many updated and which codes failed.",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      updated: z.number(),
      failed: z.array(z.string()),
      at: z.number(),
    }),
    async handler(ctx) {
      const r = await fetchAndStoreQuotes(ctx);
      ctx.invalidateQueries();
      return { ok: true as const, updated: r.updated, failed: r.failed, at: r.at };
    },
  }),

  addWatchlist: defineAction({
    description: "Adds a stock code to the monitoring watchlist (no holding needed) and fetches its quote right away.",
    request: z.object({ code: z.string().min(1).max(20) }),
    response: z.object({ ok: z.literal(true), quoted: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureDefaults(db);
      const code = args.code.trim().toUpperCase();
      await db
        .insert(schema.watchlist)
        .values({ code, createdAt: Date.now() })
        .onConflictDoNothing();
      await db.insert(schema.stocks).values({ code, price: 0 }).onConflictDoNothing();
      const r = await fetchAndStoreQuotes(ctx, [code]);
      ctx.invalidateQueries();
      return { ok: true as const, quoted: r.updated > 0 };
    },
  }),

  removeWatchlist: defineAction({
    description: "Removes a stock code from the monitoring watchlist (holdings and transactions are kept).",
    request: z.object({ code: z.string().min(1).max(20) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.watchlist).where(eq(schema.watchlist.code, args.code.trim().toUpperCase()));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setStockDps: defineAction({
    description: "Sets (or clears, with 0/null) the user-entered annual dividend per share for a stock code, used by the monitor tab's yield and suggestion rules.",
    request: z.object({
      code: z.string().min(1).max(20),
      dps: z.number().finite().min(0).max(10000).nullable(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await ensureDefaults(db);
      const code = args.code.trim().toUpperCase();
      const dps = args.dps !== null && args.dps > 0 ? args.dps : null;
      await db
        .insert(schema.stocks)
        .values({ code, price: 0, dps })
        .onConflictDoUpdate({ target: schema.stocks.code, set: { dps } });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setStockLotSize: defineAction({
    description: "Sets (or clears, with null) the user-entered board lot size (shares per lot) for a stock code, used by the monitor tab's per-lot value; clearing falls back to the verified default.",
    request: z.object({
      code: z.string().min(1).max(20),
      lotSize: z.number().int().min(1).max(1000000).nullable(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await ensureDefaults(db);
      const code = args.code.trim().toUpperCase();
      const lotSize = args.lotSize !== null && args.lotSize > 0 ? args.lotSize : null;
      await db
        .insert(schema.stocks)
        .values({ code, price: 0, lotSize })
        .onConflictDoUpdate({ target: schema.stocks.code, set: { lotSize } });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listTransactions: defineAction({
    description: "Lists transactions newest first, optionally filtered by action, partner or stock code.",
    request: z.object({
      action: z.string().optional(),
      partner: z.string().optional(),
      code: z.string().optional(),
      limit: z.number().int().positive().max(2000).default(500),
    }),
    response: z.object({ transactions: z.array(txOut), total: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.transactions)
        .orderBy(desc(schema.transactions.date), desc(schema.transactions.id));
      const filtered = rows.filter(
        (r) =>
          (!args.action || r.action === args.action) &&
          (!args.partner || r.partner === args.partner) &&
          (!args.code || r.code === args.code),
      );
      return {
        total: filtered.length,
        transactions: filtered.slice(0, args.limit).map((r) => ({
          id: r.id,
          date: r.date,
          code: r.code,
          currency: r.currency,
          action: r.action,
          price: r.price,
          qty: r.qty,
          fee: r.fee,
          amount: r.amount,
          partner: r.partner,
          note: r.note,
        })),
      };
    },
  }),

  createTransaction: defineAction({
    description: "Adds one transaction; exact duplicates (same dedupe key) are rejected.",
    request: txInput,
    response: z.object({ ok: z.boolean(), id: z.number().nullable(), duplicate: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureDefaults(db);
      const n = normalizeTx(args);
      const existing = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.dedupeKey, n.dedupeKey));
      if (existing.length > 0) return { ok: false, id: null, duplicate: true };
      const inserted = await db
        .insert(schema.transactions)
        .values({
          date: n.date,
          code: n.code,
          currency: n.currency,
          action: n.action,
          price: n.price,
          qty: n.qty,
          fee: n.fee,
          amount: n.amount,
          partner: n.partner,
          note: n.note,
          dedupeKey: n.dedupeKey,
        })
        .returning({ id: schema.transactions.id });
      if (n.code !== "CASH" && n.code !== "MANUAL") {
        await db.insert(schema.stocks).values({ code: n.code, price: 0 }).onConflictDoNothing();
      }
      ctx.invalidateQueries();
      return { ok: true, id: inserted[0]?.id ?? null, duplicate: false };
    },
  }),

  updateTransaction: defineAction({
    description: "Updates one transaction by id and recomputes its amount and dedupe key.",
    request: txInput.extend({ id: z.number().int().positive() }),
    response: z.object({ ok: z.boolean(), duplicate: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const n = normalizeTx(args);
      const clash = await db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.dedupeKey, n.dedupeKey));
      if (clash.length > 0 && clash[0] && clash[0].id !== args.id) {
        return { ok: false, duplicate: true };
      }
      await db
        .update(schema.transactions)
        .set({
          date: n.date,
          code: n.code,
          currency: n.currency,
          action: n.action,
          price: n.price,
          qty: n.qty,
          fee: n.fee,
          amount: n.amount,
          partner: n.partner,
          note: n.note,
          dedupeKey: n.dedupeKey,
        })
        .where(eq(schema.transactions.id, args.id));
      if (n.code !== "CASH" && n.code !== "MANUAL") {
        await db.insert(schema.stocks).values({ code: n.code, price: 0 }).onConflictDoNothing();
      }
      ctx.invalidateQueries();
      return { ok: true, duplicate: false };
    },
  }),

  deleteTransaction: defineAction({
    description: "Deletes one transaction by id.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.transactions).where(eq(schema.transactions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteManyTransactions: defineAction({
    description: "Deletes several transactions by id in one call.",
    request: z.object({ ids: z.array(z.number().int().positive()).min(1).max(2000) }),
    response: z.object({ ok: z.literal(true), deleted: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const statements: BatchItem<"sqlite">[] = args.ids.map((id) =>
        db.delete(schema.transactions).where(eq(schema.transactions.id, id)),
      );
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      ctx.invalidateQueries();
      return { ok: true as const, deleted: args.ids.length };
    },
  }),

  importTransactions: defineAction({
    description: "Imports parsed transactions (from CSV or JSON backup), skipping exact duplicates; returns added/skipped counts.",
    request: z.object({ transactions: z.array(txInput).max(5000) }),
    response: z.object({ ok: z.literal(true), added: z.number(), skipped: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureDefaults(db);
      const existingRows = await db.select({ k: schema.transactions.dedupeKey }).from(schema.transactions);
      const seen = new Set(existingRows.map((r) => r.k));
      const statements: BatchItem<"sqlite">[] = [];
      let added = 0;
      let skipped = 0;
      const newCodes = new Set<string>();
      for (const raw of args.transactions) {
        const n = normalizeTx(raw);
        if (seen.has(n.dedupeKey)) {
          skipped++;
          continue;
        }
        seen.add(n.dedupeKey);
        added++;
        if (n.code !== "CASH" && n.code !== "MANUAL") newCodes.add(n.code);
        statements.push(
          db
            .insert(schema.transactions)
            .values({
              date: n.date,
              code: n.code,
              currency: n.currency,
              action: n.action,
              price: n.price,
              qty: n.qty,
              fee: n.fee,
              amount: n.amount,
              partner: n.partner,
              note: n.note,
              dedupeKey: n.dedupeKey,
            })
            .onConflictDoNothing(),
        );
      }
      for (const code of newCodes) {
        statements.push(db.insert(schema.stocks).values({ code, price: 0 }).onConflictDoNothing());
      }
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      ctx.invalidateQueries();
      return { ok: true as const, added, skipped };
    },
  }),

  seedTransactions: defineAction({
    description: "One-time seed of the 198 v3.0.0 transactions plus default partners/settings; idempotent via dedupe keys, never overwrites existing rows.",
    request: z.object({ transactions: z.array(txInput).max(5000) }),
    response: z.object({ ok: z.literal(true), added: z.number(), skipped: z.number(), total: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureDefaults(db);
      const existingRows = await db.select({ k: schema.transactions.dedupeKey }).from(schema.transactions);
      const seen = new Set(existingRows.map((r) => r.k));
      const statements: BatchItem<"sqlite">[] = [];
      let added = 0;
      let skipped = 0;
      for (const raw of args.transactions) {
        const n = normalizeTx(raw);
        if (seen.has(n.dedupeKey)) {
          skipped++;
          continue;
        }
        seen.add(n.dedupeKey);
        added++;
        statements.push(
          db
            .insert(schema.transactions)
            .values({
              date: n.date,
              code: n.code,
              currency: n.currency,
              action: n.action,
              price: n.price,
              qty: n.qty,
              fee: n.fee,
              amount: n.amount,
              partner: n.partner,
              note: n.note,
              dedupeKey: n.dedupeKey,
            })
            .onConflictDoNothing(),
        );
      }
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      const count = await db.select({ id: schema.transactions.id }).from(schema.transactions);
      ctx.invalidateQueries();
      return { ok: true as const, added, skipped, total: count.length };
    },
  }),

  exportBackup: defineAction({
    description: "Returns a full JSON backup: all transactions, partners, stock prices (with manual dividend-per-share and board lot size), watchlist, trends, auto dividend history and settings.",
    request: z.object({}),
    response: z.object({
      version: z.string(),
      exportedAt: z.string(),
      transactions: z.array(txOut.omit({ id: true })),
      partners: z.array(z.object({ key: z.string(), name: z.string(), sort: z.number() })),
      stocks: z.array(
        z.object({
          code: z.string(),
          price: z.number(),
          dps: z.number().nullable(),
          lotSize: z.number().nullable(),
        }),
      ),
      watchlist: z.array(z.string()),
      trends: z.array(
        z.object({
          code: z.string(),
          trend: z.string(),
          ma20: z.number().nullable(),
          ma50: z.number().nullable(),
          day: z.string(),
        }),
      ),
      dividends: z.array(
        z.object({
          code: z.string(),
          ttmDps: z.number().nullable(),
          yearly: z.array(z.object({ year: z.number(), dps: z.number() })),
          trend: z.string(),
          eps: z.number().nullable(),
          day: z.string(),
        }),
      ),
      settings: z.object({ monthlyDeposit: z.number(), startDate: z.string() }),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      await ensureDefaults(db);
      const txs = await db
        .select()
        .from(schema.transactions)
        .orderBy(asc(schema.transactions.date), asc(schema.transactions.id));
      const partnerRows = await db.select().from(schema.partners).orderBy(asc(schema.partners.sort));
      const stockRows = await db.select().from(schema.stocks).orderBy(asc(schema.stocks.code));
      const watchRows = await db.select().from(schema.watchlist).orderBy(asc(schema.watchlist.code));
      const trendRows = await db.select().from(schema.trends);
      const divRows = await db.select().from(schema.dividendHistory);
      return {
        version: VERSION,
        exportedAt: new Date().toISOString(),
        transactions: txs.map((r) => ({
          date: r.date,
          code: r.code,
          currency: r.currency,
          action: r.action,
          price: r.price,
          qty: r.qty,
          fee: r.fee,
          amount: r.amount,
          partner: r.partner,
          note: r.note,
        })),
        partners: partnerRows.map((p) => ({ key: p.key, name: p.name, sort: p.sort })),
        stocks: stockRows.map((s) => ({
          code: s.code,
          price: s.price,
          dps: s.dps ?? null,
          lotSize: s.lotSize ?? null,
        })),
        watchlist: watchRows.map((w) => w.code),
        trends: trendRows
          .filter((t) => t.ok === 1)
          .map((t) => ({ code: t.code, trend: t.trend, ma20: t.ma20, ma50: t.ma50, day: t.day })),
        dividends: divRows
          .filter((d) => d.ok === 1)
          .map((d) => ({
            code: d.code,
            ttmDps: d.ttmDps,
            yearly: parseYearly(d.yearly),
            trend: d.trend,
            eps: d.eps,
            day: d.day,
          })),
        settings: {
          monthlyDeposit: parseFloat(await getSetting(db, "monthlyDeposit", "500")) || 0,
          startDate: await getSetting(db, "startDate", "2018-03-01"),
        },
      };
    },
  }),

  restoreBackup: defineAction({
    description: "Restores a JSON backup: with replaceAll it wipes transactions first, otherwise it merges skipping duplicates; partners, prices and settings are upserted.",
    request: z.object({
      replaceAll: z.boolean().default(false),
      transactions: z.array(txInput).max(5000),
      partners: z.array(z.object({ key: z.string(), name: z.string(), sort: z.number() })).default([]),
      stocks: z
        .array(
          z.object({
            code: z.string(),
            price: z.number(),
            dps: z.number().nullable().optional(),
            lotSize: z.number().int().positive().nullable().optional(),
          }),
        )
        .default([]),
      watchlist: z.array(z.string().max(20)).default([]),
      trends: z
        .array(
          z.object({
            code: z.string().max(20),
            trend: z.string().max(20),
            ma20: z.number().nullable(),
            ma50: z.number().nullable(),
            day: z.string().max(10),
          }),
        )
        .default([]),
      dividends: z
        .array(
          z.object({
            code: z.string().max(20),
            ttmDps: z.number().nullable(),
            yearly: z.array(z.object({ year: z.number(), dps: z.number() })).default([]),
            trend: z.string().max(20),
            eps: z.number().nullable(),
            day: z.string().max(10),
          }),
        )
        .default([]),
      settings: z
        .object({ monthlyDeposit: z.number(), startDate: z.string() })
        .optional(),
    }),
    response: z.object({ ok: z.literal(true), added: z.number(), skipped: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureDefaults(db);
      const statements: BatchItem<"sqlite">[] = [];
      if (args.replaceAll) {
        statements.push(db.delete(schema.transactions));
      }
      for (const p of args.partners) {
        statements.push(
          db
            .insert(schema.partners)
            .values({ key: p.key.toUpperCase(), name: p.name, sort: p.sort })
            .onConflictDoUpdate({
              target: schema.partners.key,
              set: { name: p.name, sort: p.sort },
            }),
        );
      }
      for (const s of args.stocks) {
        statements.push(
          db
            .insert(schema.stocks)
            .values({
              code: s.code.toUpperCase(),
              price: s.price,
              dps: s.dps ?? null,
              lotSize: s.lotSize ?? null,
            })
            .onConflictDoUpdate({
              target: schema.stocks.code,
              set: {
                price: s.price,
                ...(s.dps !== undefined ? { dps: s.dps } : {}),
                ...(s.lotSize !== undefined ? { lotSize: s.lotSize } : {}),
              },
            }),
        );
      }
      for (const t of args.trends) {
        const c = t.code.trim().toUpperCase();
        if (!c || (t.trend !== "up" && t.trend !== "down" && t.trend !== "sideways")) continue;
        statements.push(
          db
            .insert(schema.trends)
            .values({
              code: c,
              trend: t.trend,
              ma20: t.ma20,
              ma50: t.ma50,
              day: t.day,
              updatedAt: Date.now(),
              ok: 1,
            })
            .onConflictDoUpdate({
              target: schema.trends.code,
              set: { trend: t.trend, ma20: t.ma20, ma50: t.ma50, day: t.day, updatedAt: Date.now(), ok: 1 },
            }),
        );
      }
      for (const d of args.dividends) {
        const c = d.code.trim().toUpperCase();
        if (!c || (d.trend !== "up" && d.trend !== "flat" && d.trend !== "down" && d.trend !== "")) continue;
        const yearlyJson = JSON.stringify(d.yearly ?? []);
        statements.push(
          db
            .insert(schema.dividendHistory)
            .values({
              code: c,
              ttmDps: d.ttmDps,
              yearly: yearlyJson,
              trend: d.trend,
              eps: d.eps,
              day: d.day,
              updatedAt: Date.now(),
              ok: 1,
            })
            .onConflictDoUpdate({
              target: schema.dividendHistory.code,
              set: {
                ttmDps: d.ttmDps,
                yearly: yearlyJson,
                trend: d.trend,
                eps: d.eps,
                day: d.day,
                updatedAt: Date.now(),
                ok: 1,
              },
            }),
        );
      }
      for (const code of args.watchlist) {
        const c = code.trim().toUpperCase();
        if (!c) continue;
        statements.push(
          db.insert(schema.watchlist).values({ code: c, createdAt: Date.now() }).onConflictDoNothing(),
        );
        statements.push(db.insert(schema.stocks).values({ code: c, price: 0 }).onConflictDoNothing());
      }
      const seen = new Set<string>();
      if (!args.replaceAll) {
        const existingRows = await db
          .select({ k: schema.transactions.dedupeKey })
          .from(schema.transactions);
        for (const r of existingRows) seen.add(r.k);
      }
      let added = 0;
      let skipped = 0;
      for (const raw of args.transactions) {
        const n = normalizeTx(raw);
        if (seen.has(n.dedupeKey)) {
          skipped++;
          continue;
        }
        seen.add(n.dedupeKey);
        added++;
        statements.push(
          db
            .insert(schema.transactions)
            .values({
              date: n.date,
              code: n.code,
              currency: n.currency,
              action: n.action,
              price: n.price,
              qty: n.qty,
              fee: n.fee,
              amount: n.amount,
              partner: n.partner,
              note: n.note,
              dedupeKey: n.dedupeKey,
            })
            .onConflictDoNothing(),
        );
      }
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      if (args.settings) {
        await setSetting(db, "monthlyDeposit", String(args.settings.monthlyDeposit));
        await setSetting(db, "startDate", args.settings.startDate);
      }
      ctx.invalidateQueries();
      return { ok: true as const, added, skipped };
    },
  }),

  updatePrices: defineAction({
    description: "Sets current prices for one or more stock codes (manual prices, keyed by code).",
    request: z.object({ prices: z.record(z.string(), z.number().finite().min(0)) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await ensureDefaults(db);
      for (const [code, price] of Object.entries(args.prices)) {
        const c = code.trim().toUpperCase();
        if (!c) continue;
        await db
          .insert(schema.stocks)
          .values({ code: c, price })
          .onConflictDoUpdate({ target: schema.stocks.code, set: { price } });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  upsertPartner: defineAction({
    description: "Adds a partner or renames an existing one (key is the single-letter code used on transactions).",
    request: z.object({
      key: z.string().min(1).max(4),
      name: z.string().max(20),
      sort: z.number().int().min(0).max(999).optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await ensureDefaults(db);
      const key = args.key.trim().toUpperCase();
      const rows = await db.select().from(schema.partners).orderBy(desc(schema.partners.sort));
      const sort = args.sort ?? ((rows[0]?.sort ?? 0) + 1);
      await db
        .insert(schema.partners)
        .values({ key, name: args.name.trim(), sort })
        .onConflictDoUpdate({
          target: schema.partners.key,
          set: { name: args.name.trim(), sort },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deletePartner: defineAction({
    description: "Removes a partner record (their past transactions are kept).",
    request: z.object({ key: z.string().min(1) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.partners).where(eq(schema.partners.key, args.key.toUpperCase()));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteStock: defineAction({
    description: "Removes a stock code and its stored price (transactions are kept).",
    request: z.object({ code: z.string().min(1) }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.stocks).where(eq(schema.stocks.code, args.code.toUpperCase()));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  updateSettings: defineAction({
    description: "Updates the monthly expected deposit and/or the partnership start date.",
    request: z.object({
      monthlyDeposit: z.number().finite().min(0).optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await ensureDefaults(db);
      if (args.monthlyDeposit !== undefined) {
        await setSetting(db, "monthlyDeposit", String(args.monthlyDeposit));
      }
      if (args.startDate !== undefined) {
        await setSetting(db, "startDate", args.startDate);
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  resetAll: defineAction({
    description: "Deletes ALL transactions (partners, prices and settings are kept). Destructive; the UI confirms first.",
    request: z.object({}),
    response: okResponse,
    async handler(ctx): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.transactions);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
