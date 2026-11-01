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
- **Combo Đảo chiều**: RSI (14) soi phân kỳ + Fibonacci + Volume (phân kỳ volume: giá so với CVD từ mua/bán chủ động trên Binance và A/D gộp mọi nguồn; không có phân kỳ thì xét volume đột biến ≥ 2×)
- **Combo Theo xu hướng**: EMA 21/50 + MACD (12, 26, 9) + ADX (14)

Mỗi combo chấm 3 chỉ báo (🟢 tăng / 🔴 giảm / ⚪ trung tính) và chỉ kết luận khi đủ 3/3 đồng thuận.

## Smart money

- **Ví tự phát hiện** (mỗi giờ): ví vừa có giao dịch ≥ $10K trên pool DEX đã xác minh (Uniswap, Raydium, Sei DEX) của các coin đang theo dõi. Giữ tối đa 40 ví; ví im lặng 14 ngày bị xoá.
- **Top lãi Solana** (cần `SOLANATRACKER_API_KEY`, gói miễn phí đủ dùng): 15 ví lãi thực nhiều nhất 7 ngày trên Solana theo Solana Tracker, loại bot arbitrage và ví lãi nhờ một token. Cập nhật mỗi 6 giờ.
- **Ví tự nhập**: mục "⚙️ Thêm / xoá ví" trên web, cần mật khẩu `WALLET_ADMIN_TOKEN`. Tối đa 50 ví.
- Chỉ tính token đã xác minh (USDT, USDC, WETH, WBTC, coin chính, coin đang theo dõi). Token giả mạo gửi vào ví cá voi bị bỏ qua.
- "Nhận vào/Chuyển ra" gồm cả mua bán lẫn chuyển khoản. Ví tự phát hiện chỉ là ví vừa giao dịch lớn, không chắc là ví có lãi.

## Nhóm holder lớn (token Solana)

Mỗi ngày lúc 00:07 UTC, function `holders` chụp số dư 1.000 ví nắm giữ nhiều nhất của PYTH, PENGU, TRUMP, RAY, BOME (Solana Tracker, 1 lượt/token/ngày) và chia theo hạng: Top 1–10, 11–50, 51–100, 101–500, 501–1000.

- **Gom/xả của nhóm** = số dư hôm nay của các ví thuộc nhóm hôm trước trừ số dư hôm trước. Ví bán hết và rời top 1.000 được tính ở mức số dư thấp nhất còn trong top (ước lượng thận trọng).
- Ví do chương trình quản lý (pool, vault: địa chỉ không nằm trên đường cong ed25519) bị loại. Ví sàn chưa loại được.
- Mức tập trung: % nguồn cung của top 10 / top 100 và Gini của top 1.000.
- Chỉ lưu tổng theo nhóm; danh sách ví chỉ giữ ngày mới nhất và không công khai.
- **ERC-20 (ENA, POL)**: top 100 ví từ Ethplorer (giới hạn miễn phí), nhóm Top 1–10, 11–50, 51–100. Infura dùng để loại địa chỉ hợp đồng (pool, staking, bridge, multisig) và đọc số dư chính xác của ví rời top 100. Cần secret `INFURA_API_KEY`; `ETHPLORER_API_KEY` tuỳ chọn (không có thì dùng key công khai `freekey`).
- BTC và ETH là coin gốc của chuỗi: không có danh sách holder miễn phí nên chưa có.
- **Bản đồ bong bóng**: đường giá, mỗi ngày một bong bóng của nhóm đang chọn (xanh = gom, đỏ = xả), bán kính theo căn bậc hai lượng token, cùng một thang cho mọi nhóm trong khung; cột bên dưới là net USD theo giá ngày đó.

## Radar động lượng (`momentum.html`)

Bảng chấm điểm khoảng 100 coin lớn nhất (bỏ stablecoin, có cặp USDT trên Binance), chạy mỗi ngày lúc 00:20 UTC bằng function `momentum`. Nguồn: nến ngày Binance spot (giá, volume, mua chủ động) và CoinGecko (danh sách, tên).

- 5 điểm 0–100, mỗi điểm là trung bình **xếp hạng phần trăm** của các thành phần trong danh sách hôm đó (tương đối, không phải dự đoán):
  - **Đà tăng**: lợi nhuận 7 ngày, giá/EMA20, tỷ lệ mua chủ động 7 ngày
  - **Tích luỹ**: CMF 20, OBV 30 ngày, mua chủ động ròng 30 ngày
  - **Rủi ro** (thấp là tốt): biến động, sụt giảm lớn nhất, biến động chiều giảm (30 ngày)
  - **Nhiệt** (thấp là tốt): RSI 14, giá/EMA50, volume 3N/30N
  - **Bền vững**: giá/EMA100, độ dốc EMA50, tỷ lệ ngày tăng 90N, ADX có dấu
- 8 trạng thái theo luật cố định (`engine.ts`): Khởi động, Tăng tốc, Xu hướng khoẻ, Gom âm thầm, Trung tính, Quá nhiệt, Suy yếu, Biến động cực đoan.
- Lưu 31 ngày gần nhất mỗi lần chạy (để xem trạng thái đổi theo thời gian), giữ 120 ngày.
- Cột Volume ngày mới nhất là volume 24h mọi sàn (`total_volume` của CoinGecko, có sẵn trong lượt gọi danh sách, không tốn thêm request; lưu ở `parts.vol_all`); rê chuột để xem riêng Binance.
- Trang: lọc theo hạng, trạng thái, khoảng điểm từng cột; chi tiết coin (radar, trạng thái 30 ngày, biểu đồ 30/90/180 ngày hai chế độ: **Volume so với thường** = volume ngày / trung vị 30 ngày trước, tô màu bùng nổ ≥2,5× theo phe mua/bán chủ động, thức giấc, sao vàng ≥5×; và **Mua/bán ròng** với đột biến; kèm phản ứng giá ngày sau); so sánh tối đa 4 coin.

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
- `INFURA_API_KEY`: Project ID/API key của Infura (gói miễn phí) cho nhóm holder ERC-20
- `ETHPLORER_API_KEY` (tuỳ chọn): key miễn phí cá nhân của Ethplorer
- `SOLANATRACKER_API_KEY`: key Data API của Solana Tracker (solanatracker.io → Account → Data API)

Không gửi key qua chat hay commit vào git. Lỗi hiển thị trên web đã được che key.

Không cần deploy lại. Từ lần chạy kế tiếp, khoảng 1 phút sau, máy chủ sẽ dùng key.

## Cấu trúc

- `supabase/migrations/`: bảng, RLS, hàm đọc/ghi, lịch chạy
- `supabase/functions/collect/`: chương trình thu dữ liệu
- `supabase/functions/smart/`: smart money và CryptoQuant
- `supabase/functions/momentum/`: Radar động lượng (chấm điểm mỗi ngày; công thức trong `engine.ts`)
- `supabase/functions/holders/`: nhóm holder lớn của token Solana (chạy mỗi ngày)
- `supabase/functions/wallets/`: thêm/xoá ví (kiểm tra mật khẩu quản trị)
- `supabase/functions/candles/`: trung gian lấy nến KuCoin, LBank, MEXC (3 sàn này không cho trình duyệt gọi trực tiếp)
- `sei.html`: chuyển hướng về `/?coin=SEI`
