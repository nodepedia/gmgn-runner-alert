# GMGN Runner Alert

Bot Telegram untuk memantau token Solana yang sedang trending di GMGN (window 5 menit) dan lolos filter runner.

## Filter

| Filter | Field | Aturan |
|---|---|---|
| Age | `creation_timestamp` | >= 48 jam |
| Market cap | `market_cap` | >= $2.000.000 |
| Total fees | `total_fee` | >= 60 SOL |
| Blacklist | `blacklist` | == 0 |
| Honeypot | `honeypot` | == 0 |
| Mint authority | `renounced_mint` | true |
| Freeze authority | `renounced_freeze_account` | true |

Enrichment (tidak memblokir alert):

- Volume 5 menit (`price.volume_5m`)
- Total TVL semua pool Meteora (DLMM + DAMM v2)
- Tag ATH dari `market_cap >= history_highest_market_cap`

## Alur

```
GMGN /v1/market/rank (interval 5m, limit 100, order volume)
  -> prefilter age + market cap
  -> cooldown 1 jam per token
  -> /v1/token/info      (total_fee, volume_5m)
  -> /v1/token/security  (blacklist, honeypot, renounced)
  -> Meteora DLMM + DAMM v2 (sum tvl)
  -> Telegram + tombol Copy CA
```

## Setup

```bash
npm install
cp .env.example .env
# isi GMGN_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
npm run build
npm run test:telegram   # kirim pesan tes
npm run warmup          # catat token trending saat ini tanpa kirim alert
npm run once            # satu kali scan, tanpa daemon
```

## PM2

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
pm2 logs gmgn-runner-alert
```

## Catatan

- State dedupe/cooldown disimpan di `data/bot.db` (SQLite bawaan Node).
- `DRY_RUN=true` akan mencetak pesan ke log tanpa mengirim ke Telegram, tapi state tetap dicatat.
- `npm run warmup` mencatat token trending saat ini tanpa alert, jadi saat pertama kali live tidak ada burst.

## Rate limit GMGN (hasil pengukuran)

Limit-nya **berbasis IP**, dan yang memicu ban bukan rata-rata rate tapi **burst**:
satu kali 429 = IP diblokir 30 detik (`retry-after: 30`, `reset_at`).

Yang terbukti dari pengukuran langsung:

| Pola | Hasil |
|---|---|
| 5 request beruntun tanpa jeda | 429 di request ke-5 |
| 15 request, jeda 250–400 ms | aman |
| 120 request campuran info+security, jeda 300 ms (1,85 rps, 65 detik) | aman, 0 × 429 |
| 40 request security, jeda 300 ms | aman, 0 × 429 |

Karena itu desainnya:

1. **Satu request in flight** (`Pacer` di `src/ratelimit.ts`), start dipisah `GMGN_MIN_GAP_MS` (default 300 ms) + jitter.
2. **AIMD backoff**: kalau tetap kena 429, gap digandakan (maks `GMGN_MAX_GAP_MS`) dan semua pemanggil menunggu `retry-after`, lalu perlahan turun lagi.
3. **Cache persisten di SQLite** (`api_cache`), jadi restart tidak memicu cold fetch:
   - `token/info` 55 detik (fee + volume 5m, sekali per siklus)
   - `token/security` 1 jam (jarang berubah)
   - Meteora TVL 5 menit
4. **Prefilter murah**: `market/rank` sudah memuat `market_cap`, `creation_timestamp`, `history_highest_market_cap`. Token yang tidak lolos age/MCAP/cooldown **tidak** memanggil endpoint token sama sekali.
5. **Token yang sudah diketahui jelek dilewati tanpa request**: security dari cache dicek lebih dulu, jadi token blacklist/honeypot tidak memakan kuota.
6. **Kegagalan per token diisolasi**: satu 429/timeout tidak membatalkan seluruh siklus.

Efeknya pada data nyata (limit 100, filter penuh):

| Kondisi | Request | Durasi siklus |
|---|---|---|
| Cache kosong (cold) | ~20 | ~7–8 detik |
| Cache hangat (siklus berikutnya) | 1 (rank saja) | <1 detik |

Karena polling 60 detik, steady state hanya ~1–15 request per menit — jauh di bawah ambang.

