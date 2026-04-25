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
    // But first filter out new construction from display comps too
    const displayComps = tierComps.filter(c => {
      if (c.listingType && c.listingType.toLowerCase().includes('new construction')) return false;
      return true;
    });
    const finalComps = displayComps.slice(0, 5).map(c => ({
      address: c.formattedAddress || '',
      price: c.price || 0,
      distance: c.distance || 0,
      daysOld: c.daysOld || 0,
      bedrooms: c.bedrooms || null,
      bathrooms: c.bathrooms || null,
      squareFootage: c.squareFootage || null
    }));

    compTier.count = finalComps.length;

    // --- ARV ESTIMATION v2 ---
    // Uses three filters the old version didn't:
    // 1. Exclude new construction (listingType flag)
    // 2. Exclude comps outside ±20% sqft of subject (Fannie Mae appraisal standard)
    // 3. Weight surviving comps by Rentcast's correlation score
    let estimatedARV = null;
    let arvLow = null;
    let arvHigh = null;
    let asIsValue = data.price || 0;
    let arvPricePerSqft = null;
    let arvCompsUsed = 0;

    // Determine subject sqft
    const subjectSqft = sqft != null
      ? sqft
      : (data.subjectProperty && data.subjectProperty.squareFootage
          ? data.subjectProperty.squareFootage
          : null);

    // Step 1: Start with comps that have valid price and sqft
    let arvComps = tierComps.filter(c => c.price > 0 && c.squareFootage > 0);

    // Step 2: Exclude new construction
    arvComps = arvComps.filter(c => {
      if (c.listingType && c.listingType.toLowerCase().includes('new construction')) return false;
      return true;
    });

    // Step 3: Exclude comps outside ±20% sqft of subject (if we know subject sqft)
    if (subjectSqft) {
      const sqftLow = subjectSqft * 0.80;
      const sqftHigh = subjectSqft * 1.20;
      const sqftFiltered = arvComps.filter(c => c.squareFootage >= sqftLow && c.squareFootage <= sqftHigh);
      // Only apply filter if we retain at least 3 comps
      if (sqftFiltered.length >= 3) {
        arvComps = sqftFiltered;
      }
    }

    // Step 4: Cap at 8 most similar comps (Rentcast pre-sorts by correlation)
    if (arvComps.length > 8) {
      arvComps = arvComps.slice(0, 8);
    }

    // Step 5: Compute weighted ARV using Rentcast's correlation score
    if (arvComps.length >= 3) {
      const weighted = arvComps.map(c => {
        const ppsf = c.price / c.squareFootage;
        const w = (c.correlation != null && c.correlation > 0) ? c.correlation : 0.5;
        return { ppsf, weight: w, price: c.price, comp: c };
      });

      // Sort by ppsf for percentile calculations
      weighted.sort((a, b) => a.ppsf - b.ppsf);

      // Weighted median ppsf
      const totalWeight = weighted.reduce((s, v) => s + v.weight, 0);
      let cumWeight = 0;
      let medianPpsfW = weighted[weighted.length - 1].ppsf;
      for (let i = 0; i < weighted.length; i++) {
        cumWeight += weighted[i].weight;
        if (cumWeight >= totalWeight * 0.5) {
          medianPpsfW = weighted[i].ppsf;
          break;
        }
      }

      // Take top tier (above median ppsf) as "renovated" proxy
      const topTier = weighted.filter(v => v.ppsf >= medianPpsfW);
      if (topTier.length >= 1) {
        // Weighted average ppsf of top tier
        const topWeightSum = topTier.reduce((s, v) => s + v.weight, 0);
        const topPpsfWeighted = topTier.reduce((s, v) => s + v.ppsf * v.weight, 0) / topWeightSum;
        arvPricePerSqft = Math.round(topPpsfWeighted);
        arvCompsUsed = topTier.length;

        // Compute ARV point estimate
        // Check if subject sqft is suspiciously different from comp average
        // (Rentcast sometimes has incorrect sqft in public records)
        const avgCompSqft = Math.round(arvComps.reduce((s, c) => s + c.squareFootage, 0) / arvComps.length);
        let targetSqft = subjectSqft || avgCompSqft;
        
        // If subject sqft is more than 40% off from comp average, use comp average
        // (e.g., Rentcast says 672 sqft for a 3bd house when comps are 1200+ sqft)
        let sqftSuspect = false;
        if (subjectSqft && avgCompSqft) {
          const sqftRatio = subjectSqft / avgCompSqft;
          if (sqftRatio < 0.6 || sqftRatio > 1.6) {
            targetSqft = avgCompSqft;
            sqftSuspect = true;
          }
        }

        // Method 1: weighted top-tier ppsf × target sqft
        const ppsfDerived = Math.round(topPpsfWeighted * targetSqft);
        
        // Method 2: weighted median sale price of top-tier comps
        // Median is more robust against outlier comps pulling the number up
        const topSorted = topTier.slice().sort((a, b) => a.price - b.price);
        const topTotalW = topSorted.reduce((s, v) => s + v.weight, 0);
        let topCumW = 0;
        let medianTopPrice = topSorted[Math.floor(topSorted.length / 2)].price;
        for (let i = 0; i < topSorted.length; i++) {
          topCumW += topSorted[i].weight;
          if (topCumW >= topTotalW * 0.5) { medianTopPrice = topSorted[i].price; break; }
        }

        // When sqft data is suspect, trust the direct price method
        // When sqft is reliable, use the higher of both methods
        if (sqftSuspect) {
          estimatedARV = medianTopPrice;
        } else {
          estimatedARV = Math.max(ppsfDerived, medianTopPrice);
        }

        // Compute range using weighted 25th and 75th percentile ppsf
        let cum25 = 0, cum75 = 0;
        let p25Ppsf = weighted[0].ppsf;
        let p75Ppsf = weighted[weighted.length - 1].ppsf;
        for (let i = 0; i < weighted.length; i++) {
          cum25 += weighted[i].weight;
          if (cum25 >= totalWeight * 0.75) { p75Ppsf = weighted[i].ppsf; break; }
        }
        // Reset for 25th
        let cum25b = 0;
        for (let i = 0; i < weighted.length; i++) {
          cum25b += weighted[i].weight;
          if (cum25b >= totalWeight * 0.25) { p25Ppsf = weighted[i].ppsf; break; }
        }
        // Compute range
        // Sort top-tier comps by price for price-based range
        const topPrices = topTier.map(v => v.price).sort((a, b) => a - b);
        const ppsf25 = Math.round(medianPpsfW * targetSqft);
        const ppsf75 = Math.round(p75Ppsf * targetSqft);
        
        // Conservative: lower of median-ppsf-derived or lowest top-tier price
        // Optimistic: higher of 75th-ppsf-derived or highest top-tier price
        arvLow = Math.min(ppsf25, topPrices[0]);
        arvHigh = Math.max(ppsf75, topPrices[topPrices.length - 1]);

        // Ensure range makes sense relative to the ARV point estimate
        if (arvLow > estimatedARV) arvLow = estimatedARV;
        if (arvHigh < estimatedARV) arvHigh = estimatedARV;
        // ARV low should not be below as-is
        if (arvLow < asIsValue) arvLow = asIsValue;
      }

      // Median ppsf across ALL surviving comps for reference
      var medianPpsf = Math.round(medianPpsfW);
    }

    // ARV should generally be higher than as-is value
    // Only reject if ARV is more than 5% below as-is (allows for markets where
    // renovated comps and as-is values converge)
    if (estimatedARV && asIsValue && estimatedARV < asIsValue * 0.95) {
      estimatedARV = null;
      arvLow = null;
      arvHigh = null;
      arvPricePerSqft = null;
      arvCompsUsed = 0;
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
      arvLow: arvLow,
      arvHigh: arvHigh,
      arvPricePerSqft: arvPricePerSqft,
      arvCompsUsed: arvCompsUsed,
      medianPricePerSqft: typeof medianPpsf !== 'undefined' ? medianPpsf : null
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch ARV' });
  }
}
