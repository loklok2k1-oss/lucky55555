import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One row per ledger transaction. `date` is a plain calendar date
// (YYYY-MM-DD, text — no timezone semantics). `amount` is the cash amount
// implied by the action (see actions.ts amountFor): DEPOSIT/INTEREST =
// price, DIVIDEND = price (or price*qty), BUY/SELL = price*qty, FEE = fee,
// RED_STOCK = 0.
export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  code: text("code").notNull().default("CASH"),
  currency: text("currency").notNull().default("HKD"),
  action: text("action", {
    enum: ["BUY", "SELL", "DIVIDEND", "RED_STOCK", "INTEREST", "DEPOSIT", "FEE"],
  }).notNull(),
  price: real("price").notNull().default(0),
  qty: real("qty").notNull().default(0),
  fee: real("fee").notNull().default(0),
  amount: real("amount").notNull().default(0),
  partner: text("partner").notNull().default("NONE"),
  note: text("note").notNull().default(""),
  // Dedupe key: date|code|action|price|qty|fee|partner|note — unique so
  // seed / CSV import / JSON restore can run repeatedly without duplicates.
  dedupeKey: text("dedupe_key").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const partners = sqliteTable("partners", {
  key: text("key").primaryKey(),
  name: text("name").notNull().default(""),
  sort: integer("sort").notNull().default(0),
});

// Current price per stock code (mirrors the latest good quote; v3.1.0+ the
// price is auto-fetched, never typed in by hand). `dps` is an optional
// user-entered annual dividend per share (HK$) used by the monitor tab when
// the ledger has no trailing dividend for the code; null = not set.
// `lotSize` is the board lot (shares per lot) used for the monitor tab's
// per-lot value; null = fall back to the verified defaults in actions.ts.
export const stocks = sqliteTable("stocks", {
  code: text("code").primaryKey(),
  price: real("price").notNull().default(0),
  dps: real("dps"),
  lotSize: integer("lot_size"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
});

// Latest auto-fetched quote per stock code (v3.1.0: prices come from the
// managed finance channel, refreshed by the refreshPrices action — never
// typed in by hand). `updatedAt` is epoch ms of the last fetch attempt;
// `ok` = 1 when that attempt returned a usable price.
export const quotes = sqliteTable("quotes", {
  code: text("code").primaryKey(),
  price: real("price").notNull().default(0),
  change: real("change"),
  changePct: real("change_pct"),
  dayHigh: real("day_high"),
  dayLow: real("day_low"),
  week52High: real("week52_high"),
  week52Low: real("week52_low"),
  // Dividend data when the quote channel supplies it (v3.2.0); both nullable
  // because most HK quotes come from Tencent, which carries neither.
  dividendYield: real("dividend_yield"),
  dividendRate: real("dividend_rate"),
  name: text("name").notNull().default(""),
  marketStatus: text("market_status").notNull().default(""),
  asOf: text("as_of").notNull().default(""),
  updatedAt: integer("updated_at").notNull().default(0),
  ok: integer("ok").notNull().default(0),
});

// Stock codes the user monitors beyond (or without) holdings. Holdings are
// always price-tracked; watchlist codes join the same refresh set.
export const watchlist = sqliteTable("watchlist", {
  code: text("code").primaryKey(),
  createdAt: integer("created_at").notNull().default(0),
});

// Latest computed trend per stock code (v3.2.1): derived from Yahoo v8 chart
// daily closes (6 months) by the refreshPrices action, at most once per
// Asia/Macau calendar day (`day` = YYYY-MM-DD of the last successful compute).
// `trend` is "up" | "down" | "sideways"; empty when never computed. `ok` = 1
// when the last attempt produced a trend.
export const trends = sqliteTable("trends", {
  code: text("code").primaryKey(),
  trend: text("trend").notNull().default(""),
  ma20: real("ma20"),
  ma50: real("ma50"),
  day: text("day").notNull().default(""),
  updatedAt: integer("updated_at").notNull().default(0),
  ok: integer("ok").notNull().default(0),
});

// Auto-fetched dividend history per stock code (v3.3.0): pulled from Yahoo
// v8 chart dividend events (5.5 years) by the refreshPrices action, at most
// once per Asia/Macau calendar day (`day` = YYYY-MM-DD of the last successful
// fetch). `ttmDps` = dividends paid in the trailing 12 months; `yearly` is a
// JSON array of { year, dps } for the last five calendar years; `trend` is
// "up" | "flat" | "down" comparing the two most recent complete years;
// `eps` is Yahoo's trailing EPS (quoteSummary, crumb flow) used for the
// payout ratio. A failed fetch keeps the previous good values (only `ok`
// flips to 0), so the monitor never loses the last known dividend data.
export const dividendHistory = sqliteTable("dividend_history", {
  code: text("code").primaryKey(),
  ttmDps: real("ttm_dps"),
  yearly: text("yearly").notNull().default("[]"),
  trend: text("trend").notNull().default(""),
  eps: real("eps"),
  day: text("day").notNull().default(""),
  updatedAt: integer("updated_at").notNull().default(0),
  ok: integer("ok").notNull().default(0),
});
