# Whale-tracker

Theo dõi volume mua/bán và lệnh cá voi của bất kỳ coin nào, gom từ Binance, OKX, Bybit, Upbit, cộng thêm on-chain cho ETH và SEI.

- **Web**: `index.html`. Thanh search tìm theo tên hoặc mã coin, xem theo khung 1H / 1D / 1W.
- **Máy chủ 24/7**: Supabase project `whale-tracker` (Singapore).
  - Edge Function `collect` chạy mỗi phút (pg_cron).
  - Dữ liệu được lưu 8 ngày.

## Nguồn dữ liệu

| Nguồn | Cách lấy | Lịch sử |
|---|---|---|
| Binance | Web đọc trực tiếp klines (taker buy) | Đầy đủ 1 tuần |
| OKX, Bybit, Upbit | Máy chủ lưu từng phút từ recent trades | Từ lúc coin được thêm ⭐ |
| SEI DEX (Sei EVM) | Máy chủ, Etherscan API V2 | Từ lúc có key |
| ETH cá voi | Máy chủ, Alchemy | Từ lúc có key |

Dấu "≈" trên một sàn nghĩa là có phút sàn khớp nhiều lệnh hơn số lệnh API trả về một lần, nên volume phút đó có thể bị thiếu.

## Thêm API key cho máy chủ

Supabase Dashboard → project `whale-tracker` → **Edge Functions → Secrets**, thêm:

- `ETHERSCAN_API_KEY`: để thu lệnh cá voi SEI trên DEX
- `ALCHEMY_API_KEY`: để thu chuyển khoản cá voi ETH

Không cần deploy lại. Từ lần chạy kế tiếp, khoảng 1 phút sau, máy chủ sẽ dùng key.

## Cấu trúc

- `supabase/migrations/`: bảng, RLS, hàm đọc/ghi, lịch chạy
- `supabase/functions/collect/`: chương trình thu dữ liệu
- `sei.html`: chuyển hướng về `/?coin=SEI`
