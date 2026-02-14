import express from 'express';
import { dbPromise } from '../mongo.js';
import { requireAuth } from '../middleware/auth.js';
import { attachProfile } from '../middleware/profile.js';
import { requireDoctorOrAdmin, requireAdmin } from '../middleware/guards.js';
import { isAdmin, isDoctor, isNurse, isPatient } from '../middleware/authz.js';
import { ObjectId } from 'mongodb';
import { resolvePatientIds } from '../utils/patient-id-resolver.js';

const router = express.Router();
router.use(requireAuth);
router.use(attachProfile);

// LAB REQUESTS + RESULTS
// Matches Flutter models LabRequest / LabResult.

function toClientId(doc) {
  const { _id, ...rest } = doc;
  return { id: _id?.toString?.() ?? String(_id), ...rest };
}

function toClientLabRequest(doc) {
  const base = toClientId(doc);

  // Flutter model expects `tests` as a *string* (free-text list of tests).
  // Older Mongo docs may have:
  // - `type` (string)
  // - `tests` (array)
  // We normalize everything to a string.
  let testsText = '';
  if (typeof base.tests === 'string') {
    testsText = base.tests;
  } else if (Array.isArray(base.tests)) {
    testsText = base.tests.join(', ');
  } else if (typeof base.type === 'string') {
    testsText = base.type;
  }

  return {
    id: base.id,
    patientId: base.patientId ?? '',
    doctorId: base.doctorId ?? base.requestedByUid ?? '',
    doctorName: base.doctorName ?? base.requestedByName ?? base.requestedByUid ?? '',
    requestedAt: base.requestedAt ?? base.createdAt ?? new Date(),
    tests: testsText,
    clinicalNotes: base.clinicalNotes ?? base.notes ?? '',
    priority: base.priority ?? 'routine',
    status: base.status ?? 'requested',
    updatedAt: base.updatedAt ?? null,
    updatedBy: base.updatedBy ?? null,
    updatedByName: base.updatedByName ?? null,
    isEdited: base.isEdited ?? false,
    editHistory: base.editHistory ?? null,
  };
}

function toClientLabResult(doc) {
  const base = toClientId(doc);
  return {
    id: base.id,
    patientId: base.patientId ?? '',
    labRequestId: base.labRequestId ?? '',
    uploadedById: base.uploadedById ?? base.uploadedByUid ?? '',
    uploadedByName: base.uploadedByName ?? base.uploadedByUid ?? '',
    uploadedByRole: base.uploadedByRole ?? '',
    fileUrl: base.fileUrl ?? null,
    fileName: base.fileName ?? null,
    contentType: base.contentType ?? null,
    notes: base.notes ?? '',
    createdAt: base.createdAt ?? new Date(),
  };
}

// ---------------------------------------------------------------------------
// /patients/:patientId/lab_requests
// ---------------------------------------------------------------------------

router.get('/:patientId/lab_requests', async (req, res) => {
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
      console.log('[LAB_REQUESTS] Resolved patient IDs:', patientIds);
    }
    
    // Build comprehensive query
    const query = {
      $or: patientIds.flatMap(id => [
        { patientId: id },
        { patientUid: id },
      ]),
    };
    
    const list = await db
      .collection('lab_requests')
      .find(query)
      .sort({ requestedAt: -1, createdAt: -1 })
      .toArray();
    
    res.json({ labRequests: list.map(toClientLabRequest) });
  } catch (error) {
    console.error('[LAB_REQUESTS] Error fetching lab requests:', error);
    res.status(500).json({ 
      error: 'Failed to fetch lab requests',
      message: error.message 
    });
  }
});

router.post('/:patientId/lab_requests', requireDoctorOrAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const now = new Date();
    
    const doc = {
      patientId: req.params.patientId,
      doctorId: req.body.doctorId ?? req.user.uid,
      doctorName: req.body.doctorName ?? req.profile?.fullName ?? req.user.uid,
      requestedAt: req.body.requestedAt ? new Date(req.body.requestedAt) : now,
      // Store `tests` as string to match Flutter model.
      tests: (req.body.tests ?? req.body.type ?? '').toString(),
      clinicalNotes: (req.body.clinicalNotes ?? req.body.notes ?? '').toString(),
      priority: (req.body.priority ?? 'routine').toString(),
      status: (req.body.status ?? 'requested').toString(),
      createdAt: now,
      updatedAt: now,
      updatedBy: null,
      updatedByName: null,
      isEdited: false,
      editHistory: [],
    };
    
    const r = await db.collection('lab_requests').insertOne(doc);
    
    console.log(`[LAB_REQUESTS] Created lab request ${r.insertedId} for patient ${req.params.patientId}`);
    
    res.json({ id: r.insertedId.toString() });
  } catch (error) {
    console.error('[LAB_REQUESTS] Error creating lab request:', error);
    res.status(500).json({ 
      error: 'Failed to create lab request',
      message: error.message 
    });
  }
});

router.patch('/:patientId/lab_requests/:labId', requireDoctorOrAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    const now = new Date();

    const update = {
      updatedAt: now,
      updatedBy: req.user.uid,
      updatedByName: req.profile?.fullName ?? req.user.uid,
      isEdited: true,
    };
    
    const fields = ['tests', 'clinicalNotes', 'priority', 'status', 'requestedAt', 'doctorId', 'doctorName'];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body, f)) {
        update[f] = req.body[f];
      }
    }
    
    if (update.requestedAt) update.requestedAt = new Date(update.requestedAt);

    // Normalize to string fields.
    if (Object.prototype.hasOwnProperty.call(update, 'tests')) {
      update.tests = (update.tests ?? '').toString();
    }
    if (Object.prototype.hasOwnProperty.call(update, 'clinicalNotes')) {
      update.clinicalNotes = (update.clinicalNotes ?? '').toString();
    }

    const result = await db.collection('lab_requests').updateOne(
      { _id: new ObjectId(req.params.labId), patientId: req.params.patientId },
      { $set: update, $push: { editHistory: { ...update } } }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Lab request not found' });
    }
    
    console.log(`[LAB_REQUESTS] Updated lab request ${req.params.labId}`);
    
    res.json({ ok: true });
  } catch (error) {
    console.error('[LAB_REQUESTS] Error updating lab request:', error);
    res.status(500).json({ 
      error: 'Failed to update lab request',
      message: error.message 
    });
  }
});

router.delete('/:patientId/lab_requests/:labId', requireAdmin, async (req, res) => {
  try {
    const db = await dbPromise;
    
    const result = await db.collection('lab_requests').deleteOne({
      _id: new ObjectId(req.params.labId),
      patientId: req.params.patientId,
    });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Lab request not found' });
    }
    
    // Also delete associated results
    await db.collection('lab_results').deleteMany({
      patientId: req.params.patientId,
      labRequestId: req.params.labId,
    });
    
    console.log(`[LAB_REQUESTS] Deleted lab request ${req.params.labId} and associated results`);
    
    res.json({ ok: true });
  } catch (error) {
    console.error('[LAB_REQUESTS] Error deleting lab request:', error);
    res.status(500).json({ 
      error: 'Failed to delete lab request',
      message: error.message 
    });
  }
});

// ---------------------------------------------------------------------------
// /patients/:patientId/lab_requests/:labId/results
// ---------------------------------------------------------------------------

function canCreateResult(req) {
  return isAdmin(req.profile) || isDoctor(req.profile) || isNurse(req.profile) || isPatient(req.profile);
}

function canModifyResult(req, existing) {
  if (isAdmin(req.profile) || isDoctor(req.profile)) return true;
  const owner = existing.uploadedById ?? existing.uploadedByUid;
  return (isNurse(req.profile) || isPatient(req.profile)) && owner === req.user.uid;
}

router.get('/:patientId/lab_requests/:labId/results', async (req, res) => {
  try {
    const db = await dbPromise;
    const requestedPatientId = req.params.patientId;
    
    // Resolve all possible patient IDs
    const patientIds = await resolvePatientIds({
      requestedId: requestedPatientId,
      userUid: req.user?.uid,
      profile: req.profile
    });
    
    // Build comprehensive query
    const patientClause = {
      $or: patientIds.flatMap(id => [
        { patientId: id },
        { patientUid: id },
      ]),
    };

    const list = await db
      .collection('lab_results')
      .find({ ...patientClause, labRequestId: req.params.labId })
      .sort({ createdAt: -1 })
      .toArray();
    
    res.json({ results: list.map(toClientLabResult) });
  } catch (error) {
    console.error('[LAB_RESULTS] Error fetching lab results:', error);
    res.status(500).json({ 
      error: 'Failed to fetch lab results',
      message: error.message 
    });
  }
});

router.post('/:patientId/lab_requests/:labId/results', async (req, res) => {
  try {
    if (!canCreateResult(req)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const db = await dbPromise;
    const now = new Date();
    
    const doc = {
      patientId: req.params.patientId,
      labRequestId: req.params.labId,
      uploadedById: req.user.uid,
      uploadedByName: req.profile?.fullName ?? req.user.uid,
      uploadedByRole: req.profile?.role ?? '',
      fileUrl: req.body.fileUrl ?? null,
      fileName: req.body.fileName ?? null,
      contentType: req.body.contentType ?? null,
      notes: req.body.notes ?? '',
      createdAt: now,
      updatedAt: now,
    };
    
    const r = await db.collection('lab_results').insertOne(doc);
    
    console.log(`[LAB_RESULTS] Created lab result ${r.insertedId} for lab request ${req.params.labId}`);
    
    res.json({ id: r.insertedId.toString() });
  } catch (error) {
    console.error('[LAB_RESULTS] Error creating lab result:', error);
    res.status(500).json({ 
      error: 'Failed to create lab result',
      message: error.message 
    });
  }
});

router.patch('/:patientId/lab_requests/:labId/results/:resultId', async (req, res) => {
  try {
    const db = await dbPromise;
    
    const existing = await db.collection('lab_results').findOne({
      _id: new ObjectId(req.params.resultId),
      patientId: req.params.patientId,
      labRequestId: req.params.labId,
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Not found' });
    }
    
    if (!canModifyResult(req, existing)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const update = { updatedAt: new Date() };
    const fields = ['fileUrl', 'fileName', 'contentType', 'notes'];
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body, f)) {
        update[f] = req.body[f];
      }
    }

    await db.collection('lab_results').updateOne(
      { _id: existing._id }, 
      { $set: update }
    );
    
    console.log(`[LAB_RESULTS] Updated lab result ${req.params.resultId}`);
    
    res.json({ ok: true });
  } catch (error) {
    console.error('[LAB_RESULTS] Error updating lab result:', error);
    res.status(500).json({ 
      error: 'Failed to update lab result',
      message: error.message 
    });
  }
});

router.delete('/:patientId/lab_requests/:labId/results/:resultId', async (req, res) => {
  try {
    const db = await dbPromise;
    
    const existing = await db.collection('lab_results').findOne({
      _id: new ObjectId(req.params.resultId),
      patientId: req.params.patientId,
      labRequestId: req.params.labId,
    });
    
    if (!existing) {
      return res.status(404).json({ error: 'Not found' });
    }
    
    if (!canModifyResult(req, existing)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    
    await db.collection('lab_results').deleteOne({ _id: existing._id });
    
    console.log(`[LAB_RESULTS] Deleted lab result ${req.params.resultId}`);
    
    res.json({ ok: true });
  } catch (error) {
    console.error('[LAB_RESULTS] Error deleting lab result:', error);
    res.status(500).json({ 
      error: 'Failed to delete lab result',
      message: error.message 
    });
  }
});

export default router;
