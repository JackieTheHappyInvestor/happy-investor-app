const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function generateCode(name) {
  // Generate a referral code like "JACKIE-XY7Z"
  const prefix = (name || 'USER').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  return prefix + '-' + suffix;
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { action, user_id, user_name, ref_code } = req.method === 'POST'
      ? req.body
      : req.query;

    // ACTION: get-or-create — get existing referral code or create one
    if (action === 'get-or-create') {
      if (!user_id) return res.status(400).json({ error: 'user_id required' });

      // Find any code this user owns
      const { data: anyCode } = await sb
        .from('referrals')
        .select('referral_code')
        .eq('referrer_id', user_id)
        .limit(1);

      let code;
      if (anyCode && anyCode.length > 0) {
        code = anyCode[0].referral_code;
      } else {
        // Generate new code
        code = generateCode(user_name);
        // Ensure uniqueness
        let attempts = 0;
        while (attempts < 5) {
          const { data: dup } = await sb
            .from('referrals')
            .select('id')
            .eq('referral_code', code)
            .limit(1);
          if (!dup || dup.length === 0) break;
          code = generateCode(user_name);
          attempts++;
        }
        // Insert a "template" row — this is the referrer's code, no referred user yet
        await sb.from('referrals').insert({
          referrer_id: user_id,
          referral_code: code,
          status: 'pending'
        });
      }

      return res.status(200).json({ referral_code: code });
    }

    // ACTION: dashboard — get referral stats for a user
    if (action === 'dashboard') {
      if (!user_id) return res.status(400).json({ error: 'user_id required' });

      const { data: referrals } = await sb
        .from('referrals')
        .select('*')
        .eq('referrer_id', user_id)
        .order('created_at', { ascending: false });

      if (!referrals) return res.status(200).json({ stats: { total: 0, signed_up: 0, subscribed: 0, earned: 0 }, referrals: [] });

      // Filter out the template row (no referred_user_id)
      const actual = referrals.filter(r => r.referred_user_id);
      const stats = {
        total: actual.length,
        signed_up: actual.filter(r => r.status === 'signed_up' || r.status === 'subscribed' || r.status === 'paid_out').length,
        subscribed: actual.filter(r => r.status === 'subscribed' || r.status === 'paid_out').length,
        earned: actual.filter(r => r.status === 'subscribed' || r.status === 'paid_out').reduce((sum, r) => sum + (r.amount || 10), 0),
        paid_out: actual.filter(r => r.status === 'paid_out').reduce((sum, r) => sum + (r.amount || 10), 0)
      };

      return res.status(200).json({ stats, referrals: actual });
    }

    // ACTION: track — record that someone visited with a referral code
    // Called when a new user signs up and has a ref cookie
    if (action === 'track') {
      if (!ref_code) return res.status(400).json({ error: 'ref_code required' });

      // Find the referrer by code
      const { data: refRow } = await sb
        .from('referrals')
        .select('referrer_id, referral_code')
        .eq('referral_code', ref_code.toUpperCase())
        .limit(1);

      if (!refRow || refRow.length === 0) {
        return res.status(404).json({ error: 'Invalid referral code' });
      }

      const referrerId = refRow[0].referrer_id;

      // Don't let users refer themselves
      if (user_id && user_id === referrerId) {
        return res.status(400).json({ error: 'Cannot refer yourself' });
      }

      // Check if this referred user already exists
      if (user_id) {
        const { data: existing } = await sb
          .from('referrals')
          .select('id')
          .eq('referred_user_id', user_id)
          .limit(1);
        if (existing && existing.length > 0) {
          return res.status(200).json({ message: 'Already tracked' });
        }
      }

      // Insert a new referral record
      await sb.from('referrals').insert({
        referrer_id: referrerId,
        referral_code: ref_code.toUpperCase(),
        referred_user_id: user_id || null,
        referred_email: req.body.referred_email || null,
        status: user_id ? 'signed_up' : 'pending'
      });

      return res.status(200).json({ message: 'Referral tracked' });
    }

    return res.status(400).json({ error: 'Invalid action. Use get-or-create, dashboard, or track' });
  } catch (e) {
    console.error('Affiliate error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
