# OmnichannelPOS Chat Backend

Chat Backend nhận webhook tin nhắn từ TikTok Shop/Lazada, lưu dữ liệu PostgreSQL,
phát realtime qua Socket.IO và điều phối AI autopilot bằng BullMQ/Redis.

## Chạy local

Yêu cầu PostgreSQL, Redis và AI Backend đang chạy.

```bash
cp .env.example .env
npm install
npm run dev
```

Kiểm tra:

```bash
curl http://localhost:8082/health
```

Health hợp lệ có `db=connected`, `redis=connected` và `aiAutopilot=ready`.

## Luồng autopilot

1. Marketplace webhook được xác thực và chống trùng bằng `webhook_inbox`.
2. Tin inbound của hội thoại `AUTO` được enqueue với `jobId=messageId`.
3. Worker chờ debounce, kiểm tra tin mới hơn/nhân viên đã trả lời/quota token.
4. Worker chỉ gửi context tối thiểu tới AI endpoint stateless.
5. `AUTO_REPLY` được gửi về sàn bằng idempotency key theo AI run.
6. `HUMAN_HANDOFF`, lỗi quota hoặc lỗi provider cuối cùng chuyển hội thoại sang
   `HUMAN_ONLY`, tạo `human_handoffs`, notification và Socket.IO update.

Autopilot chỉ gửi khi hội thoại vẫn ở `AUTO` ngay trước thời điểm gửi. Nếu có tin mới
hơn hoặc nhân viên đã trả lời, worker hủy câu trả lời cũ để tránh gửi đè/lệch ngữ cảnh.

Các biến điều chỉnh nằm trong `.env.example`, gồm thời gian debounce, concurrency,
số lần retry, backoff và hạn mức token mặc định.
