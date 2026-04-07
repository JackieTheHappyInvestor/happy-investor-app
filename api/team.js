export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { zip, type } = req.query;
  if (!zip) return res.status(400).json({ error: 'Zip required' });
  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(type+' '+zip)}&key=${process.env.GOOGLE_PLACES_API_KEY}`
    );
    const data = await response.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch team data' });
  }
}
