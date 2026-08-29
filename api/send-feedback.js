// Send feedback notification email to Jackie via Resend

// Simple in-memory rate limit (resets on cold start, but blocks rapid bursts)
var recentSubmissions = {};
var RATE_LIMIT_WINDOW = 60000; // 1 minute
var RATE_LIMIT_MAX = 3;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    var body = req.body || {};
    var rating = parseInt(body.rating);
    var message = (body.message || '').toString().trim();
    var email = (body.email || '').toString().trim();

    // Validate: rating must be 1-5, message must be non-empty, email must look valid
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Invalid rating' });
    }
    if (!message || message.length < 1 || message.length > 2000) {
      return res.status(400).json({ error: 'Invalid message' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    // Basic rate limiting by IP
    var ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    var now = Date.now();
    if (!recentSubmissions[ip]) recentSubmissions[ip] = [];
    recentSubmissions[ip] = recentSubmissions[ip].filter(function(t) { return now - t < RATE_LIMIT_WINDOW; });
    if (recentSubmissions[ip].length >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    recentSubmissions[ip].push(now);

    var stars = '⭐'.repeat(rating);

    var response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY
      },
      body: JSON.stringify({
        from: 'Happy Investor App <onboarding@resend.dev>',
        to: ['rufuapal1600@gmail.com'],
        subject: 'New App Feedback - ' + rating + '/5 Stars',
        html: '<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">' +
          '<h2 style="color:#FF1A8C;margin-bottom:4px">New App Feedback</h2>' +
          '<p style="font-size:28px;margin:8px 0">' + stars + '</p>' +
          '<p style="font-size:14px;color:#666;margin-bottom:16px">Rating: ' + rating + ' out of 5</p>' +
          '<div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-bottom:16px">' +
          '<p style="font-size:14px;color:#333;margin:0;white-space:pre-wrap">' + message.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>' +
          '</div>' +
          '<p style="font-size:12px;color:#999">From: ' + email.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>' +
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
