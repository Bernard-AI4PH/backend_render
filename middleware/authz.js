import admin from '../firebase.js';

export async function getUserProfile(uid) {
  const snap = await admin.firestore().doc(`users/${uid}`).get();
  if (!snap.exists) return null;
  return snap.data();
}

export function isAdmin(u) { return u?.role === 'admin'; }
export function isDoctor(u) { return u?.role === 'doctor'; }
export function isNurse(u) { return u?.role === 'nurse'; }
export function isPatient(u) { return u?.role === 'patient'; }
export function isProvider(u) { return isDoctor(u) || isNurse(u); }

export function isVerifiedStaff(u) {
  return !!u
    && ['admin','doctor','nurse'].includes(u.role)
    && u.isVerified === true
    && u.isActive === true;
}
