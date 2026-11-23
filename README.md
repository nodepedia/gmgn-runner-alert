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
| 🔥 **Runner** | semua filter + `vol 5m >= $30.000` | **real-time**, satu pesan per token |
| 👀 **Watchlist** | semua filter, `$5.000 <= vol 5m < $30.000` | **satu pesan tiap 30 menit** (maks 20 token) |
| — | vol 5m `< $5.000` | tidak dilaporkan (hanya `belowWatchlist` di log) |

Runner punya cooldown `COOLDOWN_MINUTES` (default 60) supaya token yang sedang
ramai tidak di-alert tiap 30 detik. Watchlist **tanpa cooldown**: token yang
masih trending akan muncul lagi di pesan berikutnya.

Runner yang sudah lolos volume masih melewati **Supertrend** (default nyala).
Alert real-time hanya keluar kalau tren **bullish** pada candle terakhir yang
sudah tutup. Bearish tidak dikirim dan **tidak** memulai cooldown. Watchlist
tidak memakai gerbang ini kecuali `SUPERTREND_WATCHLIST=true`.

Enrichment: tag ATH dari `market_cap >= history_highest_market_cap`.

## Alur

```
GMGN /v1/market/rank (interval 5m, limit 100, order volume)   tiap 30 detik
  -> prefilter age + market cap
  -> /v1/token/info      (total_fee, volume_5m)
  -> vol 5m < $5K  ? drop (tidak memakai request Meteora/security)
  -> Meteora DLMM + DAMM v2 (sum tvl, filter >= $20K)
  -> /v1/token/security  (blacklist, honeypot, renounced)
  -> vol 5m >= $30K ? runner
       -> cooldown masih jalan? lewati
       -> Supertrend (OHLCV DLMM pool TVL tertinggi, candle terakhir yang SUDAH TUTUP)
            -> bullish: kirim SEKARANG + tag ST 🟢 bullish, mulai cooldown
            -> bearish: jangan kirim, jangan cooldown (log: supertrend bearish)
            -> tidak ada pool / Meteora gagal: SUPERTREND_ON_ERROR (default skip)
               SUPERTREND_FALLBACK_GMGN=true baru memanggil kline GMGN
     : watchlist -> buffer, kirim tiap 30 menit (maks 20)
                   (SUPERTREND_WATCHLIST=true ikut gerbang yang sama; default mati)
```

Candle Supertrend default dari Meteora DLMM, publik, tanpa API key:

`GET https://dlmm.datapi.meteora.ag/pools/{pool}/ohlcv?timeframe=5m&start_time=&end_time=`

Pool-nya pool **DLMM** dengan TVL tertinggi untuk mint itu. Daftar pool sudah
diambil untuk filter TVL, jadi tidak ada request discovery kedua. DAMM v2
tetap dijumlahkan untuk TVL, tapi tidak punya endpoint OHLCV ini.

Harga candle adalah harga **token X dalam satuan token Y** (harga bin DLMM,
`(1 + binStep/10000)^binId`, sama dengan `current_price`). Satu pool konsisten,
jadi kuotasi SOL atau USDC tidak diubah ke USD. Kalau mint ada di `token_y`,
OHLC dibalik: `open=1/open`, `close=1/close`, `high=1/low`, `low=1/high`.

Meteora menolak rentang terlalu panjang (`100 × 5m` → `time range too large`;
`50 × 5m` berhasil). Candle diambil per potongan paling banyak 50, digabung,
dedupe menurut `timestamp`, lalu diurutkan. Default `SUPERTREND_CANDLES=60`
berarti dua request. Lubang tanpa trade diisi close sebelumnya dan volume 0.
Keputusan memakai candle **terakhir yang sudah tutup**.

`SUPERTREND_SOURCE=gmgn` memakai `GET /v1/market/token_kline` lewat pacer GMGN.
`SUPERTREND_FALLBACK_GMGN` default `false`: kalau tidak ada pool DLMM atau
Meteora gagal, gerbang ikut `SUPERTREND_ON_ERROR` dan tidak menghabiskan kuota
GMGN. ATR period default 10, multiplier 3, timeframe 5m.

## Format alert

**Runner (real-time):**

```
🚀 $FIONA — Runner Alert

MC $2.64M · Vol 5m $92.3K · 🔥ATH · ST 🟢 bullish
[ 📋 Copy CA ] [ GMGN ]
```

Badge `🔥ATH` hanya muncul kalau token berada di ATH. Tag `ST 🟢 bullish`
ditambahkan kalau gerbang Supertrend lolos. Baris `CA:` tidak lagi ditulis
di teks pesan; CA disalin lewat tombol `📋 Copy CA`.

**Watchlist (tiap 30 menit, urut vol 5m):**

```
👀 Watchlist · 9 token · 20:15 WIB
semua filter lolos · $5.0K ≤ vol 5m < $30.0K

1. $USELESS · MC $81.29M · vol $3.9K
2. $ANSEM · MC $31.72M · vol $6.8K

+12 lainnya (tercatat di log)
[ 📋 $USELESS ] [ 📋 $ANSEM ]
```

Tombol `📋` berisi mint token (copy CA), 3 per baris. Kalau dua token punya
simbol sama, labelnya diberi pembeda mint. Umur token, total fee, dan TVL
dipakai sebagai filter tapi tidak ditampilkan.

Watchlist dikirim di batas jam dinding (20:30, 21:00, 21:30), hanya kalau ada
isinya. `REPORT_MODE=individual` mematikan watchlist (hanya runner real-time).

## Setup

```bash
npm install
cp .env.example .env
cp strat.conf.example strat.conf
# isi GMGN_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID di .env
npm run build
npm test                # unit Supertrend, tanpa API dan tanpa menjalankan bot
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
strat.conf reloaded {"file":"/opt/gmgn-runner-alert/strat.conf","keys":37,"changed":1,"errors":0}
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
| filter | `MIN_VOL5M_USD` / `MIN_WATCHLIST_VOL5M_USD` | 30000 / 5000 |
| filter | `MIN_TVL_USD` / `ATH_TOLERANCE` | 20000 / 0.995 |
| runtime | `POLL_INTERVAL_MS` / `MAX_CANDIDATES_PER_CYCLE` / `COOLDOWN_MINUTES` | 30000 / 25 / 60 |
| runtime | `DRY_RUN` / `DB_PATH` | false / data/bot.db |
| cache | `INFO_CACHE_MS` / `SECURITY_CACHE_MS` / `METEORA_CACHE_MS` | 55s / 1h / 5m |
| supertrend | `SUPERTREND_ENABLED` / `SUPERTREND_SOURCE` / `SUPERTREND_FALLBACK_GMGN` | true / meteora / false |
| supertrend | `SUPERTREND_ON_ERROR` / `SUPERTREND_WATCHLIST` | skip / false |
| supertrend | `SUPERTREND_PERIOD` / `SUPERTREND_MULTIPLIER` / `SUPERTREND_TIMEFRAME` | 10 / 3 / 5m |
| supertrend | `SUPERTREND_CANDLES` / `SUPERTREND_CACHE_MS` | 60 / 240000 |
| report | `REPORT_MODE` / `REPORT_WINDOW_MINUTES` / `WATCHLIST_MAX` | digest / 30 / 20 |
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
  `REPORT_WINDOW_MINUTES` (default 30). `REPORT_MODE=individual`: hanya runner, tanpa watchlist.
- Watchlist dibatasi `WATCHLIST_MAX` token urut vol 5m; sisanya tetap tercatat di
  log (`+N lainnya`).
- Kalau dua token punya simbol sama, label tombolnya diberi pembeda mint
  (`📋 $PEPE ·4Cxj`) supaya tidak tertukar.
- State dedupe/cooldown disimpan di `data/bot.db` (SQLite bawaan Node).
- `DRY_RUN=true` akan mencetak pesan ke log tanpa mengirim ke Telegram, tapi state tetap dicatat.
- `npm run warmup` mencatat token trending saat ini tanpa alert, jadi saat pertama kali live tidak ada burst. Runner yang Supertrend-nya bearish tidak di-seed, supaya flip berikutnya tetap bisa mengirim.
- `SUPERTREND_ENABLED=true` (default): runner volume tinggi hanya dikirim saat tren bullish. `false` mengembalikan perilaku lama (tanpa cek tren, tanpa tag).
- `SUPERTREND_SOURCE=meteora` (default) membaca OHLCV DLMM. `gmgn` kembali ke `token_kline`. Fallback GMGN mati kecuali `SUPERTREND_FALLBACK_GMGN=true`.

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
8. **Candle Supertrend** default tidak memakai GMGN. OHLCV Meteora diantri
   satu-satu dengan jeda 250 ms (dua chunk untuk 60 candle). Snapshot candle
   tertutup di-cache sampai bar berikutnya tutup (`SUPERTREND_CACHE_MS`,
   default 240 detik, dipotong lebih awal kalau di-set lebih pendek).
   `token_kline` (bobot 2, lewat `Pacer` GMGN) hanya jalan kalau
   `SUPERTREND_SOURCE=gmgn` atau fallback-nya dinyalakan.

Konsumsi nyata (limit 100, filter penuh, ~10 kandidat):

| Kondisi | Request | Durasi siklus |
|---|---|---|
| Cache kosong (cold) | ~21 | ~22 detik |
| Cache hangat (siklus berikutnya) | 1 (rank saja) | <2 detik |

Steady state ~1–15 request per menit, jauh di bawah ambang.
