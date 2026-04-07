export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  try {
    const response = await fetch(
      `https://api.rentcast.io/v1/avm/value?address=${encodeURIComponent(address)}`,
      { headers: { 'X-Api-Key': '431cd4db8c294b0eb1180050901e6e39', 'Accept': 'application/json' } }
    );
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ARV data' });
  }
}
