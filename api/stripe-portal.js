// Creates a Stripe Customer Portal session so the user can cancel, update payment, or view invoices.
// Accepts: { user_id }
// Returns: { url } to redirect the user to the Stripe-hosted portal

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });

  try {
    // Look up the user's Stripe customer ID from Supabase
    const lookupUrl = `${process.env.SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(user_id)}&select=stripe_customer_id`;
    const lookupResp = await fetch(lookupUrl, {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Accept': 'application/json'
      }
    });
    if (!lookupResp.ok) {
      console.error('supabase lookup failed', { status: lookupResp.status });
      return res.status(500).json({ error: 'Could not look up subscription' });
    }
    const rows = await lookupResp.json();
    const customerId = rows && rows[0] && rows[0].stripe_customer_id;
    if (!customerId) {
      return res.status(404).json({ error: 'No active subscription found for this account' });
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const returnUrl = `${origin}/?portal=return`;

    const params = new URLSearchParams();
    params.append('customer', customerId);
    params.append('return_url', returnUrl);

    const portalResp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const portalData = await portalResp.json();
    if (!portalResp.ok) {
      console.error('Stripe portal error', portalData);
      return res.status(portalResp.status).json({ error: portalData.error?.message || 'Stripe error' });
    }
    return res.status(200).json({ url: portalData.url });
  } catch (e) {
    console.error('portal exception', e);
    return res.status(500).json({ error: 'Failed to create portal session' });
  }
}
