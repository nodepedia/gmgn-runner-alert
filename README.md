# GMGN Runner Alert

Bot Telegram untuk memantau token Solana yang sedang trending di GMGN (window 5 menit) dan lolos filter runner.

## Filter keras

Semua harus lolos. Kalau salah satu gagal, token tidak masuk pesan apa pun.

| Filter | Field | Aturan |
|---|---|---|
| Age | `creation_timestamp` | >= 48 jam |
| Market cap | `market_cap` | >= $2.000.000 |
| Total fees | `total_fee` | >= 60 SOL |
| Meteora TVL | `tvl` DLMM + DAMM v2 | >= $20.000 |
| Blacklist | `blacklist` | == 0 |
| Honeypot | `honeypot` | == 0 |
| Mint authority | `renounced_mint` | true |
| Freeze authority | `renounced_freeze_account` | true |

## Dua jalur alert

Volume 5m **bukan filter**, tapi pembeda:

| Jalur | Syarat | Pengiriman |
|---|---|---|
| 🔥 **Runner** | semua filter + `vol 5m >= $10.000` | **real-time**, satu pesan per token |
| 👀 **Watchlist** | semua filter, `vol 5m < $10.000` | **satu pesan tiap 5 menit** (maks 20 token) |

Runner punya cooldown `COOLDOWN_MINUTES` (default 60) supaya token yang sedang
ramai tidak di-alert tiap 30 detik. Watchlist **tanpa cooldown**: token yang
masih trending akan muncul lagi di pesan berikutnya.

Enrichment: tag ATH dari `market_cap >= history_highest_market_cap`.

## Alur

```
GMGN /v1/market/rank (interval 5m, limit 100, order volume)   tiap 30 detik
  -> prefilter age + market cap
  -> /v1/token/info      (total_fee, volume_5m)
  -> Meteora DLMM + DAMM v2 (sum tvl, filter >= $20K)
  -> /v1/token/security  (blacklist, honeypot, renounced)
  -> vol 5m >= $10K ?  runner -> kirim SEKARANG (cooldown 60 menit)
                       watchlist -> buffer, kirim tiap 5 menit (maks 20)
```

## Format alert

**Runner (real-time):**

```
🚀 $FIONA — Runner Alert
Fiona the Hippo

MC $2.64M · Vol 5m $92.3K · 🔥ATH

CA: 4CxjZyMNoF1p6eXHXHv1TWpS2X47CuUmLwtGe18spump
[ 📋 Copy CA ]
```

**Watchlist (tiap 5 menit, urut vol 5m):**

```
👀 Watchlist · 9 token · 20:15 WIB
semua filter lolos · vol 5m < $10.0K

1. $USELESS · MC $81.29M · vol $3.9K
2. $ANSEM · MC $31.72M · vol $6.8K

+12 lainnya (tercatat di log)
[ 📋 $USELESS ] [ 📋 $ANSEM ]
```

Tombol `📋` berisi mint token (copy CA), 3 per baris. Kalau dua token punya
simbol sama, labelnya diberi pembeda mint. Umur token, total fee, dan TVL
dipakai sebagai filter tapi tidak ditampilkan.

Watchlist dikirim di batas jam dinding (20:10, 20:15, 20:20), hanya kalau ada
isinya. `REPORT_MODE=individual` mematikan watchlist (hanya runner real-time).

## Setup

```bash
npm install
cp .env.example .env
cp strat.conf.example strat.conf
# isi GMGN_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID di .env
npm run build
npm run test:telegram   # kirim pesan tes
npm run warmup          # catat token trending saat ini tanpa kirim alert
npm run once            # satu kali scan, tanpa daemon
```

## Tuning tanpa deploy (`strat.conf`)

Semua angka bisa diubah dari **satu file**: `strat.conf` (tidak ikut git, ada
template di `strat.conf.example`).

```bash
cp strat.conf.example strat.conf
nano strat.conf          # ubah MIN_VOL5M_USD, COOLDOWN_MINUTES, dll
node dist/index.js --show-config   # lihat nilai efektif + asal nilainya
```

Edit lalu simpan — **tanpa restart, tanpa rebuild, tanpa push**. Bot mengecek
mtime file di awal setiap siklus, jadi perubahan berlaku pada siklus berikutnya
(maksimal ~`POLL_INTERVAL_MS`, default 30 detik). Log akan menulis:

```
strat.conf reloaded {"file":"/opt/gmgn-runner-alert/strat.conf","keys":25,"changed":1,"errors":0}
strat MIN_VOL5M_USD: 10000 -> 5000
```

Urutan prioritas: **`strat.conf` > `.env` > default di kode**. Secret
(`GMGN_API_KEY`, `TELEGRAM_BOT_TOKEN`) sebaiknya tetap di `.env`, tapi kalau
ditulis di `strat.conf` juga tetap dibaca.

| Grup | Key | Default |
|---|---|---|
| gmgn | `GMGN_MIN_GAP_MS` / `GMGN_MAX_GAP_MS` / `GMGN_RANK_SETTLE_MS` | 1000 / 5000 / 800 |
| telegram | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | dari `.env` |
| filter | `TRENDING_INTERVAL` / `TRENDING_LIMIT` / `TRENDING_ORDER_BY` | 5m / 100 / volume |
| filter | `MIN_AGE_HOURS` / `MIN_MARKET_CAP` / `MIN_TOTAL_FEE_SOL` | 48 / 2e6 / 60 |
| filter | `MIN_VOL5M_USD` / `MIN_TVL_USD` / `ATH_TOLERANCE` | 10000 / 20000 / 0.995 |
| runtime | `POLL_INTERVAL_MS` / `MAX_CANDIDATES_PER_CYCLE` / `COOLDOWN_MINUTES` | 30000 / 25 / 60 |
| runtime | `DRY_RUN` / `DB_PATH` | false / data/bot.db |
| cache | `INFO_CACHE_MS` / `SECURITY_CACHE_MS` / `METEORA_CACHE_MS` | 55s / 1h / 5m |
| report | `REPORT_MODE` / `REPORT_WINDOW_MINUTES` / `WATCHLIST_MAX` | digest / 5 / 20 |
| report | `REPORT_TIMEZONE` / `REPORT_TZ_LABEL` | Asia/Jakarta / WIB |

Nilai divalidasi: angka di luar rentang, enum salah, atau key typo **tidak**
mengubah apa pun. Nilai lama tetap dipakai dan alasannya masuk log
(`strat.conf ignored a value -> ...`). `DB_PATH` butuh restart karena koneksi
SQLite dibuka saat start; sisanya berlaku langsung.

## PM2

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
pm2 logs gmgn-runner-alert
```

## Catatan

- `REPORT_MODE=digest` (default): runner real-time + watchlist tiap
  `REPORT_WINDOW_MINUTES`. `REPORT_MODE=individual`: hanya runner, tanpa watchlist.
- Watchlist dibatasi `WATCHLIST_MAX` token urut vol 5m; sisanya tetap tercatat di
  log (`+N lainnya`).
- Kalau dua token punya simbol sama, label tombolnya diberi pembeda mint
  (`📋 $PEPE ·4Cxj`) supaya tidak tertukar.
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
   - `token/info` 55 detik (fee + volume 5m, dipakai ulang lintas siklus)
   - `token/security` 1 jam (jarang berubah)
   - Meteora TVL 5 menit
5. **Prefilter murah**: `market/rank` sudah memuat `market_cap`,
   `creation_timestamp`, `history_highest_market_cap`. Token yang tidak lolos
   age/MCAP **tidak** memanggil endpoint token sama sekali (cooldown runner
   dicek setelah klasifikasi, supaya watchlist tidak ikut tertahan).
6. **Token yang sudah diketahui jelek dilewati tanpa request**: security dari
   cache dicek lebih dulu, jadi token blacklist/honeypot tidak memakan kuota.
7. **Kegagalan per token diisolasi**: satu 429/timeout tidak membatalkan
   seluruh siklus, dan siklus berikutnya dijadwalkan `POLL_INTERVAL_MS`
   (default 30 detik) **setelah** siklus sebelumnya selesai (tidak menumpuk).

Konsumsi nyata (limit 100, filter penuh, ~10 kandidat):

| Kondisi | Request | Durasi siklus |
|---|---|---|
| Cache kosong (cold) | ~21 | ~22 detik |
| Cache hangat (siklus berikutnya) | 1 (rank saja) | <2 detik |

Steady state ~1–15 request per menit, jauh di bawah ambang.
