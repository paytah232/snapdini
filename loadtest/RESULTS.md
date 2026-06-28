# Snapdini load test
Target: http://localhost:3001  ·  concurrency: 25  ·  ops/stage: 100  ·  sample: 348KB
Host: 4 vCPU · 8.3GB RAM

Demo event: YUWR8C

join             n= 100  avg= 530.2ms  p50= 510.2ms  p95=1009.2ms  max= 1015.4ms  43.1/s
upload           n= 100  avg=5301.4ms  p50=5550.0ms  p95=6946.6ms  max= 7362.0ms  4.6/s
gallery-read     n= 100  avg=  98.1ms  p50=  97.7ms  p95= 125.8ms  max=  138.9ms  230.8/s
media-serve      n= 100  avg=  68.4ms  p50=  72.1ms  p95=  85.1ms  max=   97.9ms  329.9/s
zip-download     n=  20  avg=4697.9ms  p50=4684.4ms  p95=5041.2ms  max= 5041.2ms  1.1/s

## Rough capacity (this 4-vCPU host)
- Sustained uploads: ~4.6/s (each = re-encode + thumbnail via sharp — CPU-bound).
- A typical event peaks at a few uploads/sec; ~2 busy events could run concurrently before uploads queue.
- Reads/serves are far cheaper (see above) and scale with RAM/IO + the 1y immutable cache.
- Scaling lever: uploads. Add vCPU (sharp is CPU-bound) before RAM. Move media to the ZFS pool (done) to keep IO off the system disk.
