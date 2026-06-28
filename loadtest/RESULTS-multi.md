# Snapdini multi-event stress test
Target: http://localhost:3001  ·  20 events × 2 guests × 8 shots  ·  concurrency: 32  ·  sample: 348KB
Host: 4 vCPU · 8.3GB RAM

Created 20/20 events: ZXZ3LXPL, 6HD8TC78, RCK2LARY, P7M37LQT, P9MRQY9Q, 9U5FDL9V, JAQ5XV56, MHVLJAQM, RRFRV8KM, V6SKT5BZ, NQL9QVFT, 4TDMDKBY, CR68XREA, 5K2C3DS6, E5D846M8, Q95A3ADM, M7QBCQFD, 2XR9CEJL, P3WZU7EV, WMLCNZCB

join             n=   40  avg= 186.1ms  p50= 179.4ms  p95= 262.4ms  max=  263.7ms  130.0/s  errors=1
upload           n=  312  avg=7119.0ms  p50=7058.2ms  p95=8683.3ms  max= 9117.1ms  4.4/s  ok=312 errors=0
gallery-read     n=   60  avg=  87.2ms  p50=  96.8ms  p95= 119.8ms  max=  131.1ms  288.4/s  errors=0

## Result
- 20 concurrent events · 40 guest-joins · 312 photos uploaded.
- Aggregate upload throughput: **4.4 photos/s** across all events (p95 8683.3ms).
- Upload error rate: 0.0%  (joins 1, reads 0).

## Rough capacity (this 4-vCPU host)
- Uploads are the bottleneck (sharp re-encode + thumbnail, CPU-bound).
- At ~1 upload/s per busy event, this box sustains roughly **3 simultaneously-busy events** before uploads start queuing.
- Far more events can exist concurrently if they're not all uploading at the same instant (the realistic case).
- Scaling lever: add vCPU first (CPU-bound), cap concurrent sharp jobs if needed, keep media on the ZFS pool. Reads/serves stay cheap.
