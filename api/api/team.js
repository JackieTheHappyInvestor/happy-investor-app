export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { zip, type } = req.query;
  if (!zip) return res.status(400).json({ error: 'Zip code required' });

  try {
    const query = encodeURIComponent(`${type} near ${zip}`);
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=AIzaSyAQYfLlnpDIx11ZeWK-yl9_Jl9jSEXj3Og`
    );
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch team data' });
  }
}
