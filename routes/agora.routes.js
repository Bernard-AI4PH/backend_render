import express from 'express';
import pkg from 'agora-access-token';

// agora-access-token is CommonJS; in ESM we import the default and destructure.
const { RtcTokenBuilder, RtcRole } = pkg;

const router = express.Router();

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// POST /agora/rtc-token
// Body: { appointmentId: string, uid: number, role: 'publisher'|'subscriber', expireSeconds?: number }
// Returns: { appId, token, channelName, uid, expireAt }
router.post('/rtc-token', async (req, res) => {
  try {
    const appId = requireEnv('AGORA_APP_ID');
    const appCertificate = requireEnv('AGORA_APP_CERTIFICATE');

    const appointmentId = `${req.body.appointmentId ?? ''}`.trim();
    if (!appointmentId) return res.status(400).json({ error: 'appointmentId is required' });

    const uid = Number(req.body.uid);
    if (!Number.isFinite(uid) || uid <= 0) return res.status(400).json({ error: 'uid must be a positive number' });

    const expireSecondsRaw = req.body.expireSeconds ?? 3600;
    const expireSeconds = Math.max(60, Math.min(24 * 3600, Number(expireSecondsRaw) || 3600));
    const expireAt = Math.floor(Date.now() / 1000) + expireSeconds;

    const roleStr = `${req.body.role ?? 'subscriber'}`.toLowerCase();
    const role = roleStr === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;

    // Channel naming convention requested: fausford-<appointmentId>
    const channelName = `fausford-${appointmentId}`;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      role,
      expireAt
    );

    return res.json({ appId, token, channelName, uid, expireAt });
  } catch (e) {
    console.error('agora rtc-token error', e);
    return res.status(500).json({ error: e?.message ?? 'Failed to generate token' });
  }
});

export default router;
