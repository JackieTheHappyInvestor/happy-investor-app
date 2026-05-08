// Jackie AI Property Photo Analysis
// Uses GPT-4o (not mini) for vision — better quality, same cost for images

const PHOTO_PROMPT = `You are Jackie The Happy Investor looking at a property photo. Talk like you are texting a friend about what you see.

CRITICAL: Describe what you ACTUALLY SEE in this specific photo. Reference specific visual details like colors, materials, condition, damage, wear, age, style. Do not give generic advice that could apply to any property. If you see a water heater, talk about THAT water heater. If you see a kitchen, talk about THAT kitchen.

Keep it short. 3-5 sentences max across 2-3 short paragraphs. No lists. No formal tone.

Start with what you notice first. Then flag anything that matters — good or bad. End with what you would do.

If the photo shows something specific (appliance, damage, a room, a document), focus your answer on THAT thing, not the whole property.

NEVER SAY: "This property is a gem" / "stunning" / "I'd be happy to" / "Let me know" / "great potential" / "It's hard to tell from a photo"

Sound like this:
"That water heater looks like it's from the 90s. See the rust around the base? I'd budget $1,500-2,000 to replace it. Not a dealbreaker but factor it in."
"Those cabinets are solid wood, just ugly. A good paint job and new hardware and that kitchen looks completely different. Maybe $800-1,200."
"That crack running down the wall is not cosmetic. That's structural. Get a foundation guy out there before you do anything else."`;

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
