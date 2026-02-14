import express from 'express';
import { dbPromise } from '../mongo.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProfile } from '../middleware/profile.js';
import { requireDoctorOrAdmin, requireAdmin } from '../middleware/guards.js';
import { ObjectId } from 'mongodb';
import admin from '../firebase.js';
import { resolvePatientIds } from '../utils/patient-id-resolver.js';

const router = express.Router();
router.use(requireAuth);
router.use(attachProfile);

// PRESCRIPTIONS RULES (mirrors Firestore rules):
// - read: any signed-in user
// - create/update: doctor/admin
// - delete: admin
//
// API CONTRACT (matches Flutter Prescription model):
// - return wrapper { prescriptions: [...] }
// - map Mongo _id -> id (string)

function toClientRx(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return {
    id: _id?.toString?.() ?? String(_id),
    patientId: rest.patientId ?? '',
    doctorId: rest.doctorId ?? rest.prescribedByUid ?? '',
    doctorName: rest.doctorName ?? rest.prescribedByName ?? rest.prescribedByUid ?? '',
    createdAt: rest.createdAt ?? rest.createdAt,
    medication: rest.medication ?? '',
    dosage: rest.dosage ?? '',
    frequency: rest.frequency ?? '',
    duration: rest.duration ?? '',
    instructions: rest.instructions ?? '',
    status: rest.status ?? 'active',
    updatedAt: rest.updatedAt ?? null,
    updatedBy: rest.updatedBy ?? null,
    updatedByName: rest.updatedByName ?? null,
    isEdited: rest.isEdited ?? false,
    editHistory: rest.editHistory ?? null,
  };
}

router.get('/:patientId/prescriptions', async (req, res) => {
  try {
    const db = await dbPromise;
    const requestedPatientId = req.params.patientId;
    
    // Resolve all possible patient IDs
    const patientIds = await resolvePatientIds({
      requestedId: requestedPatientId,
      userUid: req.user?.uid,
      profile: req.profile
    });
    
    // Log for debugging (remove in production)
    if (process.env.DEBUG_PATIENT_IDS === 'true') {
      console.log('[PRESCRIPTIONS] Resolved patient IDs:', patientIds);
    }
    
    // Build comprehensive query
    const query = {
      $or: patientIds.flatMap(id => [
        { patientId: id },
        { patientUid: id },
      ]),
    };
    
    const docs = await db
      .collection('patient_prescriptions')
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();
    
    res.json({ prescriptions: docs.map(toClientRx) });
  } catch (error) {
    console.error('[PRESCRIPTIONS] Error fetching prescriptions:', error);
    res.status(500).json({ 
      error: 'Failed to fetch prescriptions',
      message: error.message 
    });
  }
});

router.post('/:patientId/prescriptions', requireDoctorOrAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const now = new Date();
    
    const doc = {
      patientId: req.params.patientId,
      doctorId: req.body.doctorId ?? req.user.uid,
      doctorName: req.body.doctorName ?? req.profile?.fullName ?? req.user.uid,
      medication: req.body.medication ?? '',
      dosage: req.body.dosage ?? '',
      frequency: req.body.frequency ?? '',
      duration: req.body.duration ?? '',
      instructions: req.body.instructions ?? '',
      status: req.body.status ?? 'active',
      createdAt: now,
      updatedAt: now,
      updatedBy: null,
      updatedByName: null,
      isEdited: false,
      editHistory: [],
    };
    
    const result = await db.collection('patient_prescriptions').insertOne(doc);
    
    console.log(`[PRESCRIPTIONS] Created prescription ${result.insertedId} for patient ${req.params.patientId}`);
    
    res.json({ id: result.insertedId.toString() });
  } catch (error) {
    console.error('[PRESCRIPTIONS] Error creating prescription:', error);
    res.status(500).json({ 
      error: 'Failed to create prescription',
      message: error.message 
    });
  }
});

router.patch('/:patientId/prescriptions/:rxId', requireDoctorOrAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const now = new Date();

    // Business rule:
    // - Admin: can edit anything anytime.
    // - Prescribing doctor (creator): can edit details within 30 minutes; status anytime.
    // - Other prescribers (doctors): can change ONLY status after 24 hours.
    const role = (req.profile?.role ?? '').toLowerCase();
    const isAdmin = role === 'admin';
    const isPrescriberRole = role === 'doctor' || role === 'prescriber' || role === 'provider';

    const existing = await db.collection('patient_prescriptions').findOne({
      _id: new ObjectId(req.params.rxId),
      patientId: req.params.patientId,
    });

    if (!existing) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    // Determine what is being changed.
    const hasAnyField = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
    const mutables = ['medication', 'dosage', 'frequency', 'duration', 'instructions'];
    const isChangingMutable = mutables.some(hasAnyField);
    const isChangingStatus = hasAnyField('status');
    const createdAt = existing.createdAt ? new Date(existing.createdAt) : null;
    const ageMs = createdAt ? (now.getTime() - createdAt.getTime()) : null;
    const within30m = ageMs !== null ? ageMs <= 30 * 60 * 1000 : false;
    const after24h = ageMs !== null ? ageMs >= 24 * 60 * 60 * 1000 : false;

    const prescriberId = existing.doctorId ?? existing.prescribedByUid ?? existing.prescriberId;
    const isPrescriber = prescriberId && String(prescriberId) === String(req.user.uid);

    // No-op
    if (!isChangingMutable && !isChangingStatus) {
      return res.json({ ok: true });
    }

    if (!isAdmin) {
      // Non-admin must be a prescriber role.
      if (!isPrescriberRole) {
        return res.status(403).json({ error: 'Not allowed' });
      }

      if (isPrescriber) {
        // Prescribing doctor: details only within 30m; status anytime.
        if (isChangingMutable && !within30m) {
          return res.status(403).json({
            error: 'Edit window expired',
            message: 'Edit window expired. After 30 minutes, only status can be changed.',
          });
        }
      } else {
        // Other prescribers: status-only after 24h.
        if (isChangingMutable) {
          return res.status(403).json({
            error: 'Not allowed',
            message: 'Only the prescribing doctor can edit medication details.',
          });
        }
        if (isChangingStatus && !after24h) {
          return res.status(403).json({
            error: 'Edit window',
            message: 'Only the prescribing doctor can change status within the first 24 hours.',
          });
        }
      }
    }

    // Build update payload.
    const update = {
      updatedAt: now,
      updatedBy: req.user.uid,
      updatedByName: req.profile?.fullName ?? req.user.uid,
      isEdited: true,
    };
    
    const fields = ['medication', 'dosage', 'frequency', 'duration', 'instructions', 'status'];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body, f)) {
        update[f] = req.body[f];
      }
    }

    const result = await db.collection('patient_prescriptions').updateOne(
      { _id: new ObjectId(req.params.rxId), patientId: req.params.patientId },
      { $set: update, $push: { editHistory: { ...update } } }
    );

    
    console.log(`[PRESCRIPTIONS] Updated prescription ${req.params.rxId}`);
    
    res.json({ ok: true });
  } catch (error) {
    console.error('[PRESCRIPTIONS] Error updating prescription:', error);
    res.status(500).json({ 
      error: 'Failed to update prescription',
      message: error.message 
    });
  }
});

router.delete('/:patientId/prescriptions/:rxId', requireAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    
    const result = await db.collection('patient_prescriptions').deleteOne({
      _id: new ObjectId(req.params.rxId),
      patientId: req.params.patientId,
    });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Prescription not found' });
    }
    
    console.log(`[PRESCRIPTIONS] Deleted prescription ${req.params.rxId}`);
    
    res.json({ ok: true });
  } catch (error) {
    console.error('[PRESCRIPTIONS] Error deleting prescription:', error);
    res.status(500).json({ 
      error: 'Failed to delete prescription',
      message: error.message 
    });
  }
});

export default router;
