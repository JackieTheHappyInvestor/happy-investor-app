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
    // Build base URL with optional property attribute overrides
    let baseParams = `address=${encodeURIComponent(address)}&compCount=25`;
    if (hasOverride) {
      baseParams += `&propertyType=${encodeURIComponent('Single Family')}`;
      if (beds != null) baseParams += `&bedrooms=${beds}`;
      if (baths != null) baseParams += `&bathrooms=${baths}`;
      if (sqft != null) baseParams += `&squareFootage=${sqft}`;
    }
    const apiHeaders = { 'X-Api-Key': process.env.RENTCAST_API_KEY, 'Accept': 'application/json' };

    // Stage 1: narrow search (1.5 miles, 180 days) — preserves accuracy for urban/suburban
    let url = `https://api.rentcast.io/v1/avm/value?${baseParams}&maxRadius=1.5&daysOld=180`;
    let response = await fetch(url, { headers: apiHeaders });
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Rentcast API error' });
    }
    let data = await response.json();
    let allComps = Array.isArray(data.comparables) ? data.comparables : [];

    // Stage 2: if narrow returned fewer than 3 comps, widen to 5 miles / 365 days (rural fallback)
    if (allComps.length < 3) {
      let wideUrl = `https://api.rentcast.io/v1/avm/value?${baseParams}&maxRadius=5&daysOld=365`;
      let wideResp = await fetch(wideUrl, { headers: apiHeaders });
      if (wideResp.ok) {
        let wideData = await wideResp.json();
        let wideComps = Array.isArray(wideData.comparables) ? wideData.comparables : [];
        if (wideComps.length > allComps.length) {
          data = wideData;
          allComps = wideComps;
        }
      }
    }

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

    // Tier 4: 365 days within 3 miles (rural areas, only reached via Stage 2)
    if (tierComps.length < 3) {
      tierComps = allComps.filter(c => c.distance != null && c.distance <= 3 && c.daysOld != null && c.daysOld <= 365);
      compTier = { daysWindow: 365, radiusMiles: 3 };
    }

    // Tier 5: 365 days within 5 miles (very rural, only reached via Stage 2)
    if (tierComps.length < 3) {
      tierComps = allComps.filter(c => c.distance != null && c.distance <= 5 && c.daysOld != null && c.daysOld <= 365);
      compTier = { daysWindow: 365, radiusMiles: 5 };
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

    // ARV estimation: filter comps to approximate "renovated" properties
    // Renovated homes sell for more per sqft. By taking the 70th-95th percentile
    // by price-per-sqft, we approximate what a realtor does when cherry-picking
    // renovated comps. The top 5% is excluded to filter out likely new construction
    // which Jackie's users don't want in their ARV.
    let estimatedARV = null;
    let asIsValue = data.price || 0;
    let arvPricePerSqft = null;
    let arvCompsUsed = 0;
    let avgCompSqft = null;

    const validComps = tierComps.filter(c => c.price > 0 && c.squareFootage > 0);
    const ppsfValues = validComps
      .map((c, i) => ({ ppsf: c.price / c.squareFootage, index: i, comp: c }))
      .sort((a, b) => a.ppsf - b.ppsf);

    if (ppsfValues.length >= 3) {
      // Take 70th to 95th percentile by price-per-sqft
      // This captures "renovated" tier while excluding new builds (top 5%) and distressed (bottom 70%)
      const p70Index = Math.floor(ppsfValues.length * 0.70);
      const p95Index = Math.ceil(ppsfValues.length * 0.95);
      let topTier = ppsfValues.slice(p70Index, p95Index);

      // Ensure we have at least 2 comps in the top tier
      if (topTier.length < 2) {
        // Fall back to top 30% without the new-build exclusion
        const p70 = Math.floor(ppsfValues.length * 0.70);
        topTier = ppsfValues.slice(p70);
      }

      if (topTier.length >= 1) {
        // Average the top-tier ppsf values
        const topPpsfSum = topTier.reduce((acc, v) => acc + v.ppsf, 0);
        arvPricePerSqft = Math.round(topPpsfSum / topTier.length);
        arvCompsUsed = topTier.length;

        // Average sqft of ALL valid comps (used as fallback if subject sqft unknown)
        const sqftSum = validComps.reduce((acc, c) => acc + c.squareFootage, 0);
        avgCompSqft = Math.round(sqftSum / validComps.length);

        // Determine target sqft for ARV calculation
        const targetSqft = sqft != null
          ? sqft
          : (data.subjectProperty && data.subjectProperty.squareFootage
              ? data.subjectProperty.squareFootage
              : avgCompSqft);

        // Two approaches to ARV:
        // 1. Top-tier ppsf × subject sqft
        // 2. Average sale price of top-tier comps (catches sqft mismatch)
        const ppsfDerived = targetSqft ? Math.round(arvPricePerSqft * targetSqft) : null;
        const avgTopPrice = Math.round(topTier.reduce((acc, v) => acc + v.comp.price, 0) / topTier.length);

        // Use whichever is higher — both methods approximate renovated value
        if (ppsfDerived && avgTopPrice) {
          estimatedARV = Math.max(ppsfDerived, avgTopPrice);
        } else {
          estimatedARV = ppsfDerived || avgTopPrice;
        }
      }

      // ARV must be higher than as-is value by definition (post-renovation > current condition)
      // If our filter produces a lower number, the comp pool doesn't have enough
      // differentiation between renovated and as-is sales to estimate reliably
      if (estimatedARV && asIsValue && estimatedARV <= asIsValue) {
        estimatedARV = null;
        arvPricePerSqft = null;
        arvCompsUsed = 0;
      }

      // Also compute median ppsf across ALL comps for reference
      const allMid = Math.floor(ppsfValues.length / 2);
      var medianPpsf = ppsfValues.length % 2 === 0
        ? Math.round((ppsfValues[allMid - 1].ppsf + ppsfValues[allMid].ppsf) / 2)
        : Math.round(ppsfValues[allMid].ppsf);
    }

    return res.status(200).json({
      price: data.price || 0,
      priceRangeLow: data.priceRangeLow,
      priceRangeHigh: data.priceRangeHigh,
      subjectProperty: data.subjectProperty || null,
      comparables: finalComps,
      compTier,
      asIsValue: asIsValue,
      estimatedARV: estimatedARV,
      arvPricePerSqft: arvPricePerSqft,
      arvCompsUsed: arvCompsUsed,
      medianPricePerSqft: typeof medianPpsf !== 'undefined' ? medianPpsf : null
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch ARV' });
  }
}
