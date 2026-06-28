# Snapdini capacity & how to test higher throughput

## The one bottleneck: uploads (CPU-bound)
Every upload runs a `sharp` re-encode + thumbnail, which is **CPU-bound**. Everything else
(joins, gallery reads, media serving, zip) is cheap and IO/RAM-bound.

Measured on the current **4 vCPU / 8 GB** VM:
- Uploads: **~4–4.6 photos/sec** sustained (aggregate, whether 1 event or many).
- Joins ~68/s · gallery reads ~190/s · media serve ~330/s — not limiting.

Upload throughput scales **roughly linearly with vCPU** until storage/network become the limit.

## To run the app at higher throughput — grow the VM
| VM size | Expected sustained uploads | ~Simultaneously-busy events* |
|---|---|---|
| 4 vCPU / 8 GB (now) | ~4–5 /s | ~2–3 |
| 8 vCPU / 16 GB | ~9–10 /s | ~6 |
| 16 vCPU / 32 GB | ~18–20 /s | ~12 |
| 32 vCPU / 64 GB | ~36–40 /s | ~25 |

\* assuming a busy event peaks near ~1 upload/sec; most events upload in bursts, so far more
events can *exist* at once than are uploading in the same instant.

What to provision, in priority order:
1. **vCPU** — the direct lever for upload throughput (sharp). Double cores ≈ double uploads/s.
2. **RAM** — budget ~1.5–2 GB/vCPU (decode/encode buffers + Postgres + Node). 16 vCPU → 24–32 GB.
3. **Storage IO** — media already lives on the ZFS pool (`/bigdata`). For heavy upload volume,
   make sure the pool/NFS export sustains the write bandwidth and low latency (NVMe-backed or
   enough spindles); keep Postgres + `./data` on fast local disk.
4. **Network** — ≥1 Gbps. Originals are ~0.3–15 MB each; high concurrency = real bandwidth.

App-side knobs worth adding before pushing very high:
- A **concurrent-sharp limiter** (queue capped at ~vCPU count) so bursts queue instead of
  thrashing the CPU and blowing memory.
- Optionally offload thumbnailing to a worker/queue if you want uploads to ack faster.

## To *test* much higher throughput
1. **Generate load from a separate host**, not the VM under test — `multi.mjs`/`run.mjs` use CPU
   + network themselves and will skew results if co-located. Ideally a well-connected box (or a
   few) in the same network/region.
2. **Raise the test parameters:**
   `node loadtest/multi.mjs https://dev.snapdini.com <events> <guestsPerEvent> <shotsPerGuest> <concurrency>`
   e.g. `... 20 25 4 128` for a heavy run. Bump `<concurrency>` to push the server harder.
3. **Mind the guest cap:** demo events are entitled to **25 guests**, so keep `guestsPerEvent ≤ 25`,
   or test against real events created with higher caps / with billing OFF (`STRIPE_SECRET_KEY`
   unset) so join enforcement doesn't 403.
4. **Watch the VM** during a run (`docker stats`, `htop`): when CPU pins at ~100% across all
   vCPU and upload p95 climbs, that's the ceiling for that size — the number to grow vCPU against.
5. Re-run after each VM resize and update the table above with real figures.
