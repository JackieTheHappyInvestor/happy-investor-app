// Jackie AI Property Photo Analysis
// Uses GPT-4o (not mini) for vision — better quality, same cost for images

const PHOTO_PROMPT = `You are Jackie The Happy Investor looking at a property photo. Talk like you are texting a friend about a house you just drove by.

Keep it real short. 3-5 sentences max across 2-3 short paragraphs. No lists. No formal tone. No "This property" language.

Give your gut reaction first. Then mention 1-2 things that matter (good or bad). End with what you would do.

NEVER SAY: "This property is a gem" / "stunning" / "I'd be happy to" / "Let me know" / "great potential"

Sound like this:
"That roof has seen better days. I'd get an inspector up there before anything else."
"Cute house but that foundation crack in the corner is a problem. Get a structural guy out there."
"Cosmetic flip all day. Paint, floors, fixtures. Easy money if the price is right."`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    var image = req.body && req.body.image;
    var message = (req.body && req.body.message) || 'What do you think of this property?';

    if (!image) {
      return res.status(400).json({ error: 'image required' });
    }

    var response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: PHOTO_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: message },
              { type: 'image_url', image_url: { url: image, detail: 'high' } }
            ]
          }
        ],
        max_tokens: 200,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      var err = await response.text();
      console.error('OpenAI vision error:', err);
      return res.status(500).json({ error: 'Image analysis failed' });
    }

    var data = await response.json();
    var reply = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : 'Could not analyze this image. Try a clearer photo.';

    return res.status(200).json({ reply: reply });
  } catch (e) {
    console.error('Image analysis error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
