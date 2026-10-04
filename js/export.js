// Session export: CSV (all athletes) and TCX (per athlete, importable into
// Garmin Connect, Strava, TrainingPeaks …).

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const stamp = (d) => d.toISOString().slice(0, 16).replace(/[:T]/g, '-');
const safe = (s) => s.replace(/[^\p{L}\p{N}_-]+/gu, '_');

/** @param {{startedAt:number, records:{label:string, samples:object[]}[]}} session */
export function exportCsv(session) {
  const rows = ['cas_iso,sekunda,sportovec,tep_bpm,rychlost_ms,kadencia,vykon_w,vzdialenost_m'];
  for (const r of session.records) {
    for (const s of r.samples) {
      rows.push([
        new Date(s.t).toISOString(),
        Math.round((s.t - session.startedAt) / 1000),
        `"${r.label.replace(/"/g, '""')}"`,
        s.hr ?? '',
        s.speed != null ? s.speed.toFixed(2) : '',
        s.cadence ?? '',
        s.power ?? '',
        s.distance != null ? s.distance.toFixed(1) : '',
      ].join(','));
    }
  }
  download(`trening-${stamp(new Date(session.startedAt))}.csv`, rows.join('\n'), 'text/csv');
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function buildTcx(record, startedAt) {
  const samples = record.samples.filter((s) => s.hr || s.speed != null || s.power != null);
  const start = new Date(startedAt).toISOString();
  const last = samples.length ? samples[samples.length - 1] : { t: startedAt };
  const total = Math.max(0, (last.t - startedAt) / 1000);
  const hrs = samples.filter((s) => s.hr).map((s) => s.hr);
  const avg = hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : 0;
  const max = hrs.length ? Math.max(...hrs) : 0;
  const dist = last.distance ?? 0;
  const sport = samples.some((s) => s.speed != null) ? 'Running' : samples.some((s) => s.power != null) ? 'Biking' : 'Other';

  const tps = samples.map((s) => {
    const parts = [`<Time>${new Date(s.t).toISOString()}</Time>`];
    if (s.distance != null) parts.push(`<DistanceMeters>${s.distance.toFixed(1)}</DistanceMeters>`);
    if (s.hr) parts.push(`<HeartRateBpm><Value>${s.hr}</Value></HeartRateBpm>`);
    if (s.cadence != null && sport === 'Biking') parts.push(`<Cadence>${s.cadence}</Cadence>`);
    const ext = [];
    if (s.speed != null) ext.push(`<ns3:Speed>${s.speed.toFixed(3)}</ns3:Speed>`);
    if (s.cadence != null && sport === 'Running') ext.push(`<ns3:RunCadence>${Math.round(s.cadence / 2)}</ns3:RunCadence>`);
    if (s.power != null) ext.push(`<ns3:Watts>${s.power}</ns3:Watts>`);
    if (ext.length) parts.push(`<Extensions><ns3:TPX>${ext.join('')}</ns3:TPX></Extensions>`);
    return `<Trackpoint>${parts.join('')}</Trackpoint>`;
  }).join('\n          ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="${sport}">
      <Id>${start}</Id>
      <Lap StartTime="${start}">
        <TotalTimeSeconds>${total.toFixed(0)}</TotalTimeSeconds>
        <DistanceMeters>${dist.toFixed(1)}</DistanceMeters>
        <Calories>${Math.round(record.kcal || 0)}</Calories>
        ${avg ? `<AverageHeartRateBpm><Value>${avg}</Value></AverageHeartRateBpm>` : ''}
        ${max ? `<MaximumHeartRateBpm><Value>${max}</Value></MaximumHeartRateBpm>` : ''}
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
          ${tps}
        </Track>
      </Lap>
      <Notes>${esc(record.label)} – Atherion Coach</Notes>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}

export function exportTcx(record, startedAt) {
  download(`${safe(record.label)}-${stamp(new Date(startedAt))}.tcx`, buildTcx(record, startedAt), 'application/vnd.garmin.tcx+xml');
}
