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
- Rate limit GMGN mengikuti plan: Free 5/5, Plus 20/20, Pro 50/50. Naikkan `GMGN_RATE_PER_SEC` dan `GMGN_BURST` kalau pakai plan lebih tinggi.
- `DRY_RUN=true` akan mencetak pesan ke log tanpa mengirim ke Telegram.
