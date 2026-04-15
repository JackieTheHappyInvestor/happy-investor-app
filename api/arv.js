export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { address, bedrooms, bathrooms, squareFootage } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  // Sanitize user-provided property attributes
  const beds = bedrooms && !isNaN(parseFloat(bedrooms)) ? parseFloat(bedrooms) : null;
  const baths = bathrooms && !isNaN(parseFloat(bathrooms)) ? parseFloat(bathrooms) : null;
  const sqft = squareFootage && !isNaN(parseFloat(squareFootage)) ? parseFloat(squareFootage) : null;
  const hasOverride = beds != null || baths != null || sqft != null;

  try {
    // Pull widest parameters in one call, tier the results in code
    let url = `https://api.rentcast.io/v1/avm/value?address=${encodeURIComponent(address)}&compCount=25&maxRadius=1.5&daysOld=180`;
    if (hasOverride) {
      url += `&propertyType=${encodeURIComponent('Single Family')}`;
      if (beds != null) url += `&bedrooms=${beds}`;
      if (baths != null) url += `&bathrooms=${baths}`;
      if (sqft != null) url += `&squareFootage=${sqft}`;
    }
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

    // Cross-check: compute our own ARV from median price-per-sqft of the broader tier
    // This serves as a sanity check on Rentcast's AVM, especially in markets where public records are weak
    let computedPrice = null;
    let pricePerSqftMedian = null;
    let comparablesUsed = 0;
    let avgCompSqft = null;
    const validComps = tierComps.filter(c => c.price > 0 && c.squareFootage > 0);
    const ppsfValues = validComps
      .map(c => c.price / c.squareFootage)
      .sort((a, b) => a - b);
    if (ppsfValues.length >= 3) {
      // Drop the highest 10% and lowest 10% to remove outliers
      const dropCount = Math.floor(ppsfValues.length * 0.1);
      const trimmed = ppsfValues.slice(dropCount, ppsfValues.length - dropCount);
      const mid = Math.floor(trimmed.length / 2);
      pricePerSqftMedian = trimmed.length % 2 === 0
        ? (trimmed[mid - 1] + trimmed[mid]) / 2
        : trimmed[mid];
      comparablesUsed = trimmed.length;
      // Average sqft of comps with valid sqft data (used as a fallback if subject sqft is unknown)
      const sqftSum = validComps.reduce((acc, c) => acc + c.squareFootage, 0);
      avgCompSqft = Math.round(sqftSum / validComps.length);
      // Determine target sqft for our computed price:
      // 1. User-provided sqft (most accurate)
      // 2. Rentcast's auto-looked-up subject property sqft
      // 3. Average sqft of valid comps (proxy for "houses like this in this area")
      const targetSqft = sqft != null
        ? sqft
        : (data.subjectProperty && data.subjectProperty.squareFootage
            ? data.subjectProperty.squareFootage
            : avgCompSqft);
      if (targetSqft) {
        computedPrice = Math.round(pricePerSqftMedian * targetSqft);
      }
    }

    return res.status(200).json({
      price: data.price || 0,
      priceRangeLow: data.priceRangeLow,
      priceRangeHigh: data.priceRangeHigh,
      subjectProperty: data.subjectProperty || null,
      comparables: finalComps,
      compTier,
      computedPrice,
      pricePerSqftMedian: pricePerSqftMedian ? Math.round(pricePerSqftMedian) : null,
      comparablesUsed
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch ARV' });
  }
}
