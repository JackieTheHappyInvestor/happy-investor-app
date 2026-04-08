export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { zip, type } = req.query;
  if (!zip) return res.status(400).json({ error: 'Zip required' });
  try {
    const response = await fetch(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount'
        },
        body: JSON.stringify({ textQuery: `${type || ''} ${zip}`.trim() })
      }
    );
    const data = await response.json();
    const results = (data.places || []).map(function (p) {
      return {
        name: p.displayName && p.displayName.text ? p.displayName.text : '',
        formatted_address: p.formattedAddress || '',
        rating: p.rating || null,
        user_ratings_total: p.userRatingCount || 0
      };
    });
    res.status(200).json({ results: results });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch team data' });
  }
}
