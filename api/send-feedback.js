// Send feedback notification email to Jackie via Resend

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    var body = req.body;
    var rating = body.rating || 0;
    var message = body.message || '';
    var email = body.email || 'Unknown user';
    var stars = '⭐'.repeat(rating);

    var response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY
      },
      body: JSON.stringify({
        from: 'Happy Investor App <onboarding@resend.dev>',
        to: ['hello@jackiethehappyinvestor.com'],
        subject: 'New App Feedback - ' + rating + '/5 Stars',
        html: '<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">' +
          '<h2 style="color:#FF1A8C;margin-bottom:4px">New App Feedback</h2>' +
          '<p style="font-size:28px;margin:8px 0">' + stars + '</p>' +
          '<p style="font-size:14px;color:#666;margin-bottom:16px">Rating: ' + rating + ' out of 5</p>' +
          '<div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-bottom:16px">' +
          '<p style="font-size:14px;color:#333;margin:0;white-space:pre-wrap">' + message + '</p>' +
          '</div>' +
          '<p style="font-size:12px;color:#999">From: ' + email + '</p>' +
          '</div>'
      })
    });

    if (!response.ok) {
      var err = await response.text();
      console.error('Resend error:', err);
      return res.status(200).json({ sent: false });
    }

    return res.status(200).json({ sent: true });
  } catch (e) {
    console.error('Send feedback email error:', e);
    return res.status(200).json({ sent: false });
  }
}
