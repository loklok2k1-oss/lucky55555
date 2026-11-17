// 手動重新匯入種子 CSV：npm run seed
// 會跳過資料庫入面已經有嘅重複交易，唔會洗走現有資料。
"use strict";
const fs = require("fs");
const path = require("path");
const seedPath = path.join(__dirname, "..", "data", "seed.csv");
if (!fs.existsSync(seedPath)) { console.error("搵唔到 data/seed.csv"); process.exit(1); }
// 啟動 server.js 嗰陣已經自動 seed 過一次，呢度只係畀人手動再跑一次檢查用。
console.log("請直接啟動伺服器（npm start），首次啟動會自動匯入 data/seed.csv。");
console.log("如需強制重新匯入，請先停 server，刪除 data/partnership.db，再 npm start。");
