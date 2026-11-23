'use strict';
/*
 * Thợ Mỏ Vàng — server độc lập, KHÔNG dùng thư viện ngoài.
 * Chạy: node server.js   (cổng: process.env.PORT, mặc định 3000)
 * Dữ liệu: data.json cùng thư mục (ghi an toàn: file tạm + rename).
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
const REFERRAL_REWARD = { gold: 20000, gems: 100 }; // quà cho người nhập mã bạn bè
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

/* ---------------- Lưu trữ ---------------- */
function emptyData() {
  return { players: {}, giftCodes: {}, redemptions: {}, withdrawals: [] };
}
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const d = JSON.parse(raw);
    if (!d.players || !d.giftCodes || !d.redemptions || !Array.isArray(d.withdrawals)) return emptyData();
    return d;
  } catch (_) {
    return emptyData();
  }
}
let data = loadData();
function persist() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
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
  if (!data.players[playerId]) {
    data.players[playerId] = newSave(playerId, now);
    persist();
  }
  return data.players[playerId];
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

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
      persist();
      return sendJson(res, 200, { save, offlineEarned, miners: MINERS, milestones: MILESTONES });
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
      if (inc.gold !== undefined && inc.gold > save.gold + maxGoldGain) inc.gold = Math.floor(save.gold + maxGoldGain);
      if (inc.gems !== undefined && inc.gems > save.gems + maxGemsGain) inc.gems = Math.floor(save.gems + maxGemsGain);

      const keep = ['gold', 'gems', 'minerLevel', 'tapPower', 'totalEarned', 'totalTaps',
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
      save._lastSync = now;
      save.lastSeen = now;
      persist();
      return sendJson(res, 200, { save });
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
      save._lastSync = now; save.lastSeen = now;
      persist();
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
      save._lastSync = now; save.lastSeen = now;
      persist();
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
        persist();
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
      save._lastSync = now; save.lastSeen = now;
      persist();
      return sendJson(res, 200, { save, withdrawal: wd });
    }

    /* ---- GET /api/withdrawals : của 1 người chơi, hoặc tất cả nếu là owner ---- */
    if (req.method === 'GET' && url.pathname === '/api/withdrawals') {
      if (isOwner(req)) return sendJson(res, 200, { withdrawals: data.withdrawals });
      const playerId = url.searchParams.get('playerId');
      if (!playerId) return sendJson(res, 400, { error: 'Thiếu playerId' });
      return sendJson(res, 200, { withdrawals: data.withdrawals.filter((w) => w.playerId === String(playerId)) });
    }

    /* ---- POST /api/referral {playerId, code} ---- */
    if (req.method === 'POST' && url.pathname === '/api/referral') {
      const body = await readBody(req);
      if (!body.playerId) return sendJson(res, 400, { error: 'Thiếu playerId' });
      const me = getOrCreatePlayer(String(body.playerId), now);
      const code = String(body.code || '').trim().toUpperCase();
      if (me.referredBy) return sendJson(res, 400, { error: 'Bạn đã nhập mã bạn bè rồi' });
      if (code === me.referralCode) return sendJson(res, 400, { error: 'Không thể nhập mã của chính mình' });
      const inviter = Object.values(data.players).find((p) => p.referralCode === code);
      if (!inviter) return sendJson(res, 404, { error: 'Mã bạn bè không tồn tại' });
      me.referredBy = inviter.playerId;
      me.gold += REFERRAL_REWARD.gold;
      me.gems += REFERRAL_REWARD.gems;
      inviter.friendsCount = (inviter.friendsCount || 0) + 1;
      inviter.milestonesPaid = inviter.milestonesPaid || [];
      for (const ms of MILESTONES) {
        if (inviter.friendsCount >= ms.count && !inviter.milestonesPaid.includes(ms.count)) {
          inviter.milestonesPaid.push(ms.count);
          inviter.gold += ms.gold;
          inviter.gems += ms.gems;
        }
      }
      me._lastSync = now; me.lastSeen = now;
      persist();
      return sendJson(res, 200, { save: me, reward: REFERRAL_REWARD });
    }

    /* ---- File tĩnh ---- */
    if (req.method === 'GET') {
      let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
      filePath = path.normalize(path.join(PUBLIC_DIR, filePath));
      if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
      fs.readFile(filePath, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(buf);
      });
      return;
    }

    return sendJson(res, 404, { error: 'Không tìm thấy' });
  } catch (e) {
    return sendJson(res, 500, { error: 'Lỗi server: ' + e.message });
  }
});

server.listen(PORT, () => {
  console.log('Thợ Mỏ Vàng đang chạy tại http://localhost:' + PORT);
});
