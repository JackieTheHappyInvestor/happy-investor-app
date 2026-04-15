// Creates a Stripe Checkout session for Happy Investor Pro subscription
// Accepts: { plan: 'monthly' | 'annual', user_id, email }
// Returns: { url } to redirect the user to Stripe-hosted checkout

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { plan, user_id, email } = req.body || {};
  if (!plan || !user_id || !email) {
    return res.status(400).json({ error: 'plan, user_id, and email are required' });
  }
  if (plan !== 'monthly' && plan !== 'annual') {
    return res.status(400).json({ error: 'plan must be monthly or annual' });
  }

  const priceId = plan === 'annual' ? process.env.STRIPE_PRICE_ANNUAL : process.env.STRIPE_PRICE_MONTHLY;
  if (!priceId) return res.status(500).json({ error: 'Price not configured' });

  const origin = req.headers.origin || `https://${req.headers.host}`;
  const successUrl = `${origin}/?checkout=success`;
  const cancelUrl = `${origin}/?checkout=cancel`;

  // Build form-encoded body for Stripe API
  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);
  params.append('customer_email', email);
  params.append('client_reference_id', user_id);
  params.append('metadata[user_id]', user_id);
  params.append('metadata[plan]', plan);
  params.append('subscription_data[metadata][user_id]', user_id);
  params.append('subscription_data[metadata][plan]', plan);
  params.append('allow_promotion_codes', 'true');

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Stripe checkout error', data);
      return res.status(response.status).json({ error: data.error?.message || 'Stripe error' });
    }
    return res.status(200).json({ url: data.url, session_id: data.id });
  } catch (e) {
    console.error('checkout exception', e);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}
