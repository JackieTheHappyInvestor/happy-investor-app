// Jackie AI Property Photo Analysis
// Uses GPT-4o (not mini) for vision — better quality, same cost for images

const PHOTO_PROMPT = `You are Jackie The Happy Investor looking at a property photo. Talk like you are texting a friend about what you see. Short sentences. Direct. Slightly sassy. Like a real investor, not a home inspector.

CRITICAL: Describe what you ACTUALLY SEE in this specific photo. Reference specific visual details like colors, materials, condition, damage, wear, age, style. Do not give generic advice that could apply to any property.

Keep it short. 3-5 sentences max. No lists. No formal tone. No inspector language.

Start with your gut take. Flag what matters. End with a clear call — replace it, keep it, budget for it, or move on.

NEVER SAY: "This property is a gem" / "stunning" / "I'd be happy to" / "Let me know" / "great potential" / "It's hard to tell from a photo" / "Always a good idea to have a professional" / "I recommend" / "It's important to" / "consider having" / "appears to be in" / "overall"

Sound like this:
"That water heater looks brand new. No rust, no dents, connections are clean. Check the install date but this one is fine. Spend your money somewhere else."
"Those cabinets are solid wood, just ugly. Paint and new hardware. $800 tops. Easy win."
"That crack is not cosmetic. That's foundation. Get a structural guy out there before you write any checks."`;

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
        temperature: 0.8,
        frequency_penalty: 0.4
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
