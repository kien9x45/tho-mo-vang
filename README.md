# Thợ Mỏ Vàng — Bản deploy độc lập (Game Đào Vàng Idle)

Bản đóng gói độc lập của game đào vàng idle, gồm 1 server Node.js **không dùng thư viện ngoài**
(chỉ `node:http`, `node:fs`, `node:crypto`) + 1 trang client duy nhất. Dữ liệu lưu trong
`data.json` cùng thư mục server (ghi an toàn qua file tạm + rename).

## Cấu trúc

```
tho-mo-vang/
├── server.js          # Server API + phục vụ file tĩnh
├── public/
│   └── index.html     # Toàn bộ giao diện game (tiếng Việt, mỏ 3D three.js + fallback 2D)
├── data.json          # Dữ liệu người chơi (tự tạo khi chạy lần đầu)
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

| Biến        | Mặc định       | Ý nghĩa |
|-------------|----------------|---------|
| `PORT`      | `3000`         | Cổng server lắng nghe (hầu hết các host tự cấp biến này). |
| `OWNER_KEY` | `thomovang123` | Mã chủ game — dùng để tạo mã quà tặng (khu "Chủ game — Tạo mã quà tặng" trong tab Nâng Cấp) và xem danh sách yêu cầu rút tiền qua API. **Khi deploy thật PHẢI đổi** thành một mã bí mật riêng, ví dụ: `OWNER_KEY=ma-bi-mat-cua-ban node server.js` |

## Deploy lên host công khai (để lấy link HTTPS cho BotFather)

Server chỉ cần Node.js >= 18, không cần `npm install` (không có thư viện ngoài).

- **Render / Railway / Fly.io / VPS**: trỏ lệnh chạy là `node server.js`, host sẽ tự đặt `PORT`.
  Nhớ đặt thêm biến môi trường `OWNER_KEY` trong phần cấu hình của host.
- Sau khi deploy, bạn có link dạng `https://<ten-app>.onrender.com` (hoặc domain của host).
  Dán link này vào BotFather: `/newapp` → chọn bot **@ThoMoVang_bot** → nhập link khi được hỏi
  Web App URL; và `/setmenubutton` → dán cùng link để có nút mở game trong khung chat bot.
- Lưu ý: file `data.json` nằm trên đĩa của host. Nếu dùng host miễn phí có đĩa tạm thời
  (ephemeral filesystem), dữ liệu có thể mất khi host khởi động lại — nên dùng gói có
  persistent disk hoặc VPS nếu chạy lâu dài cho người chơi thật.

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
