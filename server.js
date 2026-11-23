'use strict';
/*
 * Thợ Mỏ Vàng — server độc lập, KHÔNG dùng thư viện ngoài.
 * Chạy: node server.js   (cổng: process.env.PORT, mặc định 3000)
 * Dữ liệu: nếu có biến môi trường DATABASE_URL -> lưu vào Neon Postgres (bảng game_state,
 *   qua Neon HTTP API bằng fetch thuần) để không mất dữ liệu khi host miễn phí (Render Free)
 *   xoá filesystem lúc khởi động lại. Không có DATABASE_URL -> lưu file data.json cùng
 *   thư mục như trước (ghi an toàn: file tạm + rename).
 * Mã chủ game: biến môi trường OWNER_KEY (mặc định "thomovang123" — hãy đổi khi deploy thật).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const OWNER_KEY = process.env.OWNER_KEY || 'thomovang123';
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;

/* ---------------- Thông số game (đã chốt, không tự ý đổi) ---------------- */
const START_GOLD = 300000;          // quà tân thủ
const START_GEMS = 1500;            // quà tân thủ
const BASE_RATE = 5.8;              // Lv.1 = 5.8 + 0.2*1 = 6.0 vàng/giây
const RATE_PER_LEVEL = 0.2;
const UPGRADE_COST_GEMS = 5000;     // nâng cấp thợ: phẳng 5.000 KC/cấp (client hiển thị, trừ KC qua /api/save có kiểm tra)
const EXCHANGE_RATE = 125;          // 125 vàng = 1 kim cương (một chiều vàng -> KC)
const WITHDRAW_RATE = 0.0005;       // 1 vàng = 0,0005 VNĐ
const WITHDRAW_MIN_GOLD = 4000000;  // tối thiểu 4.000.000 vàng
const SESSION_SECONDS = 4 * 3600;   // phiên đào 4 giờ
const OFFLINE_CAP_SECONDS = 8 * 3600;
const OFFLINE_RATE = 0.25;          // offline = 25% tốc độ thường
const REFERRAL_REWARD = { gold: 20000, gems: 100 }; // quà NGAY cho người được mời khi ghi nhận ref
const REFERRAL_INVITER_REWARD = { gold: 2000, gems: 10 }; // quà NGAY cho người mời khi bạn mới ghi nhận ref
const REFERRAL_MILESTONE_EARNED = 100000; // mốc tổng đào tích lũy (totalEarned) của người được mời
const REFERRAL_MILESTONE_REWARD = { gold: 18000, gems: 90 }; // quà MỐC cho người mời, đúng 1 lần cho mỗi người được mời
const MILESTONES = [
  { count: 1, gold: 50000, gems: 200 },
  { count: 3, gold: 150000, gems: 500 },
  { count: 5, gold: 400000, gems: 1200 },
  { count: 10, gold: 1000000, gems: 3000 },
];
const BANKS = ['MB Bank', 'Vietcombank', 'Techcombank', 'ACB', 'BIDV', 'MoMo'];

// Thợ/máy thuê đào tự động (giá vàng, cộng vàng/giây), giá tăng 15% mỗi con đã có
const MINERS = [
  { id: 'tap_su',   name: 'Thợ Mỏ Tập Sự',   baseCost: 150,     gps: 1 },
  { id: 'lanh_nghe', name: 'Thợ Mỏ Lành Nghề', baseCost: 1200,  gps: 6 },
  { id: 'doi_dao',  name: 'Đội Đào Vàng',    baseCost: 8000,    gps: 25 },
  { id: 'may_khoan', name: 'Máy Khoan Đá',   baseCost: 45000,   gps: 110 },
  { id: 'may_xuc',  name: 'Máy Xúc Vàng',    baseCost: 260000,  gps: 520 },
  { id: 'gian_khoan', name: 'Giàn Khoan Vàng', baseCost: 1500000, gps: 2600 },
];

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
    refMilestoneDone: false, // đã trả thưởng mốc cho người giới thiệu nhờ player này chưa
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
// Mã giới thiệu của người đã mời player này (để client hiển thị), null nếu chưa có.
function referredByCodeOf(save) {
  if (!save.referredBy) return null;
  const inviter = data.players[save.referredBy];
  return inviter ? inviter.referralCode : null;
}
// Trả phần thưởng MỐC cho người giới thiệu khi người được mời đào tích lũy đủ mốc.
// Đúng 1 lần cho mỗi người được mời (cờ refMilestoneDone); người giới thiệu offline
// vẫn được cộng thẳng vào bản ghi của họ, lần sau mở game sẽ thấy.
function payRefMilestoneIfDue(save) {
  if (!save.referredBy || save.refMilestoneDone) return false;
  if ((save.totalEarned || 0) < REFERRAL_MILESTONE_EARNED) return false;
  const inviter = data.players[save.referredBy];
  if (!inviter || inviter.playerId === save.playerId) return false;
  inviter.gold += REFERRAL_MILESTONE_REWARD.gold;
  inviter.gems += REFERRAL_MILESTONE_REWARD.gems;
  inviter.friendsCount = friendsCountOf(inviter.playerId);
  save.refMilestoneDone = true;
  return true;
}
// Tính vàng offline: chỉ trong thời gian phiên còn hiệu lực, tối đa 8 giờ, 25% tốc độ thường
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
  return req.headers['x-owner-key'] && req.headers['x-owner-key'] === OWNER_KEY;
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
      const save = getOrCreatePlayer(String(playerId), now);
      const offlineEarned = applyOffline(save, now);
      payRefMilestoneIfDue(save); // vàng offline cũng tính vào tổng đào tích lũy
      save.friendsCount = friendsCountOf(save.playerId);
      // Client nhận đúng số dư này khi tải game -> mốc báo cáo của client = server
      save._clientGold = save.gold;
      save._clientGems = save.gems;
      await persist();
      return sendJson(res, 200, { save, offlineEarned, miners: MINERS, milestones: MILESTONES, referredByCode: referredByCodeOf(save) });
    }

    /* ---- POST /api/save ---- */
    if (req.method === 'POST' && url.pathname === '/api/save') {
      const body = await readBody(req);
      const playerId = body.playerId;
      if (!playerId) return sendJson(res, 400, { error: 'Thiếu playerId' });
      const save = getOrCreatePlayer(String(playerId), now);
      const inc = body.save || {};

      // Kiểm tra hợp lý: mọi số phải hữu hạn và không âm
      const numFields = ['gold', 'gems', 'minerLevel', 'tapPower', 'totalEarned', 'totalTaps', 'friendsCount', 'checkinStreak'];
      for (const f of numFields) {
        if (inc[f] !== undefined && (!Number.isFinite(inc[f]) || inc[f] < 0)) {
          return sendJson(res, 400, { error: 'Số liệu không hợp lệ: ' + f });
        }
      }
      // Chống gian lận ở mức hợp lý: vàng/KC tăng không vượt quá khả năng kiếm được
      // kể từ lần đồng bộ trước (GPS * thời gian * 2 + đệm cho chạm đào/nhiệm vụ).
      const dtSec = Math.max(1, (now - (save._lastSync || save.lastSeen || now)) / 1000);
      const maxGoldGain = gpsOf(save) * dtSec * 2 + 200000;
      const maxGemsGain = 20000;
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
        if (delta > maxGoldGain) delta = Math.floor(maxGoldGain);
        save.gold = Math.max(0, Math.floor(save.gold + delta));
        save._clientGold = save.gold;
      }
      if (inc.gems !== undefined) {
        const base = Number.isFinite(inc.baseGems) ? inc.baseGems
          : (Number.isFinite(save._clientGems) ? save._clientGems : save.gems);
        let delta = inc.gems - base;
        if (delta > maxGemsGain) delta = Math.floor(maxGemsGain);
        save.gems = Math.max(0, Math.floor(save.gems + delta));
        save._clientGems = save.gems;
      }

      const keep = ['minerLevel', 'tapPower', 'totalEarned', 'totalTaps',
        'lastCheckin', 'checkinStreak', 'tasks', 'achievementsClaimed'];
      for (const f of keep) if (inc[f] !== undefined) save[f] = inc[f];
      if (inc.miners && typeof inc.miners === 'object') {
        const clean = {};
        for (const m of MINERS) {
          const n = inc.miners[m.id];
          if (Number.isInteger(n) && n >= 0) clean[m.id] = n;
        }
        save.miners = clean;
      }
      if (Number.isFinite(inc.sessionEnd) && inc.sessionEnd >= 0) {
        // phiên tối đa 4 giờ kể từ hiện tại (cộng thêm độ trễ nhỏ)
        save.sessionEnd = Math.min(inc.sessionEnd, now + SESSION_SECONDS * 1000 + 60000);
      }
      payRefMilestoneIfDue(save);
      save.friendsCount = friendsCountOf(save.playerId);
      save._lastSync = now;
      save.lastSeen = now;
      await persist();
      return sendJson(res, 200, { save, referredByCode: referredByCodeOf(save) });
    }

    /* ---- POST /api/exchange {playerId, goldAmount} : vàng -> KC, 125:1, một chiều ---- */
    if (req.method === 'POST' && url.pathname === '/api/exchange') {
      const body = await readBody(req);
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
      const save = getOrCreatePlayer(String(body.playerId), now);
      const code = String(body.code || '').trim().toUpperCase();
      const gift = data.giftCodes[code];
      if (!gift) return sendJson(res, 404, { error: 'Mã quà tặng không tồn tại' });
      const used = data.redemptions[save.playerId] || [];
      if (used.includes(code)) return sendJson(res, 400, { error: 'Bạn đã dùng mã này rồi (mỗi mã chỉ dùng 1 lần)' });
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
      if (!isOwner(req)) return sendJson(res, 401, { error: 'Sai mã chủ game (header x-owner-key)' });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const code = String(body.code || '').trim().toUpperCase();
        if (!code) return sendJson(res, 400, { error: 'Thiếu mã code' });
        const gold = Math.max(0, Math.floor(body.gold || 0));
        const gems = Math.max(0, Math.floor(body.gems || 0));
        data.giftCodes[code] = { gold, gems, createdAt: now };
        await persist();
        return sendJson(res, 200, { ok: true, code, gold, gems });
      }
      if (req.method === 'GET') {
        return sendJson(res, 200, { giftCodes: data.giftCodes });
      }
    }

    /* ---- POST /api/withdraw ---- */
    if (req.method === 'POST' && url.pathname === '/api/withdraw') {
      const body = await readBody(req);
      if (!body.playerId) return sendJson(res, 400, { error: 'Thiếu playerId' });
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
        bank, account, name, gold,
        vnd: Math.floor(gold * WITHDRAW_RATE),
        status: 'Chờ xử lý',
        createdAt: now,
      };
      data.withdrawals.push(wd);
      save._clientGold = save.gold; save._clientGems = save.gems; // client nhận số dư này trong đáp
      save._lastSync = now; save.lastSeen = now;
      await persist();
      return sendJson(res, 200, { save, withdrawal: wd });
    }

    /* ---- GET /api/withdrawals : của 1 người chơi, hoặc tất cả nếu là owner ---- */
    if (req.method === 'GET' && url.pathname === '/api/withdrawals') {
      if (isOwner(req)) return sendJson(res, 200, { withdrawals: data.withdrawals });
      const playerId = url.searchParams.get('playerId');
      if (!playerId) return sendJson(res, 400, { error: 'Thiếu playerId' });
      return sendJson(res, 200, { withdrawals: data.withdrawals.filter((w) => w.playerId === String(playerId)) });
    }

    /* ---- POST /api/referral {playerId, code} ----
     * Cơ chế giới thiệu THẬT do server kiểm tra (chống farm), thưởng chia 2 phần:
     * - Ghi nhận: mã phải tồn tại; không tự giới thiệu mình; mỗi người chỉ có 1 người
     *   giới thiệu; chỉ ghi nhận khi tài khoản còn "mới" (tổng đào tích lũy < mốc).
     * - Ngay khi ghi nhận: người được mời +20.000 vàng/+100 KC, người mời +2.000/+10.
     * - Phần lớn trả sau: người mời +18.000 vàng/+90 KC khi người được mời đào tích
     *   lũy đủ 100.000 vàng (xem payRefMilestoneIfDue, đúng 1 lần/người được mời).
     * Mốc bạn bè theo SỐ NGƯỜI (MILESTONES cũ) không còn tự trả ở đây — tab Bạn bè
     * phía client nhận thưởng theo refCount thật qua luồng nhiệm vụ sẵn có. */
    if (req.method === 'POST' && url.pathname === '/api/referral') {
      const body = await readBody(req);
      if (!body.playerId) return sendJson(res, 400, { error: 'Thiếu playerId' });
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
      me.gold += REFERRAL_REWARD.gold;
      me.gems += REFERRAL_REWARD.gems;
      inviter.gold += REFERRAL_INVITER_REWARD.gold;
      inviter.gems += REFERRAL_INVITER_REWARD.gems;
      inviter.friendsCount = friendsCountOf(inviter.playerId);
      // KHÔNG đụng _clientGold/_clientGems của người mời: client của họ chưa biết
      // khoản cộng này, cơ chế gộp delta ở POST /api/save sẽ giữ nó cho họ.
      me.friendsCount = friendsCountOf(me.playerId);
      payRefMilestoneIfDue(me);
      me._clientGold = me.gold; me._clientGems = me.gems; // người được mời nhận số dư này trong đáp
      me._lastSync = now; me.lastSeen = now;
      await persist();
      return sendJson(res, 200, {
        save: me,
        reward: REFERRAL_REWARD,
        inviterReward: REFERRAL_INVITER_REWARD,
        referredByCode: inviter.referralCode,
      });
    }

    /* ---- File tĩnh ---- */
    if (req.method === 'GET') {
      let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
      filePath = path.normalize(path.join(PUBLIC_DIR, filePath));
      if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
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
    });
  })
  .catch((e) => {
    // Không in DATABASE_URL/mật khẩu ra log — chỉ in thông điệp lỗi
    console.error('Không khởi tạo được bộ lưu trữ, server không khởi động:', e.message);
    process.exit(1);
  });
