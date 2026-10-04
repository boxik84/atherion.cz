// Training metrics: heart-rate zones, HRV, calories.

export const ZONES = [
  { id: 1, name: 'Z1 Regenerácia', from: 0.50, color: '#7d8fa3' },
  { id: 2, name: 'Z2 Vytrvalosť',  from: 0.60, color: '#3b9eff' },
  { id: 3, name: 'Z3 Tempo',       from: 0.70, color: '#2fbf71' },
  { id: 4, name: 'Z4 Prah',        from: 0.80, color: '#f5a524' },
  { id: 5, name: 'Z5 Maximum',     from: 0.90, color: '#ef4444' },
];

/** Max HR from profile, falling back to Tanaka formula (208 − 0.7·age). */
export function maxHrOf(athlete) {
  if (athlete?.maxHr) return athlete.maxHr;
  if (athlete?.age) return Math.round(208 - 0.7 * athlete.age);
  return 190;
}

/**
 * Intensity as a fraction. Uses heart-rate reserve (Karvonen) when the athlete
 * has a resting HR set, otherwise % of max HR.
 */
export function intensityOf(hr, athlete) {
  const max = maxHrOf(athlete);
  const rest = athlete?.restHr;
  if (rest && rest < max) return Math.max(0, (hr - rest) / (max - rest));
  return hr / max;
}

/** Heart rate where a given intensity fraction starts (inverse of intensityOf). */
export function hrAtIntensity(pct, athlete) {
  const max = maxHrOf(athlete);
  const rest = athlete?.restHr;
  if (rest && rest < max) return rest + pct * (max - rest);
  return pct * max;
}

/** Zone index 0..5 (0 = below Z1). */
export function zoneOf(hr, athlete) {
  if (!hr) return 0;
  const pct = intensityOf(hr, athlete);
  let z = 0;
  for (const zone of ZONES) if (pct >= zone.from) z = zone.id;
  return z;
}

export function zoneColor(z) {
  return z > 0 ? ZONES[z - 1].color : '#4b5563';
}

/** RMSSD from RR intervals in ms. */
export function rmssd(rr) {
  if (!rr || rr.length < 3) return null;
  let sum = 0;
  for (let i = 1; i < rr.length; i++) {
    const d = rr[i] - rr[i - 1];
    sum += d * d;
  }
  return Math.round(Math.sqrt(sum / (rr.length - 1)));
}

/**
 * Energy expenditure in kcal/min (Keytel et al. 2005, without VO2max).
 * Falls back to a neutral estimate when sex is unknown.
 */
export function kcalPerMinute(hr, athlete) {
  const age = athlete?.age || 30;
  const weight = athlete?.weight || 75;
  const male = (athlete?.sex || 'm') === 'm';
  const kj = male
    ? -55.0969 + 0.6309 * hr + 0.1988 * weight + 0.2017 * age
    : -20.4022 + 0.4472 * hr - 0.1263 * weight + 0.074 * age;
  return Math.max(0, kj / 4.184);
}

export function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** m/s → "m:ss /km" */
export function formatPace(speed) {
  if (!speed || speed < 0.5) return '–';
  const secPerKm = 1000 / speed;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}
