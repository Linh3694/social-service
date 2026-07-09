/**
 * Endpoint admin cho flow sync/revoke membership nhóm chat lớp.
 *
 * Auth: KHÔNG dùng authenticate user thường — so khớp header
 * `Authorization: token <FRAPPE_API_KEY>:<FRAPPE_API_SECRET>` (đúng header các script
 * cron hiện có gửi, xem scripts/sync-users-cron.js).
 */

const { runFullMembershipSync } = require('../services/chatMembershipSync');

function isServiceKeyAuthorized(req) {
  const key = process.env.FRAPPE_API_KEY;
  const secret = process.env.FRAPPE_API_SECRET;
  if (!key || !secret) return false;
  const header = String(req.headers.authorization || '').trim();
  return header === `token ${key}:${secret}`;
}

/**
 * POST /api/social/chat/sync/memberships
 * Body: { classId?, schoolYearId?, dryRun? }
 */
exports.syncChatMemberships = async (req, res) => {
  try {
    if (!isServiceKeyAuthorized(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { classId, schoolYearId } = req.body || {};
    const dryRun = req.body?.dryRun === true || String(req.body?.dryRun) === 'true';

    console.info('[ChatMembershipSync] start', { classId, schoolYearId, dryRun });
    const summary = await runFullMembershipSync({ classId, schoolYearId, dryRun });

    res.json({ success: true, data: summary });
  } catch (error) {
    console.error('[Chat] syncChatMemberships error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Không thể đồng bộ membership nhóm chat',
    });
  }
};
