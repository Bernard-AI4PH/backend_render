import {
  isAdmin, isDoctor, isNurse, isPatient, isProvider, isVerifiedStaff
} from './authz.js';

export function requireSignedIn(req, res, next) {
  // requireAuth already ran; here just sanity check
  if (!req.user?.uid) return res.status(401).json({ error: 'Not signed in' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!isAdmin(req.profile)) return res.status(403).json({ error: 'Admin only' });
  next();
}

export function requireDoctorOrAdmin(req, res, next) {
  if (!(isAdmin(req.profile) || isDoctor(req.profile))) {
    return res.status(403).json({ error: 'Doctor only' });
  }
  next();
}

export function requireStaffForNotes(req, res, next) {
  if (!(isAdmin(req.profile) || isDoctor(req.profile) || isNurse(req.profile))) {
    return res.status(403).json({ error: 'Staff only' });
  }
  next();
}

export function requireProviderOrAdmin(req, res, next) {
  if (!(isAdmin(req.profile) || isProvider(req.profile))) {
    return res.status(403).json({ error: 'Provider only' });
  }
  next();
}

export function requirePatient(req, res, next) {
  if (!isPatient(req.profile)) return res.status(403).json({ error: 'Patient only' });
  next();
}

export function canReadPatientResource(patientId, req) {
  // Mirrors your Firestore pattern broadly: signed-in can read patients,
  // but we keep it safer for nested resources:
  // admin OR verified staff OR patient self
  if (isAdmin(req.profile) || isVerifiedStaff(req.profile)) return true;
  if (isPatient(req.profile) && req.user.uid === patientId) return true;
  return false;
}

export function requireCanReadPatientResource(paramName='patientId') {
  return (req, res, next) => {
    const pid = req.params[paramName];
    if (!pid) return res.status(400).json({ error: 'Missing patientId' });
    if (!canReadPatientResource(pid, req)) return res.status(403).json({ error: 'Not allowed' });
    next();
  };
}
