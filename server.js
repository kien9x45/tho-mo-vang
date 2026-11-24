'use strict';
/*
 * Thợ Mỏ Vàng — server độc lập, KHÔNG dùng thư viện ngoài.
 * Chạy: node server.js   (cổng: process.env.PORT, mặc định 3000)
 * Dữ liệu: nếu có biến môi trường DATABASE_URL -> lưu vào Neon Postgres (bảng game_state,
 *   qua Neon HTTP API bằng fetch thuần) để không mất dữ liệu khi host miễn phí (Render Free)
 *   xoá filesystem lúc khởi động lại. Không có DATABASE_URL -> lưu file data.json cùng
 *   thư mục như trước (ghi an toàn: file tạm + rename).
 * Mã chủ game: biến môi trường OWNER_KEY (không đặt = khoá luôn các endpoint chủ game).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const OWNER_KEY = process.env.OWNER_KEY || ''; // rỗng = khoá luôn endpoint chủ game (không còn mã mặc định trong code)
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;

/* ---------------- Thông số game (đã chốt, không tự ý đổi) ---------------- */
const START_GOLD = 50000;           // quà tân thủ (giảm từ 300.000 — cân bằng lại 2026-11-24)
const START_GEMS = 1500;            // quà tân thủ
const BASE_RATE = 1.9;              // Lv.1 = 1.9 + 0.1*1 = 2.0 vàng/giây (giảm từ 6.0 — cân bằng lại 2026-11-24)
const RATE_PER_LEVEL = 0.1;
const UPGRADE_COST_GEMS = 5000;     // nâng cấp thợ: phẳng 5.000 KC/cấp (client hiển thị, trừ KC qua /api/save có kiểm tra)
const EXCHANGE_RATE = 125;          // 125 vàng = 1 kim cương (một chiều vàng -> KC)
const WITHDRAW_RATE = 0.0005;       // 1 vàng = 0,0005 VNĐ
const WITHDRAW_MIN_GOLD = 4000000;  // tối thiểu 4.000.000 vàng
const SESSION_SECONDS = 4 * 3600;   // phiên đào 4 giờ
const OFFLINE_CAP_SECONDS = 6 * 3600; // trần offline 6 giờ (giảm từ 8 giờ — cân bằng lại 2026-11-24)
const OFFLINE_RATE = 0.25;          // offline = 25% tốc độ thường
const REFERRAL_REWARD = { gold: 25000, gems: 500 }; // quà NGAY cho người được mời khi ghi nhận ref (làm lại 2026-11-24: nặng KC vì KC không rút thành tiền được)
const REFERRAL_INVITER_REWARD = { gold: 2000, gems: 50 }; // quà NGAY cho người mời khi bạn mới ghi nhận ref
const REFERRAL_MILESTONE_EARNED = 100000; // cửa sổ "tài khoản còn mới" + mốc tính BẠN CHĂM (tier 1)
// 3 mốc thưởng cho người mời theo tổng đào tích lũy của TỪNG người được mời
// (làm lại 2026-11-24, thay mốc đơn 100.000 cũ): trả dần khi bạn càng chăm.
const REFERRAL_TIERS = [
  { earned: 100000, gold: 15000, gems: 250 },
  { earned: 500000, gold: 30000, gems: 500 },
  { earned: 2000000, gold: 60000, gems: 1000 },
];
// Mốc theo SỐ BẠN CHĂM (bạn đã đào tích lũy >= 100.000) — server tự trả và ghi
// vào milestonesPaid của người mời, chống farm nick rác (nick không chơi = 0 thưởng).
const REF_ACTIVE_MILESTONES = [
  { count: 1, gold: 10000, gems: 200 },
  { count: 3, gold: 40000, gems: 600 },
  { count: 5, gold: 100000, gems: 1200 },
  { count: 10, gold: 250000, gems: 3000 },
];
const BANKS = ['MB Bank', 'Vietcombank', 'Techcombank', 'ACB', 'BIDV', 'MoMo'];

// Thợ/máy thuê đào tự động (giá vàng, cộng vàng/giây), giá tăng 15% mỗi con đã có
const MINERS = [
  { id: 'tap_su',   name: 'Thợ Mỏ Tập Sự',   baseCost: 150,     gps: 0.0625 },
  { id: 'lanh_nghe', name: 'Thợ Mỏ Lành Nghề', baseCost: 1200,  gps: 0.3125 },
  { id: 'doi_dao',  name: 'Đội Đào Vàng',    baseCost: 8000,    gps: 1.375 },
  { id: 'may_khoan', name: 'Máy Khoan Đá',   baseCost: 45000,   gps: 7.5 },
  { id: 'may_xuc',  name: 'Máy Xúc Vàng',    baseCost: 260000,  gps: 40.625 },
  { id: 'gian_khoan', name: 'Giàn Khoan Vàng', baseCost: 1500000, gps: 200 },
];

/* ---------------- Bot Telegram: tin chào khi người chơi bấm /start ----------------
 * Biến môi trường:
 *  - BOT_TOKEN: token của @ThoMoVang_bot (chủ game tự đặt trên Render; KHÔNG ghi
 *    token vào code hay log). Không có BOT_TOKEN -> bot tắt, game chạy bình thường.
 *  - GAME_URL: địa chỉ public của game (Render tự cấp RENDER_EXTERNAL_URL; mặc
 *    định là bản live tho-mo-vang.onrender.com).
 *  - TELEGRAM_API_BASE: chỉ để test local với mock server (mặc định api.telegram.org).
 * Lúc khởi động, có BOT_TOKEN thì server tự gọi setWebhook trỏ về
 * /api/telegram-webhook của chính nó, kèm secret_token = sha256(BOT_TOKEN);
 * các update Telegram gửi tới được xác thực qua header
 * x-telegram-bot-api-secret-token.
 */
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const GAME_URL = (process.env.GAME_URL || process.env.RENDER_EXTERNAL_URL || 'https://tho-mo-vang.onrender.com').replace(/\/+$/, '');
const TELEGRAM_API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const WEBHOOK_SECRET = BOT_TOKEN ? crypto.createHash('sha256').update(BOT_TOKEN).digest('hex') : '';
const WELCOME_TEXT = [
  '👋 Chào mừng đến với Thợ Mỏ Vàng!',
  '',
  'Hãy bắt đầu nâng cấp thợ mỏ, gom vàng đổi kim cương và rút tiền thẳng về ngân hàng. Nâng cấp cấp độ thợ mỏ để tăng tốc độ đào và nhận nhiều phần thưởng hơn.',
  '',
  '⛏️ Chúc bạn đào được thật nhiều vàng!',
].join('\n');

async function telegramApi(method, payload) {
  const r = await fetch(TELEGRAM_API_BASE + '/bot' + BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({}));
}

async function sendWelcome(chatId, startPayload) {
  const gameUrl = startPayload ? GAME_URL + '/?startapp=' + encodeURIComponent(startPayload) : GAME_URL;
  const replyMarkup = {
    inline_keyboard: [
      [{ text: '⛏ Chơi Game', web_app: { url: gameUrl } }],
      [{ text: '📣 Kênh nhận mã quà', url: 'https://t.me/ThoMoVangOfficial' }],
    ],
  };
  // Gửi kèm ảnh banner (file banner-welcome.jpg nằm trong public/ của chính
  // server này, Telegram tự tải qua URL) + nội dung chào làm caption. Nếu gửi
  // ảnh lỗi (Telegram không tải được ảnh...) thì lùi về gửi tin chữ như cũ để
  // người chơi luôn nhận được lời chào.
  const photo = await telegramApi('sendPhoto', {
    chat_id: chatId,
    photo: GAME_URL + '/banner-welcome.jpg',
    caption: WELCOME_TEXT,
    reply_markup: replyMarkup,
  });
  if (photo && photo.ok) return;
  await telegramApi('sendMessage', {
    chat_id: chatId,
    text: WELCOME_TEXT,
    reply_markup: replyMarkup,
  });
}

async function registerTelegramWebhook() {
  if (!BOT_TOKEN) return;
  try {
    const j = await telegramApi('setWebhook', {
      url: GAME_URL + '/api/telegram-webhook',
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message'],
      drop_pending_updates: false,
    });
    console.log(j && j.ok ? 'Telegram webhook: đã đăng ký' : 'Telegram webhook: đăng ký thất bại - ' + ((j && j.description) || 'không rõ lý do'));
  } catch (e) {
    console.error('Telegram webhook: lỗi khi đăng ký:', e.message);
  }
}

/* ---------------- Lưu trữ ----------------
 * Hai backend, chọn theo biến môi trường:
 *  - Có DATABASE_URL  -> Neon Postgres qua HTTP API (giao thức của Neon serverless driver):
 *      POST https://<host trong connection string>/sql
 *      Header: Neon-Connection-String: <DATABASE_URL đầy đủ>, Content-Type: application/json
 *      Body:   {"query": "...", "params": [...]}   (tham số dạng $1, $2...)
 *      Đáp:    {"fields": [...], "rows": [[...], ...], "rowCount": n, "command": "..."}
 *    Toàn bộ state nằm ở 1 dòng id=1 của bảng game_state (cột data JSONB),
 *    đúng cấu trúc của data.json trước đây.
 *    Biến phụ NEON_HTTP_BASE (chỉ để test local với mock server, KHÔNG cần khi dùng
 *    Neon thật): ghi đè địa chỉ gốc, ví dụ NEON_HTTP_BASE=http://localhost:4517
 *    thì câu SQL được POST tới http://localhost:4517/sql.
 *  - Không có DATABASE_URL -> file data.json như cũ (chạy local).
 */
const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_NEON = !!DATABASE_URL;
let NEON_SQL_URL = null;
if (USE_NEON) {
  if (process.env.NEON_HTTP_BASE) {
    NEON_SQL_URL = process.env.NEON_HTTP_BASE.replace(/\/+$/, '') + '/sql';
  } else {
    // Trích host từ connection string (kèm cổng nếu có), giữ nguyên cả host dạng -pooler
    NEON_SQL_URL = 'https://' + new URL(DATABASE_URL).host + '/sql';
  }
}

function emptyData() {
  return { players: {}, giftCodes: {}, redemptions: {}, withdrawals: [] };
}
function isValidData(d) {
  return !!d && !!d.players && !!d.giftCodes && !!d.redemptions && Array.isArray(d.withdrawals);
}
function loadDataFromFile() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return isValidData(d) ? d : emptyData();
  } catch (_) {
    return emptyData();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Gửi 1 câu SQL tới Neon HTTP API; thử lại tối đa 3 lần khi lỗi mạng/5xx (Neon khuyến nghị retry).
async function neonQuery(query, params) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(NEON_SQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Neon-Connection-String': DATABASE_URL,
        },
        body: JSON.stringify({ query, params: params || [] }),
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* giữ null */ }
      if (!resp.ok) {
        const msg = (json && (json.message || json.error)) || ('Neon HTTP ' + resp.status);
        const err = new Error(msg);
        err.status = resp.status;
        throw err;
      }
      return json;
    } catch (e) {
      lastErr = e;
      // Lỗi 4xx (sai SQL/tham số) thì không thử lại; lỗi mạng/5xx thì thử lại
      if (e.status && e.status >= 400 && e.status < 500) break;
      if (attempt < 2) await sleep(250 * (attempt + 1));
    }
  }
  throw lastErr;
}

let data = emptyData();
// Hàng đợi ghi Neon: các lần ghi chạy nối tiếp nhau, không ghi chồng.
// Mỗi lần ghi chụp toàn bộ state tại thời điểm ghi thực tế nên luôn lưu bản mới nhất.
let writeChain = Promise.resolve();
function persist() {
  if (!USE_NEON) {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
    return Promise.resolve();
  }
  const p = writeChain.then(async () => {
    const snapshot = JSON.stringify(data);
    await neonQuery(
      'INSERT INTO game_state (id, data, updated_at) VALUES (1, $1::jsonb, now()) ' +
      'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
      [snapshot]
    );
  });
  // Giữ chuỗi không bị gãy khi 1 lần ghi lỗi; lỗi vẫn được báo cho lần ghi đang chờ (p)
  writeChain = p.catch(() => {});
  return p;
}

async function initStorage() {
  if (USE_NEON) {
    await neonQuery(
      'CREATE TABLE IF NOT EXISTS game_state (id INT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ DEFAULT now())'
    );
    const r = await neonQuery('SELECT data FROM game_state WHERE id = 1');
    const row = r && Array.isArray(r.rows) ? r.rows[0] : null;
    if (row) {
      let v = Array.isArray(row) ? row[0] : row.data;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
      if (isValidData(v)) data = v;
    }
    console.log('storage: neon');
  } else {
    data = loadDataFromFile();
    console.log('storage: file');
  }
}

/* ---------------- Logic game phía server ---------------- */
function minerCost(type, owned) {
  return Math.floor(type.baseCost * Math.pow(1.15, owned));
}
function gpsOf(save) {
  let gps = BASE_RATE + RATE_PER_LEVEL * (save.minerLevel || 1);
  for (const m of MINERS) {
    const n = (save.miners && save.miners[m.id]) || 0;
    gps += m.gps * n;
  }
  return gps;
}
/* ---- Vá chống gian lận 2026-11-24: kiểm chứng việc MUA THỢ phía server ----
 * Giá thuê THẬT phía client (App.tsx MINERS, tăng x1.15 mỗi con đã có) — bảng
 * baseCost trong MINERS phía server là số cũ, không dùng cho kiểm tra này. */
const MINER_CHECK_PRICES = { tap_su: 45, lanh_nghe: 300, doi_dao: 3300, may_khoan: 36000, may_xuc: 390000, gian_khoan: 4200000 };
// Hai loại thợ chỉ có phía client (đóng gói trong extras __tmv): giá + gps hiện tại.
const EXTRA_MINERS = {
  robot: { baseCost: 60000000, gps: 1000 },
  mo_tu_dong: { baseCost: 990000000, gps: 5312.5 },
};
// Tổng giá hình học (không làm tròn từng con) để kiểm tra khả năng chi trả.
function seriesCost(base, from, to) {
  if (to <= from || base <= 0) return 0;
  return base * Math.pow(1.15, from) * (Math.pow(1.15, to - from) - 1) / 0.15;
}
// Giá đúng như client tính: ceil(base x 1.15^k) cho từng con thuê thêm.
function hireCostExact(base, from, to) {
  let t = 0;
  const n = Math.min(to, from + 5000);
  for (let k = from; k < n; k++) t += Math.ceil(base * Math.pow(1.15, k));
  if (to > n) t += Math.ceil(seriesCost(base, n, to));
  return t;
}
// Số lượng tối đa mua được trong ngân sách (nhị phân trên giá hình học).
function affordableCount(base, from, want, budget) {
  if (!Number.isFinite(want)) return from; // số khai khống kiểu 1e999 (Infinity) — bỏ qua, tránh vòng lặp vô hạn
  if (want <= from || seriesCost(base, from, want) <= budget) return want;
  let lo = from, hi = want;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (seriesCost(base, from, mid) <= budget) lo = mid; else hi = mid - 1;
  }
  return lo;
}
// Đọc extras (client đóng gói JSON trong tasks.progress.__tmv); null nếu hỏng.
function extrasOf(tasks) {
  try {
    const raw = tasks && tasks.progress && tasks.progress.__tmv;
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch { return null; }
}
// gps cộng thêm từ thợ client-only ĐÃ ĐƯỢC LƯU (đã qua kiểm chứng chi trả).
function extraGpsOf(extras) {
  if (!extras || !extras.ownedExtra) return 0;
  let g = 0;
  for (const [id, def] of Object.entries(EXTRA_MINERS)) {
    const n = Math.min(5, Math.max(0, Math.floor(extras.ownedExtra[id] || 0)));
    g += def.gps * n;
  }
  return g;
}
function makeReferralCode(playerId) {
  const h = crypto.createHash('sha256').update(playerId).digest('hex').slice(0, 6).toUpperCase();
  return 'TMV' + h;
}
function newSave(playerId, now) {
  return {
    playerId,
    gold: START_GOLD,
    gems: START_GEMS,
    minerLevel: 1,
    miners: {},
    tapPower: 6,
    sessionEnd: 0,          // mốc hết phiên đào (ms epoch); 0 = chưa mở phiên
    lastSeen: now,
    createdAt: now,
    referralCode: makeReferralCode(playerId),
    referredBy: null,
    refMilestoneDone: false, // (cũ) đã trả thưởng mốc 100.000 kiểu cũ chưa — giữ để di trú
    refTiersPaid: 0,          // số tier thưởng ref đã trả cho người giới thiệu nhờ player này (0..3)
    _burst: 15000,            // ngân sách chống gian lận còn lại (xem POST /api/save)
    _burstGems: 2000,         // ngân sách KC theo thời gian (vá 2026-11-24)
    friendsCount: 0,
    milestonesPaid: [],
    lastCheckin: null,      // 'YYYY-MM-DD'
    checkinStreak: 0,
    tasks: { date: null, progress: {}, claimed: [] },
    achievementsClaimed: [],
    totalEarned: 0,
    totalTaps: 0,
  };
}
function getOrCreatePlayer(playerId, now) {
  // Chỉ tạo trong bộ nhớ; handler gọi hàm này luôn `await persist()` sau khi xử lý xong
  if (!data.players[playerId]) {
    data.players[playerId] = newSave(playerId, now);
  }
  return data.players[playerId];
}
/* ---- Giới thiệu bạn bè: server là nguồn sự thật ---- */
// Số bạn bè THẬT của 1 người chơi = số player có referredBy là mình (đếm từ state,
// không tin con số friendsCount lưu sẵn — tránh số mô phỏng/farm từ bản cũ).
function friendsCountOf(playerId) {
  let n = 0;
  for (const p of Object.values(data.players)) if (p.referredBy === playerId) n++;
  return n;
}
// Số lượt một mã quà đã được nhập thành công (đếm trên toàn bộ người chơi).
function giftUsedCountOf(code) {
  let n = 0;
  for (const codes of Object.values(data.redemptions)) if (Array.isArray(codes) && codes.includes(code)) n++;
  return n;
}
// Mã giới thiệu của người đã mời player này (để client hiển thị), null nếu chưa có.
function referredByCodeOf(save) {
  if (!save.referredBy) return null;
  const inviter = data.players[save.referredBy];
  return inviter ? inviter.referralCode : null;
}
// Số tier thưởng ref đã trả cho người giới thiệu nhờ player này. Bản ghi cũ
// (chưa có refTiersPaid) đã nhận mốc 100.000 kiểu cũ (+18.000/+90) thì tính là
// đã qua tier 1 — không trả trùng khi lên cơ chế mới.
function refTiersPaidOf(save) {
  if (Number.isInteger(save.refTiersPaid)) return save.refTiersPaid;
  return save.refMilestoneDone ? 1 : 0;
}
// Số BẠN CHĂM của 1 người chơi = số người được mình mời đã đào tích lũy >= mốc.
function activeFriendsCountOf(playerId) {
  let n = 0;
  for (const p of Object.values(data.players)) {
    if (p.referredBy === playerId && (p.totalEarned || 0) >= REFERRAL_MILESTONE_EARNED) n++;
  }
  return n;
}
// Danh sách bạn bè đã mời kèm tiến độ đào (cho tab Bạn bè hiển thị động lực).
function refFriendsOf(playerId) {
  return Object.values(data.players)
    .filter((p) => p.referredBy === playerId)
    .map((p) => ({ code: p.referralCode, totalEarned: p.totalEarned || 0, tiersPaid: refTiersPaidOf(p) }))
    .sort((a, b) => b.totalEarned - a.totalEarned)
    .slice(0, 50);
}
// Gói thông tin ref trả kèm các đáp save cho client hiển thị.
function refInfoOf(save) {
  return {
    tiers: REFERRAL_TIERS,
    activeMilestones: REF_ACTIVE_MILESTONES,
    activeCount: activeFriendsCountOf(save.playerId),
    activePaid: Array.isArray(save.milestonesPaid) ? save.milestonesPaid : [],
    friends: refFriendsOf(save.playerId),
    inviteeReward: REFERRAL_REWARD,
    inviterReward: REFERRAL_INVITER_REWARD,
  };
}
// Trả thưởng MỐC SỐ BẠN CHĂM cho người mời (mỗi mốc đúng 1 lần, ghi milestonesPaid).
function payRefActiveMilestonesIfDue(inviter) {
  if (!Array.isArray(inviter.milestonesPaid)) inviter.milestonesPaid = [];
  const active = activeFriendsCountOf(inviter.playerId);
  let changed = false;
  for (const m of REF_ACTIVE_MILESTONES) {
    if (active >= m.count && !inviter.milestonesPaid.includes(m.count)) {
      inviter.gold += m.gold;
      inviter.gems += m.gems;
      inviter.milestonesPaid.push(m.count);
      changed = true;
    }
  }
  return changed;
}
// Trả các tier thưởng cho người giới thiệu theo tổng đào tích lũy của người
// được mời (3 tier leo thang). Người giới thiệu offline vẫn được cộng thẳng
// vào bản ghi của họ, lần sau mở game sẽ thấy.
function payRefTiersIfDue(save) {
  if (!save.referredBy) return false;
  let paid = refTiersPaidOf(save);
  if (paid >= REFERRAL_TIERS.length) { save.refTiersPaid = paid; save.refMilestoneDone = true; return false; }
  if ((save.totalEarned || 0) < REFERRAL_TIERS[paid].earned) { save.refTiersPaid = paid; return false; }
  const inviter = data.players[save.referredBy];
  if (!inviter || inviter.playerId === save.playerId) return false;
  let changed = false;
  while (paid < REFERRAL_TIERS.length && (save.totalEarned || 0) >= REFERRAL_TIERS[paid].earned) {
    inviter.gold += REFERRAL_TIERS[paid].gold;
    inviter.gems += REFERRAL_TIERS[paid].gems;
    paid++;
    changed = true;
  }
  save.refTiersPaid = paid;
  save.refMilestoneDone = paid >= 1;
  if (changed) {
    inviter.friendsCount = friendsCountOf(inviter.playerId);
    payRefActiveMilestonesIfDue(inviter);
  }
  return changed;
}
/* ---- Rút tiền: chuẩn hoá bản ghi khi trả ra API ----
 * Đơn cũ lưu status "Chờ xử lý" (tiếng Việt) và account/name; đơn mới lưu status
 * mã 'pending' và thêm accountNumber/accountName/processedAt. Khi trả ra API
 * quy tất cả về một dạng thống nhất: status 'pending' | 'paid' | 'rejected',
 * accountNumber/accountName luôn có, processedAt null khi chưa xử lý. */
function withdrawalStatusOf(w) {
  if (w.status === 'paid' || w.status === 'rejected') return w.status;
  return 'pending'; // cả 'pending' (mới) lẫn 'Chờ xử lý' (cũ) đều là chưa xử lý
}
function publicWithdrawal(w) {
  return {
    id: w.id,
    playerId: w.playerId,
    method: w.method || 'bank',
    bank: w.bank,
    account: w.account,
    name: w.name,
    accountNumber: w.accountNumber || w.account || '',
    accountName: w.accountName || w.name || '',
    gold: w.gold,
    vnd: w.vnd,
    sanctioned: !!w.sanctioned, // true = đơn bị tịch thu khi reset tài khoản gian lận (không hoàn vàng)
    status: withdrawalStatusOf(w),
    createdAt: w.createdAt,
    processedAt: w.processedAt || null,
  };
}

// Tính vàng offline: chỉ trong thời gian phiên còn hiệu lực, tối đa 6 giờ, 25% tốc độ thường
function applyOffline(save, now) {
  const last = save.lastSeen || now;
  let seconds = Math.floor((now - last) / 1000);
  if (seconds <= 0) { save.lastSeen = now; return 0; }
  if (seconds > OFFLINE_CAP_SECONDS) seconds = OFFLINE_CAP_SECONDS;
  // phần thời gian offline nằm trong phiên đào còn hiệu lực
  let inSession = 0;
  if (save.sessionEnd && save.sessionEnd > last) {
    const sessionLeftAtLeave = Math.floor((save.sessionEnd - last) / 1000);
    inSession = Math.min(seconds, Math.max(0, sessionLeftAtLeave));
  }
  const earned = Math.floor(gpsOf(save) * inSession * OFFLINE_RATE);
  if (earned > 0) {
    save.gold += earned;
    save.totalEarned = (save.totalEarned || 0) + earned;
  }
  save.lastSeen = now;
  return earned;
}

/* ---------------- HTTP helpers ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', (c) => { chunks += c; if (chunks.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!chunks) return resolve({});
      try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function isOwner(req) {
  return !!OWNER_KEY && !!req.headers['x-owner-key'] && req.headers['x-owner-key'] === OWNER_KEY;
}
/* ---- Xác thực Telegram initData (vá bảo mật 2026-11-24) ----
 * Tài khoản tg_<id> phải chứng minh danh tính bằng initData do Telegram ký
 * (HMAC-SHA256, khoá dẫn xuất từ BOT_TOKEN). Thiếu lớp này, bất kỳ ai biết
 * ID Telegram của người khác cũng đọc/ghi được save của họ và tạo đơn rút
 * tiền hộ về tài khoản ngân hàng của mình. */
function telegramUserIdOf(initData) {
  if (!BOT_TOKEN || !initData || typeof initData !== 'string') return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const checkString = [...params.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => k + '=' + v)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
    const a = Buffer.from(computed);
    const b = Buffer.from(String(hash));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const user = JSON.parse(params.get('user') || 'null');
    return user && Number.isFinite(user.id) ? String(user.id) : null;
  } catch { return null; }
}
function requestAuthorizedFor(req, playerId) {
  if (!playerId.startsWith('tg_')) return true; // người chơi trình duyệt: id ngẫu nhiên không đoán được
  if (!BOT_TOKEN) return true; // bot chưa bật (môi trường dev) — chưa có người chơi Telegram thật
  const uid = telegramUserIdOf(req.headers['x-telegram-init-data']);
  return uid !== null && uid === playerId.slice(3);
}
/* ---- Giới hạn tần suất tối thiểu (vá bảo mật 2026-11-24) ---- */
const rateBuckets = new Map();
function rateLimited(key, limit, windowMs) {
  const t = Date.now();
  const arr = (rateBuckets.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t);
  rateBuckets.set(key, arr);
  if (rateBuckets.size > 5000) rateBuckets.clear();
  return arr.length > limit;
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

/* ---------------- Server ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const now = Date.now();

  try {
    /* ---- GET /api/save?playerId= ---- */
    if (req.method === 'GET' && url.pathname === '/api/save') {
      const playerId = url.searchParams.get('playerId');
      if (!playerId) return sendJson(res, 400, { error: 'Thiếu playerId' });
      if (!requestAuthorizedFor(req, String(playerId))) {
        return sendJson(res, 401, { error: 'Không xác thực được người chơi Telegram — hãy mở lại game trong Telegram' });
      }
      const save = getOrCreatePlayer(String(playerId), now);
      const offlineEarned = applyOffline(save, now);
      payRefTiersIfDue(save); // vàng offline cũng tính vào tổng đào tích lũy
      payRefActiveMilestonesIfDue(save);
      save.friendsCount = friendsCountOf(save.playerId);
      // Client nhận đúng số dư này khi tải game -> mốc báo cáo của client = server
      save._clientGold = save.gold;
      save._clientGems = save.gems;
      await persist();
      return sendJson(res, 200, { save, offlineEarned, miners: MINERS, refInfo: refInfoOf(save), referredByCode: referredByCodeOf(save) });
    }

    /* ---- POST /api/save ---- */
    if (req.method === 'POST' && url.pathname === '/api/save') {
      const body = await readBody(req);
      const playerId = body.playerId;
      if (!playerId) return sendJson(res, 400, { error: 'Thiếu playerId' });
      if (!requestAuthorizedFor(req, String(playerId))) {
        return sendJson(res, 401, { error: 'Không xác thực được người chơi Telegram — hãy mở lại game trong Telegram' });
      }
      if (rateLimited('save:' + String(playerId), 90, 30000)) {
        return sendJson(res, 429, { error: 'Thao tác quá nhanh, thử lại sau ít giây' });
      }
      const save = getOrCreatePlayer(String(playerId), now);
      const inc = body.save || {};

      // Kiểm tra hợp lý: mọi số phải hữu hạn và không âm
      const numFields = ['gold', 'gems', 'minerLevel', 'tapPower', 'totalEarned', 'totalTaps', 'friendsCount', 'checkinStreak'];
      for (const f of numFields) {
        if (inc[f] !== undefined && (!Number.isFinite(inc[f]) || inc[f] < 0)) {
          return sendJson(res, 400, { error: 'Số liệu không hợp lệ: ' + f });
        }
      }
      // ---- Chống gian lận (vá 2026-11-24) ----
      // Hạn mức kiếm vàng theo THỜI GIAN THẬT qua "ngân sách" _burst: nạp lại
      // theo (gps server tự tính x2 + chạm đào) x số giây từ lần lưu trước,
      // trần 600.000 để các khoản nhận một lần hợp lệ (điểm danh theo gps,
      // nhiệm vụ, rương quảng cáo) không bị chặn nhầm. Bản vá này thay đệm cố
      // định +200.000/lần lưu trước đây — script gửi save liên tục từng bơm
      // vàng nằm trong khoản đệm đó. Vàng server tự cộng (offline, ref, mã
      // quà, hoàn rút tiền) không đi qua hạn mức này.
      const dtSec = Math.max(1, (now - (save._lastSync || save.lastSeen || now)) / 1000);
      const maxGemsGain = 20000;
      const storedExtras = extrasOf(save.tasks);
      const incExtras = extrasOf(inc.tasks);
      let clickLevel = 1;
      const clRaw = (incExtras && incExtras.clickLevel) || (storedExtras && storedExtras.clickLevel);
      if (Number.isFinite(clRaw)) clickLevel = Math.min(500, Math.max(1, Math.floor(clRaw)));
      const refill = ((gpsOf(save) + extraGpsOf(storedExtras)) * 2 + Math.max(10, clickLevel * 10)) * dtSec;
      if (!Number.isFinite(save._burst)) save._burst = 100000;
      const allowance = Math.min(600000, save._burst + refill);
      // Số thợ tăng lên phải TRẢ ĐỦ TIỀN: tổng giá các thợ mới (tính theo giá
      // thật phía client) phải nằm trong khả năng chi trả = số dư server +
      // hạn mức kỳ này; khai khống bị cắt bớt số lượng ngay tại server, và giá
      // trị phần thuê được trừ vào hạn mức tăng vàng của kỳ (hireCost).
      const hasMinerReport = inc.miners && typeof inc.miners === 'object';
      const claimedMiners = {};
      if (hasMinerReport) {
        for (const m of MINERS) {
          const n = inc.miners[m.id];
          if (Number.isInteger(n) && n >= 0) claimedMiners[m.id] = n;
        }
      }
      let hireCost = 0;
      let budget = save.gold + allowance;
      if (hasMinerReport) {
        for (const m of MINERS) {
          const old = (save.miners && save.miners[m.id]) || 0;
          const want0 = claimedMiners[m.id] || 0;
          if (want0 > old) {
            const want = affordableCount(MINER_CHECK_PRICES[m.id], old, want0, budget);
            claimedMiners[m.id] = want;
            const c = hireCostExact(MINER_CHECK_PRICES[m.id], old, want);
            hireCost += c;
            budget -= c;
          }
        }
      }
      // Tương tự với 2 thợ client-only trong extras (robot / mỏ tự động AI):
      // cắt khai khống theo cùng ngân sách và ghi extras đã cắt trở lại save.
      if (incExtras && incExtras.ownedExtra && typeof incExtras.ownedExtra === 'object') {
        let extrasDirty = false;
        for (const [id, def] of Object.entries(EXTRA_MINERS)) {
          const oldRaw = Number(storedExtras && storedExtras.ownedExtra && storedExtras.ownedExtra[id]);
          const old = Number.isFinite(oldRaw) ? Math.min(1000, Math.max(0, Math.floor(oldRaw))) : 0;
          const wantRaw = Number(incExtras.ownedExtra[id]);
          const want0 = Number.isFinite(wantRaw) ? Math.min(1000, Math.max(0, Math.floor(wantRaw))) : old;
          if (want0 > old) {
            const want = affordableCount(def.baseCost, old, want0, budget);
            if (want !== want0) { incExtras.ownedExtra[id] = want; extrasDirty = true; }
            const c = hireCostExact(def.baseCost, old, want);
            hireCost += c;
            budget -= c;
          }
        }
        if (extrasDirty && inc.tasks && inc.tasks.progress) {
          inc.tasks.progress.__tmv = JSON.stringify(incExtras);
        }
      }
      // Vàng/KC gộp theo DELTA thay vì ghi đè tuyệt đối: các khoản server tự cộng
      // (thưởng giới thiệu/mốc bạn bè, đổi mã quà...) nằm trong số dư server nhưng
      // client chưa biết — ghi đè tuyệt đối sẽ xoá mất chúng ở lần save sau.
      // Mốc tính delta do CLIENT gửi kèm (baseGold/baseGems = số dư server gần
      // nhất client đã nhận): delta khi đó chỉ gồm phần client tự kiếm/tiêu kể từ
      // mốc của chính nó, nên save cũ đến trễ sau một khoản server cộng cũng không
      // xoá được khoản cộng đó, bất kể thứ tự xử lý. Thiếu mốc (bundle cũ) thì
      // dùng _clientGold phía server làm mốc dự phòng.
      if (inc.gold !== undefined) {
        const base = Number.isFinite(inc.baseGold) ? inc.baseGold
          : (Number.isFinite(save._clientGold) ? save._clientGold : save.gold);
        let delta = inc.gold - base;
        const cap = allowance - hireCost;
        if (delta > cap) delta = Math.floor(cap);
        save.gold = Math.max(0, Math.floor(save.gold + delta));
        save._clientGold = save.gold;
        save._burst = Math.max(0, allowance - Math.max(0, delta + hireCost));
      } else {
        save._burst = allowance;
      }
      // KC tăng cũng theo NGÂN SÁCH THỜI GIAN như vàng (vá 2026-11-24): trần
      // cũ +20.000/lần lưu không gắn thời gian nên script gửi save liên tục
      // bơm KC không giới hạn. Nguồn KC hợp lệ phía client rất chậm (quảng
      // cáo +120/lượt xem, điểm danh +5/ngày) nên nạp 30 + 5/giây, trần
      // 20.000 là rộng rãi cho người chơi thật.
      if (!Number.isFinite(save._burstGems)) save._burstGems = 2000;
      const gemsAllowance = Math.min(maxGemsGain, save._burstGems + 30 + dtSec * 5);
      let rawGemsDelta = 0;
      if (inc.gems !== undefined) {
        const base = Number.isFinite(inc.baseGems) ? inc.baseGems
          : (Number.isFinite(save._clientGems) ? save._clientGems : save.gems);
        rawGemsDelta = inc.gems - base;
        let delta = rawGemsDelta;
        if (delta > gemsAllowance) delta = Math.floor(gemsAllowance);
        save.gems = Math.max(0, Math.floor(save.gems + delta));
        save._clientGems = save.gems;
        save._burstGems = Math.max(0, gemsAllowance - Math.max(0, delta));
      } else {
        save._burstGems = gemsAllowance;
      }
      // Cấp thợ: server chỉ công nhận số cấp mà khoản KC ĐÃ TRỪ trong cùng
      // lần lưu này trả đủ (5.000 KC/cấp) — trước đây client tự khai cấp,
      // gps phía server phồng theo cấp khống, làm vỡ trần chống gian lận và
      // vàng offline (vá 2026-11-24). Giảm cấp thì tự do (vô hại).
      if (Number.isFinite(inc.minerLevel)) {
        const want = Math.floor(inc.minerLevel);
        const cur = save.minerLevel || 1;
        if (want <= cur) {
          save.minerLevel = Math.max(1, want);
        } else {
          const paidLevels = Math.floor(Math.max(0, -rawGemsDelta) / UPGRADE_COST_GEMS);
          save.minerLevel = Math.min(cur + paidLevels, 10000);
        }
      }

      const keep = ['tapPower', 'totalTaps',
        'lastCheckin', 'checkinStreak', 'tasks', 'achievementsClaimed'];
      for (const f of keep) if (inc[f] !== undefined) save[f] = inc[f];
      if (Number.isFinite(inc.totalEarned)) {
        // Tổng đào tích lũy là căn cứ trả thưởng ref cho người giới thiệu —
        // không cho tăng nhanh hơn khả năng kiếm thật của kỳ này, tránh tự
        // khai 2.000.000 để người mời lĩnh đủ 3 tier + mốc bạn chăm.
        const capEarned = (save.totalEarned || 0) + allowance;
        save.totalEarned = Math.max(save.totalEarned || 0, Math.min(inc.totalEarned, capEarned));
      }
      if (hasMinerReport) save.miners = claimedMiners;
      if (Number.isFinite(inc.sessionEnd) && inc.sessionEnd >= 0) {
        // phiên tối đa 4 giờ kể từ hiện tại (cộng thêm độ trễ nhỏ)
        save.sessionEnd = Math.min(inc.sessionEnd, now + SESSION_SECONDS * 1000 + 60000);
      }
      payRefTiersIfDue(save);
      payRefActiveMilestonesIfDue(save);
      save.friendsCount = friendsCountOf(save.playerId);
      save._lastSync = now;
      save.lastSeen = now;
      await persist();
      return sendJson(res, 200, { save, refInfo: refInfoOf(save), referredByCode: referredByCodeOf(save) });
    }

    /* ---- POST /api/exchange {playerId, goldAmount} : vàng -> KC, 125:1, một chiều ---- */
    if (req.method === 'POST' && url.pathname === '/api/exchange') {
      const body = await readBody(req);
      if (body.playerId && !requestAuthorizedFor(req, String(body.playerId))) {
        return sendJson(res, 401, { error: 'Không xác thực được người chơi Telegram — hãy mở lại game trong Telegram' });
      }
      const save = body.playerId ? getOrCreatePlayer(String(body.playerId), now) : null;
      if (!save) return sendJson(res, 400, { error: 'Thiếu playerId' });
      const goldAmount = Math.floor(body.goldAmount);
      if (!Number.isFinite(goldAmount) || goldAmount < EXCHANGE_RATE) {
        return sendJson(res, 400, { error: 'Cần ít nhất ' + EXCHANGE_RATE + ' vàng để đổi 1 kim cương' });
      }
      const gems = Math.floor(goldAmount / EXCHANGE_RATE);
      const cost = gems * EXCHANGE_RATE;
      if (save.gold < cost) return sendJson(res, 400, { error: 'Không đủ vàng để đổi' });
      save.gold -= cost;
      save.gems += gems;
      save._clientGold = save.gold; save._clientGems = save.gems; // client nhận số dư này trong đáp
      save._lastSync = now; save.lastSeen = now;
      await persist();
      return sendJson(res, 200, { save, exchanged: { gold: cost, gems } });
    }

    /* ---- POST /api/redeem {playerId, code} ---- */
    if (req.method === 'POST' && url.pathname === '/api/redeem') {
      const body = await readBody(req);
      if (!body.playerId) return sendJson(res, 400, { error: 'Thiếu playerId' });
      if (!requestAuthorizedFor(req, String(body.playerId))) {
        return sendJson(res, 401, { error: 'Không xác thực được người chơi Telegram — hãy mở lại game trong Telegram' });
      }
      if (rateLimited('redeem:' + clientIp(req), 15, 60000)) {
        return sendJson(res, 429, { error: 'Nhập mã quá nhanh, thử lại sau ít phút' });
      }
      const save = getOrCreatePlayer(String(body.playerId), now);
      const code = String(body.code || '').trim().toUpperCase();
      const gift = data.giftCodes[code];
      if (!gift) return sendJson(res, 404, { error: 'Mã quà tặng không tồn tại' });
      const used = data.redemptions[save.playerId] || [];
      if (used.includes(code)) return sendJson(res, 400, { error: 'Bạn đã dùng mã này rồi (mỗi mã chỉ dùng 1 lần)' });
      // Giới hạn tổng số lượt nhập (maxUses = null -> không giới hạn; mã cũ không
      // có trường này cũng là không giới hạn). Kiểm tra và ghi nhận diễn ra đồng
      // bộ trong cùng một lần xử lý nên 2 người nhập đồng thời không vượt giới hạn.
      const maxUses = gift.maxUses == null ? null : gift.maxUses;
      if (maxUses != null && giftUsedCountOf(code) >= maxUses) {
        return sendJson(res, 400, { error: 'Mã quà đã hết lượt nhập rồi' });
      }
      used.push(code);
      data.redemptions[save.playerId] = used;
      save.gold += gift.gold || 0;
      save.gems += gift.gems || 0;
      save._clientGold = save.gold; save._clientGems = save.gems; // client nhận số dư này trong đáp
      save._lastSync = now; save.lastSeen = now;
      await persist();
      return sendJson(res, 200, { save, reward: { gold: gift.gold || 0, gems: gift.gems || 0 } });
    }

    /* ---- POST /api/giftcodes (owner) / GET /api/giftcodes (owner) ---- */
    if (url.pathname === '/api/giftcodes') {
      if (rateLimited('owner:' + clientIp(req), 60, 60000)) {
        return sendJson(res, 429, { error: 'Thao tác quá nhanh, thử lại sau ít phút' });
      }
      if (!isOwner(req)) return sendJson(res, 401, { error: 'Sai mã chủ game (header x-owner-key)' });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const code = String(body.code || '').trim().toUpperCase();
        if (!code) return sendJson(res, 400, { error: 'Thiếu mã code' });
        const gold = Math.max(0, Math.floor(body.gold || 0));
        const gems = Math.max(0, Math.floor(body.gems || 0));
        // maxUses tuỳ chọn: không gửi / null / rỗng -> null (không giới hạn).
        let maxUses = null;
        if (body.maxUses !== undefined && body.maxUses !== null && body.maxUses !== '') {
          const n = Number(body.maxUses);
          if (!Number.isInteger(n) || n < 1 || n > 1000000) {
            return sendJson(res, 400, { error: 'Số lượt nhập tối đa phải là số nguyên từ 1 đến 1.000.000 (hoặc để trống nếu không giới hạn)' });
          }
          maxUses = n;
        }
        data.giftCodes[code] = { gold, gems, createdAt: now, maxUses };
        await persist();
        return sendJson(res, 200, { ok: true, code, gold, gems, maxUses });
      }
      if (req.method === 'GET') {
        const giftCodes = {};
        for (const [code, g] of Object.entries(data.giftCodes)) {
          giftCodes[code] = {
            gold: g.gold || 0,
            gems: g.gems || 0,
            createdAt: g.createdAt || 0,
            maxUses: g.maxUses == null ? null : g.maxUses,
            usedCount: giftUsedCountOf(code),
          };
        }
        return sendJson(res, 200, { giftCodes });
      }
    }

    /* ---- POST /api/withdraw ---- */
    if (req.method === 'POST' && url.pathname === '/api/withdraw') {
      const body = await readBody(req);
      if (!body.playerId) return sendJson(res, 400, { error: 'Thiếu playerId' });
      if (!requestAuthorizedFor(req, String(body.playerId))) {
        return sendJson(res, 401, { error: 'Không xác thực được người chơi Telegram — hãy mở lại game trong Telegram' });
      }
      const save = getOrCreatePlayer(String(body.playerId), now);
      const gold = Math.floor(body.gold);
      const method = String(body.method || '');
      const bank = String(body.bank || '');
      const account = String(body.account || '').trim();
      const name = String(body.name || '').trim();
      if (!Number.isFinite(gold) || gold < WITHDRAW_MIN_GOLD) {
        return sendJson(res, 400, { error: 'Số vàng rút tối thiểu là ' + WITHDRAW_MIN_GOLD.toLocaleString('vi-VN') + ' vàng' });
      }
      if (!BANKS.includes(bank) && method !== 'momo') return sendJson(res, 400, { error: 'Ngân hàng/ví không hợp lệ' });
      if (!account || !name) return sendJson(res, 400, { error: 'Thiếu số tài khoản hoặc tên người nhận' });
      if (save.gold < gold) return sendJson(res, 400, { error: 'Không đủ vàng để rút' });
      save.gold -= gold;
      const wd = {
        id: crypto.randomBytes(6).toString('hex'),
        playerId: save.playerId,
        method: method || 'bank',
        bank, account, name,
        accountNumber: account, accountName: name,
        gold,
        vnd: Math.floor(gold * WITHDRAW_RATE),
        status: 'pending',
        createdAt: now,
        processedAt: null,
      };
      data.withdrawals.push(wd);
      save._clientGold = save.gold; save._clientGems = save.gems; // client nhận số dư này trong đáp
      save._lastSync = now; save.lastSeen = now;
      await persist();
      return sendJson(res, 200, { save, withdrawal: publicWithdrawal(wd) });
    }

    /* ---- GET /api/withdrawals : của 1 người chơi, hoặc tất cả nếu là owner ---- */
    if (req.method === 'GET' && url.pathname === '/api/withdrawals') {
      if (isOwner(req)) {
        // Chủ game: toàn bộ đơn, mới nhất trước, đủ trường để hiển thị + đối soát
        const all = data.withdrawals.map(publicWithdrawal).sort((a, b) => b.createdAt - a.createdAt);
        return sendJson(res, 200, { withdrawals: all });
      }
      const playerId = url.searchParams.get('playerId');
      // Không có playerId nghĩa là đang đòi xem TOÀN BỘ đơn — việc đó chỉ dành
      // cho chủ game (đã xử lý ở nhánh owner phía trên) nên trả 401.
      if (!playerId) return sendJson(res, 401, { error: 'Thiếu playerId (xem toàn bộ đơn cần mã chủ game)' });
      if (!requestAuthorizedFor(req, String(playerId))) {
        return sendJson(res, 401, { error: 'Không xác thực được người chơi Telegram — hãy mở lại game trong Telegram' });
      }
      return sendJson(res, 200, { withdrawals: data.withdrawals.filter((w) => w.playerId === String(playerId)).map(publicWithdrawal) });
    }

    /* ---- POST /api/withdrawals/update (owner) {id, action: "paid" | "rejected"} ----
     * Chủ game xử lý đơn rút: "paid" = đã chuyển khoản xong; "rejected" = từ chối
     * và HOÀN LẠI đúng số vàng của đơn vào số dư người chơi. Chỉ xử lý được đơn
     * đang chờ (pending); đơn đã xử lý rồi thì báo lỗi rõ ràng. */
    if (req.method === 'POST' && url.pathname === '/api/withdrawals/update') {
      if (rateLimited('owner:' + clientIp(req), 60, 60000)) {
        return sendJson(res, 429, { error: 'Thao tác quá nhanh, thử lại sau ít phút' });
      }
      if (!isOwner(req)) return sendJson(res, 401, { error: 'Sai mã chủ game (header x-owner-key)' });
      const body = await readBody(req);
      const id = String(body.id || '');
      const action = String(body.action || '');
      if (action !== 'paid' && action !== 'rejected') {
        return sendJson(res, 400, { error: 'Hành động không hợp lệ (chỉ "paid" hoặc "rejected")' });
      }
      const wd = data.withdrawals.find((w) => String(w.id) === id);
      if (!wd) return sendJson(res, 404, { error: 'Không tìm thấy đơn rút tiền' });
      if (withdrawalStatusOf(wd) !== 'pending') {
        return sendJson(res, 400, { error: 'Đơn này đã được xử lý rồi' });
      }
      wd.status = action;
      wd.processedAt = now;
      if (action === 'rejected') {
        // Cộng thẳng vào bản ghi server của người chơi. KHÔNG đụng _clientGold:
        // cơ chế gộp delta ở POST /api/save sẽ giữ khoản hoàn này cho họ kể cả
        // khi một save cũ của họ đến trễ sau lúc từ chối.
        const player = data.players[wd.playerId];
        if (player) player.gold += wd.gold;
      }
      await persist();
      return sendJson(res, 200, { ok: true, withdrawal: publicWithdrawal(wd) });
    }

    /* ---- POST /api/players/reset (owner) {playerId} ----
     * Xử lý tài khoản gian lận: TỊCH THU toàn bộ vàng/KC + đội thợ và đưa tài
     * khoản về trạng thái người chơi mới. Mọi đơn rút đang chờ của họ bị từ
     * chối KHÔNG hoàn vàng (khác nút "Từ chối" thường) và gắn cờ sanctioned
     * để phân biệt trong lịch sử. Bản ghi mới giữ playerId, mã giới thiệu,
     * người giới thiệu và ngày tạo gốc; lịch sử nhập mã quà được giữ nguyên
     * để họ không farm lại quà. Client cũ của họ không hồi được tài sản:
     * các save sau reset vẫn đi qua cơ chế delta + kiểm chứng mua thợ/cấp
     * với ngân sách của tài khoản mới (50.000 vàng). */
    if (req.method === 'POST' && url.pathname === '/api/players/reset') {
      if (rateLimited('owner:' + clientIp(req), 60, 60000)) {
        return sendJson(res, 429, { error: 'Thao tác quá nhanh, thử lại sau ít phút' });
      }
      if (!isOwner(req)) return sendJson(res, 401, { error: 'Sai mã chủ game (header x-owner-key)' });
      const body = await readBody(req);
      const pid = String(body.playerId || '');
      const old = data.players[pid];
      if (!old) return sendJson(res, 404, { error: 'Không tìm thấy người chơi này' });
      let pendingGold = 0;
      let pendingCount = 0;
      for (const w of data.withdrawals) {
        if (w.playerId === pid && withdrawalStatusOf(w) === 'pending') {
          w.status = 'rejected';
          w.sanctioned = true;
          w.processedAt = now;
          pendingGold += w.gold || 0;
          pendingCount++;
        }
      }
      const confiscated = { gold: (old.gold || 0) + pendingGold, gems: old.gems || 0, pendingCount };
      const fresh = newSave(pid, now);
      fresh.createdAt = old.createdAt || now;
      fresh.referredBy = old.referredBy || null;
      fresh.resets = (old.resets || 0) + 1;
      fresh.lastResetAt = now;
      data.players[pid] = fresh;
      await persist();
      return sendJson(res, 200, { ok: true, playerId: pid, confiscated, resets: fresh.resets });
    }

    /* ---- POST /api/referral {playerId, code} ----
     * Cơ chế giới thiệu THẬT do server kiểm tra (chống farm), làm lại 2026-11-24:
     * - Ghi nhận: mã phải tồn tại; không tự giới thiệu mình; mỗi người chỉ có 1 người
     *   giới thiệu; chỉ ghi nhận khi tài khoản còn "mới" (tổng đào tích lũy < 100.000).
     * - Ngay khi ghi nhận: người được mời +25.000 vàng/+500 KC, người mời +2.000/+50 KC.
     * - Người mời nhận thêm 3 tier leo thang theo tổng đào của người được mời
     *   (100.000 / 500.000 / 2.000.000 — xem payRefTiersIfDue) và các mốc SỐ BẠN
     *   CHĂM do server tự trả (xem payRefActiveMilestonesIfDue). */
    if (req.method === 'POST' && url.pathname === '/api/referral') {
      const body = await readBody(req);
      if (!body.playerId) return sendJson(res, 400, { error: 'Thiếu playerId' });
      if (!requestAuthorizedFor(req, String(body.playerId))) {
        return sendJson(res, 401, { error: 'Không xác thực được người chơi Telegram — hãy mở lại game trong Telegram' });
      }
      const me = getOrCreatePlayer(String(body.playerId), now);
      const code = String(body.code || '').trim().toUpperCase();
      if (!code) return sendJson(res, 400, { error: 'Hãy nhập mã giới thiệu của bạn bè' });
      if (me.referredBy) return sendJson(res, 400, { error: 'Bạn đã có người giới thiệu rồi' });
      if (code === me.referralCode) return sendJson(res, 400, { error: 'Không thể tự giới thiệu mình' });
      const inviter = Object.values(data.players).find((p) => p.referralCode === code);
      if (!inviter) return sendJson(res, 404, { error: 'Mã giới thiệu không tồn tại' });
      if ((me.totalEarned || 0) >= REFERRAL_MILESTONE_EARNED) {
        return sendJson(res, 400, { error: 'Tài khoản đã chơi lâu, không nhập mã giới thiệu được nữa' });
      }
      me.referredBy = inviter.playerId;
      me.refMilestoneDone = false;
      me.refTiersPaid = 0;
      me.gold += REFERRAL_REWARD.gold;
      me.gems += REFERRAL_REWARD.gems;
      inviter.gold += REFERRAL_INVITER_REWARD.gold;
      inviter.gems += REFERRAL_INVITER_REWARD.gems;
      inviter.friendsCount = friendsCountOf(inviter.playerId);
      // KHÔNG đụng _clientGold/_clientGems của người mời: client của họ chưa biết
      // khoản cộng này, cơ chế gộp delta ở POST /api/save sẽ giữ nó cho họ.
      me.friendsCount = friendsCountOf(me.playerId);
      payRefTiersIfDue(me);
      me._clientGold = me.gold; me._clientGems = me.gems; // người được mời nhận số dư này trong đáp
      me._lastSync = now; me.lastSeen = now;
      await persist();
      return sendJson(res, 200, {
        save: me,
        reward: REFERRAL_REWARD,
        inviterReward: REFERRAL_INVITER_REWARD,
        refInfo: refInfoOf(me),
        referredByCode: inviter.referralCode,
      });
    }

    /* ---- POST /api/telegram-webhook (Bot Telegram: chào khi /start) ---- */
    if (req.method === 'POST' && url.pathname === '/api/telegram-webhook') {
      if (!BOT_TOKEN) return sendJson(res, 404, { error: 'Bot chưa được bật' });
      if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
        return sendJson(res, 401, { error: 'Sai secret webhook' });
      }
      const update = await readBody(req);
      const msg = update && update.message;
      if (msg && msg.chat && msg.chat.type === 'private' && typeof msg.text === 'string' && msg.text.startsWith('/start')) {
        const payload = msg.text.slice('/start'.length).trim().split(/\s+/)[0] || '';
        try { await sendWelcome(msg.chat.id, payload); } catch (e) { console.error('Telegram sendMessage lỗi:', e.message); }
      }
      return sendJson(res, 200, { ok: true });
    }

    /* ---- File tĩnh ---- */
    if (req.method === 'GET') {
      let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
      filePath = path.normalize(path.join(PUBLIC_DIR, filePath));
      if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
      // Không phục vụ file nhạy cảm (mã nguồn server, dữ liệu, cấu hình, thư
      // mục ẩn) kể cả khi PUBLIC_DIR lùi về thư mục gốc của repo (vá 2026-11-24).
      const baseName = path.basename(filePath);
      if (baseName === 'server.js' || baseName === 'data.json' || baseName.startsWith('package') || baseName.startsWith('.') || filePath.includes(path.sep + '.')) {
        res.writeHead(404); return res.end('Not found');
      }
      fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
        // Chống cache cũ: trình duyệt luôn hỏi lại server (ETag) — file chưa đổi
        // thì trả 304 (rất nhẹ), file đã đổi (deploy mới) thì nhận ngay bản mới.
        const etag = 'W/"' + st.size + '-' + Math.floor(st.mtimeMs) + '"';
        if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
        fs.readFile(filePath, (err2, buf) => {
          if (err2) { res.writeHead(404); return res.end('Not found'); }
          res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'ETag': etag });
          res.end(buf);
        });
      });
      return;
    }

    return sendJson(res, 404, { error: 'Không tìm thấy' });
  } catch (e) {
    return sendJson(res, 500, { error: 'Lỗi server: ' + e.message });
  }
});

initStorage()
  .then(() => {
    server.listen(PORT, () => {
      console.log('Thợ Mỏ Vàng đang chạy tại http://localhost:' + PORT);
      registerTelegramWebhook();
    });
  })
  .catch((e) => {
    // Không in DATABASE_URL/mật khẩu ra log — chỉ in thông điệp lỗi
    console.error('Không khởi tạo được bộ lưu trữ, server không khởi động:', e.message);
    process.exit(1);
  });
