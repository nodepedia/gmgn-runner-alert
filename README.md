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

## Rate limit GMGN (hasil pengukuran langsung)

Limit-nya **berbasis IP**, satu bucket kecil, dan kalau jebol IP-nya diblokir
**30 detik** (`retry-after: 30`). Yang penting: bukan rata-rata per menit yang
bikin 429, tapi **kecepatan sesaat** — bucket-nya kosong lalu request berikutnya
langsung kena.

Angka yang terukur (VPS produksi, mint berbeda-beda supaya tidak kena cache GMGN):

| Pola | Hasil |
|---|---|
| 5 request beruntun tanpa jeda | 429 di request ke-5 |
| 300 ms antar request (1,8 rps), siklus kedua berturut-turut | 429 |
| **1000 ms antar request (1 rps), 4 siklus cold berturut-turut (84 request)** | **0 × 429** |
| `market/rank` lalu langsung `token/info` | bucket habis (`remaining: 0`) |

Dari header `x-ratelimit-remaining` saat idle: `rank` → `1`, `info` → `0`,
`security` → `0`, lalu naik `1,1,2,2,3` — artinya bucket ±5 unit dan terisi
ulang **±1 unit/detik**. `market/rank` bobotnya ±3, jadi setelah rank bucket
hampir kosong.

Desain yang dipakai:

1. **Satu request in flight** (`Pacer` di `src/ratelimit.ts`), jarak start
   `GMGN_MIN_GAP_MS` (default **1000 ms**) + jitter.
2. **Jeda setelah rank** (`GMGN_RANK_SETTLE_MS`, default 800 ms) supaya bucket
   sempat terisi sebelum `token/info` pertama.
3. **AIMD backoff**: kalau tetap kena 429, gap digandakan (maks `GMGN_MAX_GAP_MS`)
   dan semua pemanggil menunggu `retry-after`, lalu perlahan turun lagi.
4. **Cache persisten di SQLite** (`api_cache`), jadi restart tidak memicu cold fetch:
   - `token/info` 55 detik (fee + volume 5m, sekali per siklus)
   - `token/security` 1 jam (jarang berubah)
   - Meteora TVL 5 menit
5. **Prefilter murah**: `market/rank` sudah memuat `market_cap`,
   `creation_timestamp`, `history_highest_market_cap`. Token yang tidak lolos
   age/MCAP/cooldown **tidak** memanggil endpoint token sama sekali.
6. **Token yang sudah diketahui jelek dilewati tanpa request**: security dari
   cache dicek lebih dulu, jadi token blacklist/honeypot tidak memakan kuota.
7. **Kegagalan per token diisolasi**: satu 429/timeout tidak membatalkan
   seluruh siklus, dan siklus berikutnya dijadwalkan 60 detik **setelah** siklus
   sebelumnya selesai (tidak menumpuk).

Konsumsi nyata (limit 100, filter penuh, ~10 kandidat):

| Kondisi | Request | Durasi siklus |
|---|---|---|
| Cache kosong (cold) | ~21 | ~22 detik |
| Cache hangat (siklus berikutnya) | 1 (rank saja) | <2 detik |

Steady state ~1–15 request per menit, jauh di bawah ambang.
