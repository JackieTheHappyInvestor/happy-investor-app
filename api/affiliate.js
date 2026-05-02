// Affiliate system API endpoint
// Actions: get-or-create (referral code), dashboard (stats), track (record referral)

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getHeaders() {
  return {
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

async function sbGet(table, query) {
  const r = await fetch(SB_URL + '/rest/v1/' + table + '?' + query, { headers: getHeaders() });
  return r.json();
}

async function sbInsert(table, body) {
  const r = await fetch(SB_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body)
  });
  return r.json();
}

function generateCode(name) {
  var prefix = (name || 'USER').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
  var suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  return prefix + '-' + suffix;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    var params = req.method === 'POST' ? req.body : req.query;
    var action = params.action;
    var user_id = params.user_id;
    var user_name = params.user_name;
    var ref_code = params.ref_code;

    // ACTION: get-or-create
    if (action === 'get-or-create') {
      if (!user_id) return res.status(400).json({ error: 'user_id required' });

      var anyCode = await sbGet('referrals', 'referrer_id=eq.' + encodeURIComponent(user_id) + '&select=referral_code&limit=1');

      var code;
      if (anyCode && anyCode.length > 0) {
        code = anyCode[0].referral_code;
      } else {
        code = generateCode(user_name);
        var attempts = 0;
        while (attempts < 5) {
          var dup = await sbGet('referrals', 'referral_code=eq.' + encodeURIComponent(code) + '&select=id&limit=1');
          if (!dup || dup.length === 0) break;
          code = generateCode(user_name);
          attempts++;
        }
        await sbInsert('referrals', {
          referrer_id: user_id,
          referral_code: code,
          status: 'pending'
        });
      }

      return res.status(200).json({ referral_code: code });
    }

    // ACTION: dashboard
    if (action === 'dashboard') {
      if (!user_id) return res.status(400).json({ error: 'user_id required' });

      var referrals = await sbGet('referrals', 'referrer_id=eq.' + encodeURIComponent(user_id) + '&order=created_at.desc');

      if (!referrals || referrals.length === 0) {
        return res.status(200).json({ stats: { total: 0, signed_up: 0, subscribed: 0, earned: 0, paid_out: 0 }, referrals: [] });
      }

      var actual = referrals.filter(function(r) { return r.referred_user_id; });
      var stats = {
        total: actual.length,
        signed_up: actual.filter(function(r) { return r.status === 'signed_up' || r.status === 'subscribed' || r.status === 'paid_out'; }).length,
        subscribed: actual.filter(function(r) { return r.status === 'subscribed' || r.status === 'paid_out'; }).length,
        earned: actual.filter(function(r) { return r.status === 'subscribed' || r.status === 'paid_out'; }).reduce(function(sum, r) { return sum + (r.amount || 10); }, 0),
        paid_out: actual.filter(function(r) { return r.status === 'paid_out'; }).reduce(function(sum, r) { return sum + (r.amount || 10); }, 0)
      };

      return res.status(200).json({ stats: stats, referrals: actual });
    }

    // ACTION: track
    if (action === 'track') {
      if (!ref_code) return res.status(400).json({ error: 'ref_code required' });

      var refRow = await sbGet('referrals', 'referral_code=eq.' + encodeURIComponent(ref_code.toUpperCase()) + '&select=referrer_id,referral_code&limit=1');

      if (!refRow || refRow.length === 0) {
        return res.status(404).json({ error: 'Invalid referral code' });
      }

      var referrerId = refRow[0].referrer_id;

      if (user_id && user_id === referrerId) {
        return res.status(400).json({ error: 'Cannot refer yourself' });
      }

      if (user_id) {
        var existing = await sbGet('referrals', 'referred_user_id=eq.' + encodeURIComponent(user_id) + '&select=id&limit=1');
        if (existing && existing.length > 0) {
          return res.status(200).json({ message: 'Already tracked' });
        }
      }

      await sbInsert('referrals', {
        referrer_id: referrerId,
        referral_code: ref_code.toUpperCase(),
        referred_user_id: user_id || null,
        referred_email: params.referred_email || null,
        status: user_id ? 'signed_up' : 'pending'
      });

      return res.status(200).json({ message: 'Referral tracked' });
    }

    return res.status(400).json({ error: 'Invalid action. Use get-or-create, dashboard, or track' });
  } catch (e) {
    console.error('Affiliate error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
