// Learns how many people normally join this server, so the raid alert can
// tell a busy Saturday evening from something going wrong at 4am.
//
// MODEL: joins are counted into aligned 10-minute buckets. Each completed
// bucket is folded into one of 24 hour-of-day slots as an exponentially
// weighted mean and variance, so the baseline tracks the server's daily
// rhythm and drifts with it as the server grows. The alert threshold for
// a given moment is `mean + 3σ` for that hour, floored so a dead-quiet
// server still can't be alerted by a handful of joins.
//
// WHY 10 MINUTES: a 10-second window is empty almost every time it's
// sampled, so a learned mean over it is all floor and no signal. Ten
// minutes is long enough to have a distribution worth learning, and it
// catches the slow raid — thirty accounts trickling in over ten minutes —
// that the fixed 5-in-10s burst rule sails straight past.
//
// Hour slots use the container's clock (UTC on Railway). That only has to
// be consistent with itself, not with anyone's wall clock, since all it
// does is separate "this time of day" from "that time of day".
//
// Persisted per guild as JSONB, cache-first like every other setting:
// reads hit memory, and the write goes to Postgres in the background at
// most once per completed bucket.

const store = require('./store');

const BUCKET_MS = 10 * 60 * 1000;
const HOURS = 24;

// EWMA weight. At 6 observations per hour-slot per day, this gives the
// last few days most of the say while still remembering last week.
const ALPHA = 0.15;

const MIN_SLOT_SAMPLES = 12; // ~2 days before an hour slot is trusted alone
const MIN_POOLED_SAMPLES = 36; // ...before the all-hours pool is trusted
const SIGMA_K = 3;

// A bucket at or above this multiple of the current threshold is treated as
// an event, not as evidence about what's normal, and is not learned from.
const IGNORE_MULTIPLE = 2;

// Never alert below this many joins in ten minutes, however quiet the
// server normally is. Learning can raise the bar, never lower it.
const FLOOR = 6;

// If the bot was down longer than this, the missed buckets are dropped
// rather than folded in as zeros — nobody observed them, and pretending
// they were quiet would drag the baseline down.
const MAX_CATCHUP_BUCKETS = 6;

const live = new Map(); // guildId -> { slots, bucketStart, bucketCount, joins[] }
const loads = new Map(); // guildId -> in-flight load promise

function emptySlots() {
  return Array.from({ length: HOURS }, () => ({ m: 0, v: 0, n: 0 }));
}

// Saved JSON is only as trustworthy as the last version that wrote it, so
// anything malformed falls back to an empty slot rather than poisoning the
// arithmetic with NaN.
function normalizeSlots(saved) {
  const slots = emptySlots();
  if (!saved || !Array.isArray(saved.slots)) return slots;
  for (let h = 0; h < HOURS; h++) {
    const s = saved.slots[h];
    if (!s) continue;
    const m = Number(s.m);
    const v = Number(s.v);
    const n = Number(s.n);
    if (Number.isFinite(m) && Number.isFinite(v) && Number.isFinite(n) && n >= 0) {
      slots[h] = { m: Math.max(0, m), v: Math.max(0, v), n };
    }
  }
  return slots;
}

function bucketStartFor(ts) {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

function entryFor(guildId, now) {
  const existing = live.get(guildId);
  if (existing) return Promise.resolve(existing);
  if (loads.has(guildId)) return loads.get(guildId);

  const p = (async () => {
    const saved = await store.getJoinBaseline(guildId);
    // A concurrent caller may have populated it while we awaited.
    const raced = live.get(guildId);
    if (raced) return raced;
    const entry = {
      slots: normalizeSlots(saved),
      bucketStart: bucketStartFor(now),
      bucketCount: 0,
      joins: [],
    };
    live.set(guildId, entry);
    return entry;
  })().finally(() => loads.delete(guildId));

  loads.set(guildId, p);
  return p;
}

function sigmaOf(slot) {
  return Math.sqrt(Math.max(0, slot.v));
}

function thresholdFrom(mean, sigma) {
  return Math.max(FLOOR, Math.ceil(mean + SIGMA_K * sigma));
}

// Folds one completed bucket into its hour slot.
function fold(entry, hour, count) {
  const slot = entry.slots[hour];
  let capped = count;

  if (slot.n >= MIN_SLOT_SAMPLES) {
    const threshold = thresholdFrom(slot.m, sigmaOf(slot));

    // Wildly anomalous buckets teach nothing at all. Clipping alone isn't
    // enough: a raid sustained over hours walks the clipped mean upward
    // fold by fold, and a three-hour attack was measured moving a dead
    // 03:00 slot's threshold from 6 to 55 — blinding the bot to the next
    // raid at the same hour. Real growth arrives gradually and stays under
    // this multiple; a flood doesn't.
    if (count >= threshold * IGNORE_MULTIPLE) return;

    // Below that, clip at the threshold. Growth is still learned, just no
    // faster than one alarming-but-plausible bucket at a time.
    capped = Math.min(count, threshold);
  }

  const delta = capped - slot.m;
  slot.m += ALPHA * delta;
  slot.v = (1 - ALPHA) * (slot.v + ALPHA * delta * delta);
  slot.n += 1;
}

// Rolls the clock forward, folding every bucket that has completed since
// the last call — including empty ones, so a quiet stretch teaches the
// baseline zeros instead of being skipped.
function advanceEntry(guildId, entry, now) {
  let elapsed = Math.floor((now - entry.bucketStart) / BUCKET_MS);
  if (elapsed <= 0) return false;

  if (elapsed > MAX_CATCHUP_BUCKETS) {
    entry.bucketStart = bucketStartFor(now);
    entry.bucketCount = 0;
    return false;
  }

  while (elapsed > 0) {
    fold(entry, new Date(entry.bucketStart).getHours(), entry.bucketCount);
    entry.bucketStart += BUCKET_MS;
    entry.bucketCount = 0;
    elapsed -= 1;
  }

  // Background write, never awaited — same reasoning as persistField in
  // store.js. Losing the most recent bucket on a crash costs nothing.
  store
    .setJoinBaseline(guildId, { slots: entry.slots })
    .catch((err) => console.error(`Failed to persist join baseline for ${guildId}:`, err.message));
  return true;
}

async function advance(guildId, now = Date.now()) {
  const entry = await entryFor(guildId, now);
  return advanceEntry(guildId, entry, now);
}

// Records a join and returns how many have arrived in the trailing ten
// minutes (a real rolling window, not the aligned learning bucket).
async function noteJoin(guildId, now = Date.now()) {
  const entry = await entryFor(guildId, now);
  advanceEntry(guildId, entry, now);
  entry.bucketCount += 1;
  entry.joins.push(now);
  const cutoff = now - BUCKET_MS;
  if (entry.joins[0] < cutoff) entry.joins = entry.joins.filter((t) => t >= cutoff);
  return entry.joins.length;
}

// What we expect for this hour: the hour's own slot once it has enough
// samples, otherwise all hours pooled, otherwise nothing yet.
function expectationFor(entry, hour) {
  const slot = entry.slots[hour];
  if (slot.n >= MIN_SLOT_SAMPLES) {
    return { mean: slot.m, sigma: sigmaOf(slot), basis: 'hour' };
  }

  let n = 0;
  let mSum = 0;
  let vSum = 0;
  for (const s of entry.slots) {
    n += s.n;
    mSum += s.n * s.m;
    vSum += s.n * s.v;
  }
  if (n >= MIN_POOLED_SAMPLES) {
    return { mean: mSum / n, sigma: Math.sqrt(Math.max(0, vSum / n)), basis: 'pooled' };
  }

  return null;
}

async function assess(guildId, now = Date.now()) {
  const entry = await entryFor(guildId, now);
  const trailing = entry.joins.filter((t) => t >= now - BUCKET_MS).length;
  const expectation = expectationFor(entry, new Date(now).getHours());

  if (!expectation) {
    return { trailing, threshold: FLOOR, exceeded: trailing >= FLOOR, learned: false };
  }

  const threshold = thresholdFrom(expectation.mean, expectation.sigma);
  return {
    trailing,
    threshold,
    exceeded: trailing >= threshold,
    learned: true,
    mean: expectation.mean,
    sigma: expectation.sigma,
    basis: expectation.basis,
  };
}

// Folds completed buckets for every guild on a timer, so quiet stretches
// are learned even though no join event arrives to trigger the roll.
// Called from ClientReady, next to primeVoiceSessions().
function startBaselineTicker(client) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const guild of client.guilds.cache.values()) {
      advance(guild.id, now).catch((err) =>
        console.error(`Join baseline tick failed for ${guild.id}:`, err.message)
      );
    }
  }, BUCKET_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  noteJoin,
  assess,
  advance,
  startBaselineTicker,
  BUCKET_MS,
  FLOOR,
};
