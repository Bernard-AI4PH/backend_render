import express from 'express';
import { dbPromise } from '../mongo.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProfile } from '../middleware/profile.js';
import { getUserProfile, isAdmin, isDoctor, isNurse, isPatient, isProvider, isVerifiedStaff } from '../middleware/authz.js';
import { ObjectId } from 'mongodb';

const router = express.Router();
router.use(requireAuth);
router.use(attachProfile);

function toClientId(doc) {
  const { _id, ...rest } = doc;
  return { id: _id?.toString?.() ?? String(_id), ...rest };
}

function toClientAppointment(doc) {
  const base = toClientId(doc);
  const patientId = base.patientId ?? base.patientUid ?? '';
  const providerId = base.providerId ?? base.providerUid ?? null;
  return {
    id: base.id,
    patientId,
    patientName: base.patientName ?? '',
    providerId,
    providerName: base.providerName ?? null,
    providerDoxyRoomUrl: base.providerDoxyRoomUrl ?? null,
    reason: base.reason ?? '',
    isVideo: base.isVideo === true,
    specialistLevel: base.specialistLevel ?? 'General',
    specialty: base.specialty ?? null,
    requestedAt: base.requestedAt ?? base.createdAt ?? new Date(),
    scheduledAt: base.scheduledAt ?? null,
    scheduledEndAt: base.scheduledEndAt ?? null,
    requestedStartAt: base.requestedStartAt ?? null,
    requestedEndAt: base.requestedEndAt ?? null,
    status: base.status ?? 'requested',
    channelName: base.channelName ?? `fausford-${base.id}`,
  };
}

function toClientCallLog(doc) {
  const base = toClientId(doc);
  return {
    id: base.id,
    appointmentId: base.appointmentId ?? null,
    patientId: base.patientId ?? base.patientUid ?? null,
    providerId: base.providerId ?? base.providerUid ?? null,
    channelName: base.channelName ?? (base.appointmentId ? `fausford-${base.appointmentId}` : ''),
    isVideo: base.isVideo === true,
    startedAt: base.startedAt ?? base.createdAt ?? new Date(),
    endedAt: base.endedAt ?? null,
    durationSeconds: base.durationSeconds ?? null,
    status: base.status ?? 'started',
    createdAt: base.createdAt ?? new Date(),
    updatedAt: base.updatedAt ?? null,
  };
}

// --- Helpers ---------------------------------------------------------------
// Normalize incoming date values. Returns null for invalid dates.
function safeDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function computeDurationSeconds(startedAt, endedAt) {
  const s = safeDate(startedAt);
  const e = safeDate(endedAt);
  if (!s || !e) return null;
  const diffMs = e.getTime() - s.getTime();
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / 1000);
}

// ============================================================================
// TELEMEDICINE APPOINTMENTS
// Collection: telemedicine_appointments
// Mirrors your Firestore rules for /telemedicineAppointments
// ============================================================================

// LIST/QUERY
router.get('/appointments', async (req, res) => {
  const db = await dbPromise;

  // Admin: all
  if (isAdmin(req.profile)) {
    const list = await db.collection('telemedicine_appointments').find({}).sort({ createdAt: -1 }).toArray();
    return res.json({ appointments: list.map(toClientAppointment) });
  }

  // Patient: own
  if (isPatient(req.profile)) {
    const list = await db.collection('telemedicine_appointments')
      .find({ $or: [{ patientId: req.user.uid }, { patientUid: req.user.uid }] })
      .sort({ createdAt: -1 })
      .toArray();
    return res.json({ appointments: list.map(toClientAppointment) });
  }

  // Provider: assigned OR unassigned requested pool
  if (isProvider(req.profile)) {
    const list = await db.collection('telemedicine_appointments')
      .find({ $or: [
          { providerId: req.user.uid },
          { providerUid: req.user.uid }, // legacy
          { providerId: null, status: 'requested' },
          { providerUid: null, status: 'requested' } // legacy
        ] })
      .sort({ createdAt: -1 })
      .toArray();
    return res.json({ appointments: list.map(toClientAppointment) });
  }

  return res.status(403).json({ error: 'Not allowed' });
});

// PENDING QUEUE (used by provider dashboard)
// Returns requested appointments. Providers see:
// - requests assigned to them
// - optionally unassigned requests (includeUnassigned=true)
router.get('/pending', async (req, res) => {
  const db = await dbPromise;

  if (isAdmin(req.profile)) {
    const list = await db.collection('telemedicine_appointments')
      .find({ status: 'requested' })
      .sort({ createdAt: -1 })
      .toArray();
    return res.json({ appointments: list.map(toClientAppointment) });
  }

  if (!isProvider(req.profile)) return res.status(403).json({ error: 'Not allowed' });

  const includeUnassigned = String(req.query.includeUnassigned ?? 'true') !== 'false';
  const q = includeUnassigned
    ? { status: 'requested' }
    : { status: 'requested', $or: [{ providerId: req.user.uid }, { providerUid: req.user.uid }] };

  const list = await db.collection('telemedicine_appointments')
    .find(q)
    .sort({ createdAt: -1 })
    .toArray();
  return res.json({ appointments: list.map(toClientAppointment) });
});

// CREATE
// - Patient: can create for self only
// - Admin: can create for any patient (patientId required in body)
router.post('/appointments', async (req, res) => {
  const db = await dbPromise;
  const now = new Date();

  const isAdminUser = isAdmin(req.profile);
  const isPatientUser = isPatient(req.profile);

  if (!(isAdminUser || isPatientUser)) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const patientId = isAdminUser
    ? (req.body.patientId ?? req.body.patientUid)
    : req.user.uid;

  if (!patientId) {
    return res.status(400).json({ error: 'patientId is required' });
  }

  // Patients cannot create on behalf of others.
  if (!isAdminUser) {
    const bodyPatient = req.body.patientId ?? req.body.patientUid;
    if (bodyPatient && bodyPatient !== patientId) {
      return res.status(403).json({ error: 'patientId must match auth user' });
    }
  }

  const status = (req.body.status ?? 'requested').toString();
  // Keep creation consistent: new appointments must start as requested.
  if (status !== 'requested') {
    return res.status(400).json({ error: 'status must be requested' });
  }

  const insertedIdPlaceholder = new ObjectId();
  // Channel naming: "fausford-<appointmentId>"
  const channelName = `fausford-${insertedIdPlaceholder.toString()}`;

  let providerDoxyRoomUrl = null;
  const providerIdMaybe = req.body.providerId ?? null;
  if (providerIdMaybe) {
    try {
      const p = await getUserProfile(String(providerIdMaybe));
      const url = (p?.doxyRoomUrl ?? p?.doxyRoomURL ?? p?.doxyUrl ?? p?.doxyURL ?? null);
      if (typeof url === 'string' && url.trim().length > 0) {
        providerDoxyRoomUrl = url.trim();
      }
    } catch (_) {
      // ignore
    }
  }

  const doc = {
    _id: insertedIdPlaceholder,
    patientId,
    patientName: req.body.patientName ?? req.profile?.fullName ?? '',
    providerId: providerIdMaybe,
    providerName: req.body.providerName ?? null,
    providerDoxyRoomUrl,
    reason: req.body.reason ?? '',
    isVideo: req.body.isVideo === true,
    specialistLevel: req.body.specialistLevel ?? 'General',
    specialty: req.body.specialty ?? null,
    requestedAt: now,
    requestedStartAt: req.body.preferredStartAt ? new Date(req.body.preferredStartAt) : (req.body.requestedStartAt ? new Date(req.body.requestedStartAt) : null),
    requestedEndAt: req.body.preferredEndAt ? new Date(req.body.preferredEndAt) : (req.body.requestedEndAt ? new Date(req.body.requestedEndAt) : null),
    scheduledAt: req.body.scheduledAt ? new Date(req.body.scheduledAt) : null,
    scheduledEndAt: req.body.scheduledEndAt ? new Date(req.body.scheduledEndAt) : null,
    status: 'requested',
    channelName,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection('telemedicine_appointments').insertOne(doc);
  res.json({ appointment: toClientAppointment(doc) });
});

// UPDATE
router.patch('/appointments/:id', async (req, res) => {
  const db = await dbPromise;
  const id = new ObjectId(req.params.id);

  // Admin or provider can update any
  if (isAdmin(req.profile) || isProvider(req.profile)) {
    const update = { ...req.body, updatedAt: new Date() };
    // normalize dates
    if (update.scheduledAt) update.scheduledAt = new Date(update.scheduledAt);
    if (update.scheduledEndAt) update.scheduledEndAt = new Date(update.scheduledEndAt);
    if (update.requestedStartAt) update.requestedStartAt = new Date(update.requestedStartAt);
    if (update.requestedEndAt) update.requestedEndAt = new Date(update.requestedEndAt);
    if (update.preferredStartAt && !update.requestedStartAt) update.requestedStartAt = new Date(update.preferredStartAt);
    if (update.preferredEndAt && !update.requestedEndAt) update.requestedEndAt = new Date(update.preferredEndAt);
    // normalize provider field
    if (update.providerUid && !update.providerId) update.providerId = update.providerUid;
    delete update.providerUid;

    // If an appointment is being assigned to a provider, automatically attach
    // the provider's Doxy room URL from their Firestore profile.
    // This allows patients to join the correct provider room after acceptance.
    if (update.providerId) {
      if (!('providerDoxyRoomUrl' in update)) {
        try {
          const p = await getUserProfile(String(update.providerId));
          const url = (p?.doxyRoomUrl ?? p?.doxyRoomURL ?? p?.doxyUrl ?? p?.doxyURL ?? null);
          if (typeof url === 'string' && url.trim().length > 0) {
            update.providerDoxyRoomUrl = url.trim();
          }
        } catch (_) {
          // ignore: appointment update should still succeed
        }
      }
    } else if (update.providerId === null) {
      // Unassigning provider clears the stored room url.
      update.providerDoxyRoomUrl = null;
    }
    delete update.patientId;
    delete update.patientUid; // legacy
    delete update.preferredStartAt;
    delete update.preferredEndAt;

    await db.collection('telemedicine_appointments').updateOne(
      { _id: id },
      { $set: update }
    );
    return res.json({ ok: true });
  }

  // Patient can update only if current status is requested AND stays requested
  if (isPatient(req.profile)) {
    const update = { ...req.body, updatedAt: new Date(), status: 'requested' };
    if (update.scheduledAt) update.scheduledAt = new Date(update.scheduledAt);
    if (update.scheduledEndAt) update.scheduledEndAt = new Date(update.scheduledEndAt);
    if (update.requestedStartAt) update.requestedStartAt = new Date(update.requestedStartAt);
    if (update.requestedEndAt) update.requestedEndAt = new Date(update.requestedEndAt);
    if (update.preferredStartAt && !update.requestedStartAt) update.requestedStartAt = new Date(update.preferredStartAt);
    if (update.preferredEndAt && !update.requestedEndAt) update.requestedEndAt = new Date(update.preferredEndAt);
    delete update.patientId;
    delete update.patientUid; // legacy
    delete update.providerUid;
    delete update.preferredStartAt;
    delete update.preferredEndAt;

    const r = await db.collection('telemedicine_appointments').updateOne(
      { _id: id, status: 'requested', $or: [{ patientId: req.user.uid }, { patientUid: req.user.uid }] },
      { $set: update }
    );

    if (r.matchedCount === 0) return res.status(403).json({ error: 'Not allowed' });
    return res.json({ ok: true });
  }

  return res.status(403).json({ error: 'Not allowed' });
});

// COMPLETE appointment + end active call log (provider/admin)
// This prevents telemedicine_call_logs from having null endedAt/durationSeconds.
router.post('/appointments/:id/complete', async (req, res) => {
  const db = await dbPromise;
  const apptId = new ObjectId(req.params.id);

  const appt = await db.collection('telemedicine_appointments').findOne({ _id: apptId });
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const isAssignedProvider = isProvider(req.profile) && (appt.providerId ?? appt.providerUid) === req.user.uid;
  if (!(isAdmin(req.profile) || isAssignedProvider)) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const now = new Date();

  // 1) Mark appointment completed
  await db.collection('telemedicine_appointments').updateOne(
    { _id: apptId },
    { $set: { status: 'completed', updatedAt: now } }
  );

  // 2) End the latest active call log (if any)
  const active = await db.collection('telemedicine_call_logs').findOne(
    { appointmentId: req.params.id, endedAt: null },
    { sort: { createdAt: -1 } }
  );

  if (active) {
    const durationSeconds = computeDurationSeconds(active.startedAt, now);
    await db.collection('telemedicine_call_logs').updateOne(
      { _id: active._id },
      {
        $set: {
          endedAt: now,
          durationSeconds,
          status: 'ended',
          updatedAt: now,
        },
      }
    );
  }

  return res.json({ ok: true });
});

// PENDING pool endpoint used by Flutter provider dashboard.
// Returns requested appointments (optionally includeUnassigned) for staff.
router.get('/pending', async (req, res) => {
  const db = await dbPromise;
  if (!(isAdmin(req.profile) || isProvider(req.profile))) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const includeUnassigned = `${req.query.includeUnassigned ?? 'true'}` !== 'false';
  const uid = req.user.uid;

  const or = [
    { status: 'requested', providerId: uid },
    { status: 'requested', providerUid: uid },
  ];
  if (includeUnassigned) {
    or.push({ status: 'requested', providerId: null });
    or.push({ status: 'requested', providerUid: null });
  }

  const list = await db.collection('telemedicine_appointments')
    .find({ $or: or })
    .sort({ createdAt: -1 })
    .toArray();
  res.json({ appointments: list.map(toClientAppointment) });
});

// DELETE (admin only)
router.delete('/appointments/:id', async (req, res) => {
  if (!isAdmin(req.profile)) return res.status(403).json({ error: 'Admin only' });
  const db = await dbPromise;
  await db.collection('telemedicine_appointments').deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ ok: true });
});

// ============================================================================
// TELEMEDICINE CALL LOGS
// Collection: telemedicine_call_logs
// Mirrors /telemedicineCallLogs
// ============================================================================

router.get('/call-logs', async (req, res) => {
  const db = await dbPromise;

  if (isAdmin(req.profile)) {
    const list = await db.collection('telemedicine_call_logs').find({}).sort({ createdAt: -1 }).toArray();
    return res.json({ callLogs: list.map(toClientCallLog) });
  }

  if (isPatient(req.profile)) {
    const list = await db.collection('telemedicine_call_logs')
      .find({ $or: [{ patientId: req.user.uid }, { patientUid: req.user.uid }] })
      .sort({ createdAt: -1 })
      .toArray();
    return res.json({ callLogs: list.map(toClientCallLog) });
  }

  if (isProvider(req.profile)) {
    const list = await db.collection('telemedicine_call_logs')
      .find({ $or: [{ providerId: req.user.uid }, { providerUid: req.user.uid }] })
      .sort({ createdAt: -1 })
      .toArray();
    return res.json({ callLogs: list.map(toClientCallLog) });
  }

  res.status(403).json({ error: 'Not allowed' });
});

// CREATE: doctors only; providerUid == auth uid
router.post('/call-logs', async (req, res) => {
  if (!(isAdmin(req.profile) || isDoctor(req.profile))) {
    return res.status(403).json({ error: 'Doctor only' });
  }

  const providerId = req.body.providerId ?? req.body.providerUid ?? req.user.uid;
  if (providerId !== req.user.uid && !isAdmin(req.profile)) {
    return res.status(403).json({ error: 'providerId must match auth user' });
  }

  const db = await dbPromise;
  const doc = {
    patientId: req.body.patientId ?? req.body.patientUid ?? null,
    providerId: req.user.uid,
    appointmentId: req.body.appointmentId ?? null,
    channelName: req.body.channelName ?? (req.body.appointmentId ? `fausford-${req.body.appointmentId}` : ''),
    isVideo: req.body.isVideo === true,
    startedAt: req.body.startedAt ? new Date(req.body.startedAt) : new Date(),
    endedAt: req.body.endedAt ? new Date(req.body.endedAt) : null,
    durationSeconds: req.body.durationSeconds ?? null,
    status: req.body.status ?? 'started',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const r = await db.collection('telemedicine_call_logs').insertOne(doc);
  res.json({ id: r.insertedId.toString() });
});

// UPDATE: admin OR doctor owner
router.patch('/call-logs/:id', async (req, res) => {
  const db = await dbPromise;
  const id = new ObjectId(req.params.id);

  const existing = await db.collection('telemedicine_call_logs').findOne({ _id: id });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const isOwnerDoctor = isDoctor(req.profile) && (existing.providerId ?? existing.providerUid) === req.user.uid;
  if (!(isAdmin(req.profile) || isOwnerDoctor)) return res.status(403).json({ error: 'Not allowed' });

  const update = { ...req.body, updatedAt: new Date() };
  if (update.startedAt) update.startedAt = new Date(update.startedAt);
  if (update.endedAt) update.endedAt = new Date(update.endedAt);

  // If endedAt is being set, compute durationSeconds if not provided.
  // This prevents null duration values in the DB.
  if (update.endedAt && (update.durationSeconds === null || update.durationSeconds === undefined)) {
    const dur = computeDurationSeconds(existing.startedAt, update.endedAt);
    if (dur !== null) update.durationSeconds = dur;
    if (!update.status) update.status = 'ended';
  }

  await db.collection('telemedicine_call_logs').updateOne({ _id: id }, { $set: update });
  res.json({ ok: true });
});

// DELETE: admin
router.delete('/call-logs/:id', async (req, res) => {
  if (!isAdmin(req.profile)) return res.status(403).json({ error: 'Admin only' });
  const db = await dbPromise;
  await db.collection('telemedicine_call_logs').deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ ok: true });
});

// ============================================================================
// TELEMEDICINE PROVIDER AVAILABILITY
// Collection: telemedicine_provider_availability
// Mirrors /telemedicineProviderAvailability
// ============================================================================

// read/list: any signed in
router.get('/availability', async (req, res) => {
  const db = await dbPromise;
  const list = await db.collection('telemedicine_provider_availability')
    .find({})
    .sort({ updatedAt: -1 })
    .toArray();
  res.json(list);
});

// providerId in path
router.get('/availability/:providerId', async (req, res) => {
  const db = await dbPromise;
  const doc = await db.collection('telemedicine_provider_availability')
    .findOne({ $or: [{ providerId: req.params.providerId }, { providerUid: req.params.providerId }] });
  res.json(doc ?? null);
});

// write: provider self OR admin
router.put('/availability/:providerId', async (req, res) => {
  const providerId = req.params.providerId;

  if (!(isAdmin(req.profile) || (isProvider(req.profile) && providerId === req.user.uid))) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const db = await dbPromise;
  // Sanitize slots payload. Prevents persisting empty objects like [{}]
  // and enforces a predictable schema.
  const rawSlots = Array.isArray(req.body.slots) ? req.body.slots : [];
  const cleanSlots = rawSlots
    .filter((s) => s && typeof s === 'object' && !Array.isArray(s))
    .map((s) => {
      const out = {};

      // weekly schedule object
      if (s.weekly && typeof s.weekly === 'object' && !Array.isArray(s.weekly)) {
        out.weekly = s.weekly;
      }

      // optional tags
      if (Array.isArray(s.specialties)) out.specialties = s.specialties;
      if (typeof s.providerLevel === 'string') out.providerLevel = s.providerLevel;

      // explicit calendar slots (if your UI uses them)
      const cal = Array.isArray(s.calendarSlots) ? s.calendarSlots : [];
      const cleanCal = cal
        .filter((x) => x && typeof x === 'object')
        .filter((x) => x.startAt && x.endAt)
        .map((x) => ({
          ...x,
          startAt: new Date(x.startAt),
          endAt: new Date(x.endAt),
        }))
        .filter((x) => Number.isFinite(x.startAt.getTime()) && Number.isFinite(x.endAt.getTime()));
      if (cleanCal.length) out.calendarSlots = cleanCal;

      return out;
    })
    .filter((s) => Object.keys(s).length > 0);

  const doc = {
    providerId,
    slots: cleanSlots,
    updatedAt: new Date(),
    updatedByUid: req.user.uid,
  };

  await db.collection('telemedicine_provider_availability').updateOne(
    { $or: [{ providerId: providerId }, { providerUid: providerId }] },
    { $set: doc, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );

  res.json({ ok: true });
});

router.delete('/availability/:providerId', async (req, res) => {
  const providerId = req.params.providerId;

  if (!(isAdmin(req.profile) || (isProvider(req.profile) && providerId === req.user.uid))) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const db = await dbPromise;
  await db.collection('telemedicine_provider_availability').deleteOne({ $or: [{ providerId: providerId }, { providerUid: providerId }] });
  res.json({ ok: true });
});

// ============================================================================
// OPEN SLOTS (derived from availability + excludes bookings)
//
// Patients pick from open slots when requesting a telemedicine appointment.
// The backend generates slots from the provider's published availability
// (calendarSlots preferred, otherwise weekly schedule), splits into fixed
// intervals (default 20 minutes), and removes any slot that overlaps an
// existing appointment for that provider that is not cancelled/completed.
//
// GET /telemedicine/open-slots/:providerId?from=ISO&to=ISO&minutes=20
//
router.get('/open-slots/:providerId', async (req, res) => {
  const db = await dbPromise;
  const providerId = String(req.params.providerId);

  const minutes = Math.max(5, Math.min(180, parseInt(String(req.query.minutes ?? '20'), 10) || 20));

  const now = new Date();
  const from = safeDate(req.query.from) ?? now;
  // Default horizon: next 14 days.
  const to = safeDate(req.query.to) ?? new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  if (!to || !from || !to.getTime || !from.getTime) {
    return res.status(400).json({ error: 'Invalid from/to' });
  }
  if (to.getTime() <= from.getTime()) {
    return res.status(400).json({ error: '`to` must be after `from`' });
  }

  // 1) Load provider availability doc
  const av = await db.collection('telemedicine_provider_availability')
    .findOne({ $or: [{ providerId }, { providerUid: providerId }] });

  const uiMap = (av?.slots && Array.isArray(av.slots) && av.slots[0] && typeof av.slots[0] === 'object')
    ? av.slots[0]
    : null;

  if (!uiMap) {
    return res.json({ slots: [] });
  }

  // Helper: normalize to day key expected by UI weekly map.
  const dayKeyFor = (d) => {
    switch (d.getDay()) {
      case 1: return 'Mon';
      case 2: return 'Tue';
      case 3: return 'Wed';
      case 4: return 'Thu';
      case 5: return 'Fri';
      case 6: return 'Sat';
      case 0: return 'Sun';
      default: return 'Mon';
    }
  };

  // 2) Build availability windows (calendarSlots first, else weekly)
  const windows = [];
  const cal = Array.isArray(uiMap.calendarSlots) ? uiMap.calendarSlots : [];
  for (const s of cal) {
    const st = safeDate(s?.startAt ?? s?.start);
    const en = safeDate(s?.endAt ?? s?.end);
    if (!st || !en) continue;
    // Only consider overlap with requested range.
    const clampedStart = st.getTime() < from.getTime() ? from : st;
    const clampedEnd = en.getTime() > to.getTime() ? to : en;
    if (clampedEnd.getTime() > clampedStart.getTime()) {
      windows.push({ start: clampedStart, end: clampedEnd });
    }
  }

  if (windows.length === 0) {
    const weekly = uiMap.weekly;
    if (weekly && typeof weekly === 'object') {
      // Walk days between from..to
      const startDay = new Date(from.getFullYear(), from.getMonth(), from.getDate());
      const endDay = new Date(to.getFullYear(), to.getMonth(), to.getDate());
      for (let d = new Date(startDay); d.getTime() <= endDay.getTime(); d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
        const cfg = weekly[dayKeyFor(d)];
        if (!cfg || typeof cfg !== 'object') continue;
        if (cfg.enabled !== true) continue;

        const parseHm = (v) => {
          const s = String(v ?? '').trim();
          const parts = s.split(':');
          if (parts.length !== 2) return null;
          const h = parseInt(parts[0], 10);
          const m = parseInt(parts[1], 10);
          if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
          return { h: Math.max(0, Math.min(23, h)), m: Math.max(0, Math.min(59, m)) };
        };

        const st = parseHm(cfg.start);
        const en = parseHm(cfg.end);
        if (!st || !en) continue;
        const wStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), st.h, st.m);
        const wEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), en.h, en.m);
        if (wEnd.getTime() <= wStart.getTime()) continue;

        const clampedStart = wStart.getTime() < from.getTime() ? from : wStart;
        const clampedEnd = wEnd.getTime() > to.getTime() ? to : wEnd;
        if (clampedEnd.getTime() > clampedStart.getTime()) {
          windows.push({ start: clampedStart, end: clampedEnd });
        }
      }
    }
  }

  // 3) Load booked intervals for provider (requested/upcoming/inProgress)
  const activeStatuses = ['requested', 'upcoming', 'scheduled', 'inProgress', 'in_progress', 'in-progress'];
  const appts = await db.collection('telemedicine_appointments')
    .find({
      $or: [{ providerId }, { providerUid: providerId }],
      status: { $in: activeStatuses },
      $or: [
        { scheduledAt: { $gte: from, $lt: to } },
        { requestedStartAt: { $gte: from, $lt: to } },
      ],
    })
    .project({ scheduledAt: 1, scheduledEndAt: 1, requestedStartAt: 1, requestedEndAt: 1 })
    .toArray();

  const bookings = [];
  for (const a of appts) {
    const st = safeDate(a.scheduledAt) ?? safeDate(a.requestedStartAt);
    if (!st) continue;
    const en = safeDate(a.scheduledEndAt) ?? safeDate(a.requestedEndAt) ?? new Date(st.getTime() + minutes * 60 * 1000);
    if (!en) continue;
    bookings.push({ start: st, end: en });
  }

  const overlaps = (aStart, aEnd, bStart, bEnd) => aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();

  // 4) Generate slots and exclude overlaps
  const out = [];
  const stepMs = minutes * 60 * 1000;
  for (const w of windows) {
    let cursor = new Date(w.start);
    // Round cursor up to the next interval boundary to keep clean 20-min starts.
    const minute = cursor.getMinutes();
    const mod = minute % minutes;
    if (mod !== 0) {
      cursor = new Date(cursor.getTime() + (minutes - mod) * 60 * 1000);
      cursor.setSeconds(0, 0);
    } else {
      cursor.setSeconds(0, 0);
    }

    while (cursor.getTime() + stepMs <= w.end.getTime()) {
      const end = new Date(cursor.getTime() + stepMs);
      if (end.getTime() <= now.getTime()) {
        cursor = end;
        continue;
      }
      let blocked = false;
      for (const b of bookings) {
        if (overlaps(cursor, end, b.start, b.end)) { blocked = true; break; }
      }
      if (!blocked) {
        out.push({ startAt: cursor.toISOString(), endAt: end.toISOString() });
      }
      cursor = end;
    }
  }

  // Sort output chronologically.
  out.sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0));
  return res.json({ minutes, slots: out });
});

export default router;
