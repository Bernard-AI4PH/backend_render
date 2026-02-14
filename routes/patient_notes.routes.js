import express from 'express';
import { dbPromise } from '../mongo.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProfile } from '../middleware/profile.js';
import { requireStaffForNotes, requireAdmin } from '../middleware/guards.js';
import { ObjectId } from 'mongodb';

const router = express.Router();
router.use(requireAuth);
router.use(attachProfile);

// NOTES RULES (mirrors your Firestore rules):
// - read: any signed-in user
// - create/update: nurse/doctor/admin
// - delete: admin
//
// API CONTRACT (matches Flutter PatientNote model):
// - id (string) mapped from Mongo _id
// - patientId, authorId, authorName, role
// - createdAt, visitDate (ISO strings)
// - vitals (map), noteText (string), flagged (bool)
// - optional edit tracking: updatedAt, updatedBy, updatedByName, isEdited, editHistory

function toClientNote(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id?.toString?.() ?? String(_id), ...rest };
}

function requireNonEmptyNoteText(req, res) {
  const raw = (req.body?.noteText ?? req.body?.text ?? '');
  const noteText = typeof raw === 'string' ? raw.trim() : '';
  if (!noteText) {
    res.status(400).json({ error: 'noteText is required' });
    return null;
  }
  return noteText;
}

router.get('/:patientId/notes', async (req, res) => {
  const db = await dbPromise;
  const notes = await db.collection('patient_notes')
    .find({ patientId: req.params.patientId })
    .sort({ createdAt: -1 })
    .toArray();

  res.json({ notes: notes.map(toClientNote) });
});

router.post('/:patientId/notes', requireStaffForNotes, async (req, res) => {
  const db = await dbPromise;

  const noteText = requireNonEmptyNoteText(req, res);
  if (noteText == null) return;

  const visitDateRaw = req.body?.visitDate;
  const visitDate = visitDateRaw ? new Date(visitDateRaw) : new Date();

  const vitals = (req.body?.vitals && typeof req.body.vitals === 'object') ? req.body.vitals : {};
  const flagged = req.body?.flagged === true;

  const note = {
    patientId: req.params.patientId,
    authorId: req.user.uid,
    authorUid: req.user.uid, // backward compatibility
    authorName: (req.body?.authorName ?? req.profile?.displayName ?? req.profile?.name ?? '').toString(),
    role: (req.profile?.role ?? 'unknown').toString(),
    createdAt: new Date(),
    visitDate,
    vitals,
    noteText,
    flagged,

    // Edit tracking fields
    updatedAt: new Date(),
    updatedBy: req.user.uid,
    updatedByName: (req.body?.authorName ?? req.profile?.displayName ?? req.profile?.name ?? '').toString(),
    isEdited: false,
    editHistory: [],
  };

  const result = await db.collection('patient_notes').insertOne(note);
  const created = { ...note, _id: result.insertedId };
  res.json({ note: toClientNote(created) });
});

router.patch('/:patientId/notes/:noteId', requireStaffForNotes, async (req, res) => {
  const db = await dbPromise;

  const update = {};
  if (req.body?.noteText != null || req.body?.text != null) {
    const raw = (req.body?.noteText ?? req.body?.text ?? '');
    const noteText = typeof raw === 'string' ? raw.trim() : '';
    if (!noteText) return res.status(400).json({ error: 'noteText cannot be empty' });
    update.noteText = noteText;
  }
  if (req.body?.visitDate != null) {
    update.visitDate = new Date(req.body.visitDate);
  }
  if (req.body?.vitals != null && typeof req.body.vitals === 'object') {
    update.vitals = req.body.vitals;
  }
  if (req.body?.flagged != null) {
    update.flagged = req.body.flagged === true;
  }

  // Edit tracking
  update.updatedAt = new Date();
  update.updatedBy = req.user.uid;
  update.updatedByName = (req.profile?.displayName ?? req.profile?.name ?? '').toString();
  update.isEdited = true;

  // Capture old state for editHistory (best-effort)
  const existing = await db.collection('patient_notes').findOne(
    { _id: new ObjectId(req.params.noteId), patientId: req.params.patientId }
  );

  if (existing) {
    const historyEntry = {
      at: new Date(),
      by: req.user.uid,
      byName: (req.profile?.displayName ?? req.profile?.name ?? '').toString(),
      previous: {
        noteText: existing.noteText ?? existing.text ?? '',
        visitDate: existing.visitDate ?? existing.createdAt ?? null,
        vitals: existing.vitals ?? {},
        flagged: existing.flagged ?? false,
      },
    };
    // push history entry + set fields
    await db.collection('patient_notes').updateOne(
      { _id: new ObjectId(req.params.noteId), patientId: req.params.patientId },
      { $set: update, $push: { editHistory: historyEntry } }
    );
  } else {
    await db.collection('patient_notes').updateOne(
      { _id: new ObjectId(req.params.noteId), patientId: req.params.patientId },
      { $set: update }
    );
  }

  res.json({ ok: true });
});

router.delete('/:patientId/notes/:noteId', requireAdmin, async (req, res) => {
  const db = await dbPromise;
  await db.collection('patient_notes').deleteOne(
    { _id: new ObjectId(req.params.noteId), patientId: req.params.patientId }
  );
  res.json({ ok: true });
});

export default router;
