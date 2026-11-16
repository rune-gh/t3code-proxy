import { describe, expect, test } from 'bun:test';
import ownerHistory from './fixtures/ownerHistory.json';
import { normalizeQuotaHistory } from '../src/services/api/quotaHistory';
import {
  buildAccountTracks,
  estimateBurnRate,
  HOUR_MS as H,
  remainingAt,
  type AccountTrack,
} from '../src/features/quota/poolModel';

// The former estimator, retained in behavior for a reproducible baseline.
function oldBurn(tracks: readonly AccountTrack[], now: number, hours: number): number {
  const start = now - hours * H;
  let earliest = Infinity;
  let consumed = 0;
  for (const track of tracks) {
    if (!track.points.length || track.points[0].t > now) continue;
    earliest = Math.min(earliest, track.points[0].t);
    const times = [start, now];
    for (const point of track.points) {
      if (point.t > start && point.t <= now) times.push(point.t);
      if (point.resetsAt !== null && point.resetsAt > start && point.resetsAt < now) {
        times.push(point.resetsAt);
      }
    }
    times.sort((a, b) => a - b);
    let previous = remainingAt(track, times[0]);
    for (const t of times.slice(1)) {
      const current = remainingAt(track, t);
      consumed += Math.max(0, previous - current) * track.share;
      previous = current;
    }
  }
  const covered = now - Math.max(start, earliest);
  return covered >= H / 6 ? consumed / (covered / H) : 0;
}

describe('owner-history rolling next-hour backtest', () => {
  const history = normalizeQuotaHistory(ownerHistory);
  // Both estimators use the page's 3h default. Other providers in this fixture
  // have only 1.1h, too little for a 1h warmup followed by a full 1h holdout.
  for (const provider of ['claude', 'codex']) {
    test(`${provider} next-hour MAE does not regress`, () => {
      const truth = buildAccountTracks(history, provider, 'weekly');
      const first = Math.min(...truth.map((track) => track.points[0].t));
      const last = Math.min(...truth.map((track) => track.points.at(-1)!.t));
      const times = [
        ...new Set(truth.flatMap((track) => track.points.map((point) => point.t))),
      ].filter((t) => t >= first + H && t + H <= last);
      let oldError = 0;
      let newError = 0;
      let ready = 0;
      for (const now of times) {
        const prefix = { ...history, now, samples: history.samples.filter((s) => s.t < now) };
        const tracks = buildAccountTracks(prefix, provider, 'weekly');
        const actual = oldBurn(truth, now + H, 1);
        const estimate = estimateBurnRate(tracks, now, 3);
        oldError += Math.abs(oldBurn(tracks, now, 3) - actual);
        // Score the provisional number even while the UI says collecting data.
        // Abstaining must never silently remove a difficult prediction.
        newError += Math.abs(estimate.rate - actual);
        ready += Number(estimate.ready);
      }
      expect(times.length).toBeGreaterThan(0);
      const oldMae = oldError / times.length;
      const newMae = newError / times.length;
      console.log(
        `${provider}: old MAE=${oldMae.toFixed(6)}, new MAE=${newMae.toFixed(6)}, ` +
          `forecasts=${times.length}, ready=${ready} (pool percentage points over 1h)`
      );
      expect(newMae).toBeLessThanOrEqual(oldMae);
    });
  }
});
