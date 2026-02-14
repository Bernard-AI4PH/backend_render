import { getUserProfile } from './authz.js';

export async function attachProfile(req, res, next) {
  try {
    const profile = await getUserProfile(req.user.uid);
    if (!profile) return res.status(403).json({ error: 'No user profile' });
    req.profile = profile;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Failed to load user profile' });
  }
}
