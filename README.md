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

## Nhóm holder lớn

Function `holders` chụp số dư các ví lớn nhất mỗi ngày và chia theo hạng: Top 1–10, 11–50, 51–100, 101–500, 501–1000. pg_cron gọi 5 phút một lần từ 00:07 đến 04:57 UTC (11:07–15:57 giờ Sydney mùa hè); mỗi lượt có giới hạn thời gian và chỉ làm coin chưa xong trong ngày, nên ngày chậm sẽ xong ở lượt sau.

| Coin | Nguồn | Ghi chú |
|---|---|---|
| PYTH, PENGU, TRUMP, RAY, BOME | Solana Tracker (top 1.000) | bỏ ví do chương trình quản lý (không nằm trên đường cong ed25519) |
| ENA, POL (Ethereum), OP (Optimism), ASTER, XVS (BSC): coin chủ dự án chọn | GoldRush top 1.000 (`GOLDRUSH_API_KEY`); token GoldRush từ chối (quá nhiều holder) → Ethplorer / Binplorer / Blockscout top 100 | bỏ địa chỉ hợp đồng |
| ETH | Bitquery realtime (`BITQUERY_API_KEY`), top 300 → 100 ví | chỉ ví có giao dịch gần đây |
| SEI | Seistream (top 1.000) | bỏ tài khoản module (pool staking, phí…) và địa chỉ hợp đồng |
| APT | Indexer Aptos Labs (số dư > 100.000 APT) | gồm cả tài khoản sàn/hợp đồng |
| ALGO | Indexer Algorand qua Nodely (> 200.000 ALGO) | gồm cả tài khoản ứng dụng |
| DOT | Subscan qua cổng PubFi (`SUBSCAN_API_KEY` = key PubFi `pf_…`), Polkadot Asset Hub, top 1.000; số dư thật của ví rời danh sách đọc trên chuỗi qua OnFinality (`ONFINALITY_API_KEY`) | bỏ tài khoản hệ thống (pallet, nomination pool, parachain) |
| Các token khác trong top 120 của Radar (cập nhật danh sách mỗi tuần) | Ethereum: Blockscout top 1.000 (miễn phí; lỗi thì Ethplorer top 100); BNB Chain: Binplorer top 100 (miễn phí); Solana: Solana Tracker top 1.000 | theo dõi trên chain giữ ít nhất 50% nguồn cung (so totalSupply trên chuỗi với tổng cung CoinGecko), nên bản bắc cầu (BNB trên Ethereum…) không bị nhầm; coin gốc và token chủ yếu trên chain khác chưa có |

- **Gom/xả của nhóm** = số dư hôm nay của các ví thuộc nhóm hôm trước trừ số dư hôm trước. Ví rời danh sách: số dư thật khi đọc được (EVM, APT, ALGO, DOT), nếu không thì tối đa bằng số dư nhỏ nhất còn trong danh sách (ước lượng thận trọng).
- **Lọc hợp đồng trên EVM**: mỗi địa chỉ được 2 node kiểm tra (publicnode + Infura `INFURA_API_KEY`; địa chỉ Infura không trả lời thì hỏi OnFinality `ONFINALITY_API_KEY`); hai node báo khác nhau thì coi là hợp đồng; địa chỉ chưa có đủ câu trả lời thì để lượt sau. Kết quả lưu ở `collector_state.evm_code_cache` nên mỗi địa chỉ chỉ kiểm tra một lần.
- **Lịch sử**: với token GoldRush, các lượt còn dư thời gian dựng lại tối đa 90 ngày (top 100 tại block của 00:07 UTC mỗi ngày, tìm block theo thời gian). Tiến độ ở `collector_state.holders_backfill`.
- **Credit GoldRush**: đếm theo số dòng trả về (0,02/dòng), dừng cứng ở 400/ngày và 9.000/tháng (`collector_state.goldrush_usage`).
- Chỉ lưu tổng theo nhóm; danh sách ví chỉ giữ ngày mới nhất và không công khai.
- **Giờ trên trang**: mọi giờ hiển thị theo giờ Sydney (AEST/AEDT), không phụ thuộc đồng hồ máy. Cột 6 giờ của khung 1W vẫn theo mốc của sàn (05h, 11h, 17h, 23h giờ Sydney mùa hè).
- **🐋 Dòng tiền cá voi so với volume**: cột xanh/đỏ = net USD của nhóm Top 1–10 + 11–50 mỗi ngày, cột xám = volume Binance spot của 24 giờ trước lần chụp. 🐋 = dòng tiền cá voi ≥2× mức thường của chính nó (trung vị tối đa 30 ngày trước, cần ít nhất 5 ngày); 🐋 to = cùng ngày volume cũng ≥1,8× mức thường.
- **Bản đồ bong bóng**: đường giá, mỗi ngày một bong bóng của nhóm đang chọn (xanh = gom, đỏ = xả), bán kính theo căn bậc hai lượng token, cùng một thang cho mọi nhóm trong khung; cột bên dưới là net USD theo giá ngày đó.

## Radar động lượng (`momentum.html`)

Bảng chấm điểm khoảng 200 coin lớn nhất (bỏ stablecoin, có cặp USDT trên Binance), chạy mỗi ngày lúc 00:20 giờ Sydney bằng function `momentum` (pg_cron gọi 13:20 và 14:20 UTC; lượt nào rơi trước nửa đêm Sydney thì bỏ qua vì ngày đó đã chấm). Nguồn: nến ngày Binance spot cắt theo giờ Sydney (tham số `timeZone`) (giá, volume, mua chủ động) và CoinGecko (danh sách, tên).

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
