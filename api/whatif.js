export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { address, bedrooms, bathrooms, originalArv } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  try {
    // Build URL with optional bedroom/bathroom overrides
    let url = `https://api.rentcast.io/v1/avm/value?address=${encodeURIComponent(address)}&compCount=25&maxRadius=1.5&daysOld=180`;
    if (bedrooms) url += `&bedrooms=${encodeURIComponent(bedrooms)}`;
    if (bathrooms) url += `&bathrooms=${encodeURIComponent(bathrooms)}`;

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

    const newArv = data.price || 0;
    if (!newArv) {
      return res.status(404).json({ error: 'No value found for this property with the requested upgrades' });
    }

    // Compute diff vs original ARV if provided
    const original = parseFloat(originalArv) || 0;
    const diff = original ? newArv - original : null;
    const diffPercent = original ? Math.round(((newArv - original) / original) * 100) : null;

    compTier.count = tierComps.length;

    return res.status(200).json({
      newArv,
      originalArv: original || null,
      diff,
      diffPercent,
      priceRangeLow: data.priceRangeLow,
      priceRangeHigh: data.priceRangeHigh,
      subjectProperty: data.subjectProperty || null,
      compTier,
      requestedUpgrades: {
        bedrooms: bedrooms ? parseFloat(bedrooms) : null,
        bathrooms: bathrooms ? parseFloat(bathrooms) : null
      }
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch What If valuation' });
  }
}
