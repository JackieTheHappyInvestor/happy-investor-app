export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  try {
    // Pull widest parameters in one call, tier the results in code
    const url = `https://api.rentcast.io/v1/avm/value?address=${encodeURIComponent(address)}&compCount=25&maxRadius=1.5&daysOld=180`;
    const response = await fetch(url, {
      headers: { 'X-Api-Key': process.env.RENTCAST_API_KEY, 'Accept': 'application/json' }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Rentcast API error' });
    }

    const data = await response.json();
    const allComps = Array.isArray(data.comparables) ? data.comparables : [];

    // Tier 1: 90 days within 1 mile
    let tierComps = allComps.filter(c => c.distance != null && c.distance <= 1 && c.daysOld != null && c.daysOld <= 90);
    let compTier = { daysWindow: 90, radiusMiles: 1 };

    // Tier 2: 180 days within 1 mile
    if (tierComps.length < 3) {
      tierComps = allComps.filter(c => c.distance != null && c.distance <= 1 && c.daysOld != null && c.daysOld <= 180);
      compTier = { daysWindow: 180, radiusMiles: 1 };
    }

    // Tier 3: 180 days within 1.5 miles
    if (tierComps.length < 3) {
      tierComps = allComps.filter(c => c.distance != null && c.distance <= 1.5 && c.daysOld != null && c.daysOld <= 180);
      compTier = { daysWindow: 180, radiusMiles: 1.5 };
    }

    // Rentcast pre-sorts by correlation (similarity) descending, keep that order, cap at 5
    const finalComps = tierComps.slice(0, 5).map(c => ({
      address: c.formattedAddress || '',
      price: c.price || 0,
      distance: c.distance || 0,
      daysOld: c.daysOld || 0,
      bedrooms: c.bedrooms || null,
      bathrooms: c.bathrooms || null,
      squareFootage: c.squareFootage || null
    }));

    compTier.count = finalComps.length;

    return res.status(200).json({
      price: data.price || 0,
      priceRangeLow: data.priceRangeLow,
      priceRangeHigh: data.priceRangeHigh,
      subjectProperty: data.subjectProperty || null,
      comparables: finalComps,
      compTier
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch ARV' });
  }
}
