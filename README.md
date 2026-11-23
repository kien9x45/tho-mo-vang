# Thợ Mỏ Vàng — Bản deploy độc lập (Game Đào Vàng Idle)

Bản đóng gói độc lập của game đào vàng idle, gồm 1 server Node.js **không dùng thư viện ngoài**
(chỉ `node:http`, `node:fs`, `node:crypto` + `fetch` có sẵn) + 1 trang client duy nhất.
Dữ liệu có 2 chế độ lưu:

- **Có biến môi trường `DATABASE_URL`** → lưu vào **Neon Postgres** (bảng `game_state`, qua
  Neon HTTP API) — dùng khi deploy lên host miễn phí có đĩa tạm thời như Render Free.
- **Không có `DATABASE_URL`** → lưu trong `data.json` cùng thư mục server (ghi an toàn qua
  file tạm + rename) — dùng khi chạy local/VPS có đĩa bền.

## Cấu trúc

```
tho-mo-vang/
├── server.js          # Server API + phục vụ file tĩnh
├── public/
│   └── index.html     # Toàn bộ giao diện game (tiếng Việt, mỏ 3D three.js + fallback 2D)
├── data.json          # Dữ liệu người chơi ở chế độ file (tự tạo khi chạy lần đầu; chế độ Neon thì lưu trong Postgres)
├── package.json
└── README.md
```

## Chạy local

```bash
cd tho-mo-vang
node server.js
# Mở http://localhost:3000
```

Đổi cổng: `PORT=8080 node server.js`

## Biến môi trường

| Biến            | Mặc định       | Ý nghĩa |
|-----------------|----------------|---------|
| `PORT`          | `3000`         | Cổng server lắng nghe (hầu hết các host tự cấp biến này). |
| `OWNER_KEY`     | `thomovang123` | Mã chủ game — dùng để tạo mã quà tặng (khu "Chủ game — Tạo mã quà tặng" trong tab Nâng Cấp) và xem danh sách yêu cầu rút tiền qua API. **Khi deploy thật PHẢI đổi** thành một mã bí mật riêng, ví dụ: `OWNER_KEY=ma-bi-mat-cua-ban node server.js` |
| `DATABASE_URL`  | _(trống)_      | Connection string của Neon Postgres. Nếu được đặt, server lưu dữ liệu vào Neon thay cho file `data.json` (log khởi động sẽ in `storage: neon`; không đặt thì in `storage: file`). Lấy ở Neon Console → **Connect** (chọn bản **pooled**). Không bao giờ commit giá trị này vào code/git. |
| `NEON_HTTP_BASE`| _(trống)_      | **Không bắt buộc, chỉ để test local** với mock server mô phỏng Neon HTTP API, ví dụ `NEON_HTTP_BASE=http://localhost:4517`. Khi dùng Neon thật thì KHÔNG đặt biến này. |

## Deploy Render Free + Neon (khuyên dùng — miễn phí, không mất dữ liệu)

Render Free có 2 đặc điểm cần biết:

1. **Filesystem bị xoá** mỗi lần service khởi động lại/ngủ dậy → nếu lưu bằng file
   `data.json` thì dữ liệu người chơi sẽ mất. Khắc phục: lưu vào **Neon Postgres** (bước dưới).
2. **Service ngủ sau 15 phút** không có ai truy cập; người chơi vào lại đầu tiên phải chờ
   khoảng 30–60 giây để service thức dậy. Chấp nhận được ở giai đoạn đầu.
   **Dữ liệu trong Neon an toàn tuyệt đối** qua các lần ngủ/khởi động lại này.

Các bước:

1. **Tạo database Neon (miễn phí):**
   - Đăng ký tại [neon.tech](https://neon.tech) → tạo project mới (gói Free).
   - Ở trang project, bấm **Connect** → lấy **connection string** (chọn bản **pooled**,
     host có chữ `-pooler`), dạng `postgresql://user:pass@ep-...-pooler....aws.neon.tech/dbname?sslmode=require`.
   - Không cần tạo bảng thủ công: server tự tạo bảng `game_state` khi khởi động lần đầu.
2. **Tạo Web Service trên Render (miễn phí):**
   - [render.com](https://render.com) → **New → Web Service** → trỏ tới repo code này.
   - Runtime: Node; **Start Command: `npm start`** (host tự cấp biến `PORT`).
   - Vào mục **Environment**, đặt 2 biến:
     - `DATABASE_URL` = connection string Neon ở bước 1.
     - `OWNER_KEY` = mã chủ game bí mật của bạn (tự đặt, đừng dùng mặc định).
   - Deploy. Mở log kiểm tra có dòng `storage: neon` là đúng chế độ.
3. Sau khi deploy, bạn có link dạng `https://<ten-app>.onrender.com`.
   Dán link này vào BotFather: `/newapp` → chọn bot **@ThoMoVang_bot** → nhập link khi được hỏi
   Web App URL; và `/setmenubutton` → dán cùng link để có nút mở game trong khung chat bot.

## Deploy lên host khác (Railway / Fly.io / VPS...)

Server chỉ cần Node.js >= 18, không cần `npm install` (không có thư viện ngoài).

- Trỏ lệnh chạy là `node server.js` (hoặc `npm start`), host sẽ tự đặt `PORT`.
- Đặt biến môi trường `OWNER_KEY`; đặt thêm `DATABASE_URL` (Neon) nếu host không có đĩa bền.
  Nếu host có persistent disk/VPS thì cứ để trống `DATABASE_URL`, server lưu file `data.json` như cũ.

## API chính

| Endpoint | Mô tả |
|----------|-------|
| `GET /api/save?playerId=...` | Lấy save (tạo mới + quà tân thủ 300.000 vàng / 1.500 KC nếu chưa có), đồng thời cộng vàng offline (25% tốc độ, tối đa 8 giờ, chỉ trong phiên đào) và trả kèm `offlineEarned`. |
| `POST /api/save` `{playerId, save}` | Lưu save (server kiểm tra số không âm + giới hạn mức tăng vàng/KC hợp lý). |
| `POST /api/exchange` `{playerId, goldAmount}` | Đổi vàng → kim cương, 125 vàng = 1 KC, một chiều, trừ/cộng phía server. |
| `POST /api/redeem` `{playerId, code}` | Đổi mã quà tặng (mỗi mã mỗi người 1 lần). |
| `POST /api/giftcodes` (header `x-owner-key`) `{code, gold, gems}` | Chủ game tạo mã. `GET /api/giftcodes` (owner) xem danh sách. |
| `POST /api/withdraw` `{playerId, method, bank, account, name, gold}` | Tạo yêu cầu rút tiền (tối thiểu 4.000.000 vàng, tỉ giá 1 vàng = 0,0005 VNĐ), trừ vàng phía server, trạng thái "Chờ xử lý" để chủ game duyệt tay. |
| `GET /api/withdrawals?playerId=...` | Lịch sử rút của 1 người chơi. Kèm header `x-owner-key` để xem tất cả. |
| `POST /api/referral` `{playerId, code}` | Nhập mã bạn bè (mã phải là mã thật của người chơi khác trên server), nhận quà 1 lần; người giới thiệu được tính bạn bè + thưởng mốc tự động. |

## Thông số game (đã chốt)

- Tốc độ đào: Lv.1 = 6,0 vàng/giây, +0,2/cấp. Nâng cấp thợ: 5.000 kim cương/cấp; kim cương chỉ dùng nâng cấp thợ.
- Phiên đào 4 giờ, hết phiên thợ tự động dừng. Offline: 25% tốc độ thường, tối đa 8 giờ, chỉ tính trong phiên còn hiệu lực.
- Quà tân thủ: 300.000 vàng + 1.500 kim cương.
- Cửa Hàng chỉ có: đổi vàng → kim cương (125:1, một chiều) + nhập mã quà tặng.
- Rút tiền: 1 vàng = 0,0005 VNĐ, tối thiểu 4.000.000 vàng, duyệt thủ công — game KHÔNG tự chuyển tiền.
