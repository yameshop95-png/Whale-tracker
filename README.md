# Whale-tracker

Theo dõi volume mua/bán và lệnh cá voi của bất kỳ coin nào, gom từ Binance, OKX, Bybit, Upbit, cộng thêm on-chain cho ETH và SEI.

- **Web**: `index.html`. Thanh search tìm theo tên hoặc mã coin, xem theo khung 1H / 1D / 1W.
- **Máy chủ 24/7**: Supabase project `whale-tracker` (Singapore).
  - Edge Function `collect` chạy mỗi phút (pg_cron).
  - Edge Function `smart` chạy mỗi 5 phút: smart money và CryptoQuant.
  - Dữ liệu được lưu 8 ngày.

## Nguồn dữ liệu

| Nguồn | Volume mua/bán | Nến (chỉ báo) |
|---|---|---|
| Binance, Binance US | Web đọc klines (taker buy), đủ lịch sử | Web, đủ lịch sử |
| OKX, Bybit, Coinbase, KuCoin, Gate, Kraken, Crypto.com, LBank, HTX, MEXC, Bitget, Upbit | Máy chủ lưu từng phút từ recent trades, kể từ lúc coin được thêm ⭐ | Web, đủ lịch sử (KuCoin, LBank, MEXC qua function `candles`) |
| Uniswap, PancakeSwap, Raydium | Web, 24h gần nhất (GeckoTerminal) | Web, đủ lịch sử |
| SEI DEX (Sei EVM) | Máy chủ, Etherscan API V2 | – |
| ETH cá voi | Máy chủ, Alchemy | – |
| Smart money (Ethereum, Sei, Solana) | Máy chủ, Etherscan API V2 + Solana RPC | – |
| CryptoQuant (BTC, ETH) | Máy chủ, mỗi giờ, cần gói có API | – |

- "Mua/Bán" là bên chủ động khớp lệnh (taker). Coinbase trả về phía maker nên đã được đảo lại.
- Dấu "≈" nghĩa là có phút sàn khớp nhiều lệnh hơn số lệnh API trả về một lần, nên volume phút đó có thể bị thiếu.
- Khung "📦 Tổng volume" cộng volume từ nến của mọi sàn và DEX, nên có đủ lịch sử cho mọi coin, kể cả coin chưa theo dõi 24/7.
- DEX chỉ tính pool có token được CoinGecko xác minh. Token trùng tên nhưng không xác minh bị loại và được liệt kê trong cảnh báo.

## Chỉ báo

Tính trên trình duyệt từ nến gộp của mọi nguồn (hoặc một nguồn tự chọn). Công thức EMA, Bollinger Bands, RSI, MACD, A/D, ADX trùng với TA-Lib.

- **A/D, ADX**: tích luỹ/phân phối, sức mạnh và hướng xu hướng
- **Combo Đột phá**: Volume Profile + Bollinger Bands (20, 2) + EMA 50
- **Combo Đảo chiều**: RSI (14) soi phân kỳ + Fibonacci + Volume
- **Combo Theo xu hướng**: EMA 21/50 + MACD (12, 26, 9) + ADX (14)

Mỗi combo chấm 3 chỉ báo (🟢 tăng / 🔴 giảm / ⚪ trung tính) và chỉ kết luận khi đủ 3/3 đồng thuận.

## Smart money

- **Ví tự phát hiện** (mỗi giờ): ví vừa có giao dịch ≥ $10K trên pool DEX đã xác minh (Uniswap, Raydium, Sei DEX) của các coin đang theo dõi. Giữ tối đa 40 ví; ví im lặng 14 ngày bị xoá.
- **Ví tự nhập**: mục "⚙️ Thêm / xoá ví" trên web, cần mật khẩu `WALLET_ADMIN_TOKEN`. Tối đa 50 ví.
- Chỉ tính token đã xác minh (USDT, USDC, WETH, WBTC, coin chính, coin đang theo dõi). Token giả mạo gửi vào ví cá voi bị bỏ qua.
- "Nhận vào/Chuyển ra" gồm cả mua bán lẫn chuyển khoản. Ví tự phát hiện chỉ là ví vừa giao dịch lớn, không chắc là ví có lãi.

## CryptoQuant

Máy chủ lưu netflow, dự trữ sàn, tỷ lệ cá voi, dòng ra của thợ đào (BTC), funding rate, open interest cho BTC và ETH vào bảng `cq_metrics`. Bảng này **riêng tư** theo mặc định. Chỉ khi bạn đã đọc điều khoản CryptoQuant và chắc chắn được phép hiển thị công khai, chạy trong SQL Editor:

```sql
create policy "public read" on public.cq_metrics for select to anon, authenticated using (true);
```

## Thêm API key cho máy chủ

Supabase Dashboard → project `whale-tracker` → **Edge Functions → Secrets**, thêm:

- `ETHERSCAN_API_KEY`: để thu lệnh cá voi SEI trên DEX
- `ALCHEMY_API_KEY`: để thu chuyển khoản cá voi ETH
- `WALLET_ADMIN_TOKEN`: mật khẩu tự đặt (≥ 12 ký tự, ngẫu nhiên) để thêm/xoá ví smart money trên web
- `SOLANA_RPC_URL`: URL RPC Solana (ví dụ Helius gói miễn phí) để theo dõi ví Solana
- `CRYPTOQUANT_API_KEY`: key của gói CryptoQuant có API

Không gửi key qua chat hay commit vào git. Lỗi hiển thị trên web đã được che key.

Không cần deploy lại. Từ lần chạy kế tiếp, khoảng 1 phút sau, máy chủ sẽ dùng key.

## Cấu trúc

- `supabase/migrations/`: bảng, RLS, hàm đọc/ghi, lịch chạy
- `supabase/functions/collect/`: chương trình thu dữ liệu
- `supabase/functions/smart/`: smart money và CryptoQuant
- `supabase/functions/wallets/`: thêm/xoá ví (kiểm tra mật khẩu quản trị)
- `supabase/functions/candles/`: trung gian lấy nến KuCoin, LBank, MEXC (3 sàn này không cho trình duyệt gọi trực tiếp)
- `sei.html`: chuyển hướng về `/?coin=SEI`
