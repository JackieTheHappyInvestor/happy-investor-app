// Stripe webhook handler. Verifies signature, parses events, and syncs subscription state to Supabase.
// IMPORTANT: bodyParser disabled because Stripe signature verification needs the raw request body bytes.

import crypto from 'crypto';

export const config = {
  api: { bodyParser: false }
};

// Read the raw request body as a Buffer for signature verification
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Constant-time string comparison to prevent timing attacks
function safeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Verify Stripe-Signature header against the raw payload using HMAC-SHA256
function verifyStripeSignature(payload, sigHeader, secret, toleranceSeconds = 300) {
  if (!sigHeader || !secret) return false;
  const parts = sigHeader.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    if (!acc[k]) acc[k] = [];
    acc[k].push(v);
    return acc;
  }, {});
  const timestamp = parts.t && parts.t[0];
  const signatures = parts.v1 || [];
  if (!timestamp || signatures.length === 0) return false;
  // Reject events outside the tolerance window (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > toleranceSeconds) return false;
  const signedPayload = `${timestamp}.${payload.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return signatures.some(sig => safeCompare(sig, expected));
}

// Patch a row in Supabase via the REST API using the service role key
async function supabasePatch(table, filterColumn, filterValue, body) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?${filterColumn}=eq.${encodeURIComponent(filterValue)}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    console.error('Supabase patch failed', { table, filterColumn, filterValue, status: response.status, data });
    return null;
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (e) {
    console.error('failed to read raw body', e);
    return res.status(400).json({ error: 'Invalid body' });
  }

  const sigHeader = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!verifyStripeSignature(rawBody, sigHeader, secret)) {
    console.error('webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const type = event.type;
  const obj = event.data && event.data.object;
  if (!obj) return res.status(200).json({ received: true });

  try {
    if (type === 'checkout.session.completed') {
      // First-time purchase. Activate the user's subscription row.
      const userId = obj.client_reference_id || (obj.metadata && obj.metadata.user_id);
      const customerId = obj.customer;
      const subscriptionId = obj.subscription;
      if (!userId) {
        console.error('checkout.session.completed missing user_id', { sessionId: obj.id });
        return res.status(200).json({ received: true });
      }
      await supabasePatch('subscriptions', 'user_id', userId, {
        status: 'active',
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        updated_at: new Date().toISOString()
      });
    } else if (type === 'customer.subscription.updated') {
      // Subscription state changed (renewal, plan change, status change). Sync.
      const userId = obj.metadata && obj.metadata.user_id;
      const newStatus = obj.status === 'active' || obj.status === 'trialing' ? 'active'
        : obj.status === 'past_due' ? 'past_due'
        : obj.status === 'canceled' ? 'canceled'
        : obj.status === 'unpaid' ? 'past_due'
        : 'inactive';
      const periodEnd = obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null;
      if (userId) {
        await supabasePatch('subscriptions', 'user_id', userId, {
          status: newStatus,
          stripe_subscription_id: obj.id,
          current_period_end: periodEnd,
          updated_at: new Date().toISOString()
        });
      } else {
        // Fallback: match by stripe_customer_id if metadata didn't carry through
        await supabasePatch('subscriptions', 'stripe_customer_id', obj.customer, {
          status: newStatus,
          stripe_subscription_id: obj.id,
          current_period_end: periodEnd,
          updated_at: new Date().toISOString()
        });
      }
    } else if (type === 'customer.subscription.deleted') {
      // Subscription canceled (either by user or by Stripe after failed payments).
      const userId = obj.metadata && obj.metadata.user_id;
      const patchBody = {
        status: 'canceled',
        updated_at: new Date().toISOString()
      };
      if (userId) {
        await supabasePatch('subscriptions', 'user_id', userId, patchBody);
      } else {
        await supabasePatch('subscriptions', 'stripe_customer_id', obj.customer, patchBody);
      }
    } else if (type === 'invoice.payment_failed') {
      // Payment didn't clear. Mark past_due so we can prompt the user to update payment method.
      const customerId = obj.customer;
      if (customerId) {
        await supabasePatch('subscriptions', 'stripe_customer_id', customerId, {
          status: 'past_due',
          updated_at: new Date().toISOString()
        });
      }
    }
    // Unknown event types are silently acknowledged. Stripe expects a 2xx within ~10s.
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('webhook processing error', e);
    // Return 200 anyway to prevent Stripe retry storm. We logged it for manual review.
    return res.status(200).json({ received: true, error: 'Processing error logged' });
  }
}
