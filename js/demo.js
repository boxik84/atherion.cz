// Simulated sensors so the app can be tried without any hardware.

const PROFILES = [
  { name: 'Demo HRM-Pro 1', rest: 58, base: 128, amp: 32, period: 240, run: true },
  { name: 'Demo HRM-Pro 2', rest: 64, base: 142, amp: 28, period: 180, run: true },
  { name: 'Demo HRM-Dual 3', rest: 55, base: 118, amp: 24, period: 300, run: false },
  { name: 'Demo Forerunner 4', rest: 61, base: 150, amp: 22, period: 200, run: true },
];

export class DemoManager {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.timer = null;
    this.state = [];
  }

  get running() { return !!this.timer; }

  start(count = 4) {
    if (this.timer) return;
    const t0 = performance.now();
    this.state = PROFILES.slice(0, count).map((p, i) => ({
      ...p, id: `demo:${i + 1}`, hr: p.rest + 20, battery: 95 - i * 17, distance: 0,
    }));
    for (const s of this.state) {
      this.onUpdate({ id: s.id, source: 'demo', name: s.name, status: 'connected', battery: s.battery, manufacturer: 'Demo' });
    }
    this.timer = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      for (const s of this.state) {
        const phase = Math.sin((2 * Math.PI * t) / s.period);
        const target = s.base + s.amp * (phase > 0.3 ? 1 : phase < -0.3 ? -0.6 : phase);
        s.hr += (target - s.hr) * 0.08 + (Math.random() - 0.5) * 2;
        const hr = Math.round(s.hr);
        const rrBase = 60000 / hr;
        const rr = [Math.round(rrBase + (Math.random() - 0.5) * 30)];
        const upd = { id: s.id, source: 'demo', name: s.name, hr, rr };
        if (s.run) {
          const speed = 2.2 + (hr - s.rest) / 60 + (Math.random() - 0.5) * 0.15;
          s.distance += speed;
          upd.speed = speed;
          upd.cadence = Math.round(160 + (hr - 120) / 3 + (Math.random() - 0.5) * 4);
          upd.distance = s.distance;
        } else {
          upd.power = Math.round(80 + (hr - s.rest) * 2.2 + (Math.random() - 0.5) * 20);
          upd.cadence = Math.round(85 + (Math.random() - 0.5) * 6);
        }
        this.onUpdate(upd);
      }
    }, 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const s of this.state) this.onUpdate({ id: s.id, source: 'demo', name: s.name, status: 'disconnected' });
    this.state = [];
  }
}
