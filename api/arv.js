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
    let rentcastFailed = false;
    let data = {};
    if (!response.ok) {
      rentcastFailed = true;
      data = { comparables: [] };
    } else {
      data = await response.json();
    }
    let allComps = Array.isArray(data.comparables) ? data.comparables : [];

    // Stage 2: if narrow returned fewer than 3 comps, widen to 5 miles / 365 days (rural fallback)
    if (!rentcastFailed && allComps.length < 3) {
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

    // Mark each comp with status label (informational only — no filtering)
    // Rentcast's status field is unreliable: sold comps often show "Active" 
    // because MLS listings aren't updated immediately after sale
    let usingSoldOnly = true;
    allComps.forEach(c => {
      if (c.status && typeof c.status === 'string') {
        var s = c.status.toLowerCase();
        c._isSold = !(s.includes('active') || s.includes('for sale') || s.includes('pending'));
      } else {
        c._isSold = true;
      }
    });

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

    // Tier 4: 365 days within 3 miles
    if (tierComps.length < 3) {
      tierComps = allComps.filter(c => c.distance != null && c.distance <= 3 && c.daysOld != null && c.daysOld <= 365);
      compTier = { daysWindow: 365, radiusMiles: 3 };
    }

    // Tier 5: 365 days within 5 miles
    if (tierComps.length < 3) {
      tierComps = allComps.filter(c => c.distance != null && c.distance <= 5 && c.daysOld != null && c.daysOld <= 365);
      compTier = { daysWindow: 365, radiusMiles: 5 };
    }

    // Determine subject year built for filtering
    const subjectYear = (data.subjectProperty && data.subjectProperty.yearBuilt)
      ? data.subjectProperty.yearBuilt : null;

    // Rentcast pre-sorts by correlation (similarity) descending, keep that order, cap at 5
    // But first filter out new construction from display comps too
    const displayComps = tierComps.filter(c => {
      if (c.listingType && c.listingType.toLowerCase().includes('new construction')) return false;
      // Also exclude comps built 25+ years newer than subject
      if (subjectYear && c.yearBuilt && (c.yearBuilt - subjectYear > 25)) return false;
      return true;
    });
    const finalComps = displayComps.slice(0, 5).map(c => ({
      address: c.formattedAddress || '',
      price: c.price || 0,
      distance: c.distance || 0,
      daysOld: c.daysOld || 0,
      bedrooms: c.bedrooms || null,
      bathrooms: c.bathrooms || null,
      squareFootage: c.squareFootage || null,
      compStatus: c._isSold ? 'Sold' : 'Listed',
      hasReliableStatus: false
    }));

    compTier.count = finalComps.length;

    // --- ARV ESTIMATION v3: Appraiser-style paired-sales adjustments ---
    // Instead of picking "top" comps and averaging, we ADJUST every comp's price
    // to account for differences from the subject (sqft, beds, baths).
    // This is exactly what a licensed appraiser does on a URAR form.
    // Adjusted prices cluster tightly because differences are normalized away.
    // The top half of adjusted prices represents renovated-condition sales.

    let estimatedARV = null;
    let arvLow = null;
    let arvHigh = null;
    let asIsValue = data.price || 0;

    // If Rentcast has no base price but we have comps, use median comp price as as-is
    if (!asIsValue && tierComps.length > 0) {
      var compPrices = tierComps.filter(c => c.price > 0).map(c => c.price).sort((a, b) => a - b);
      if (compPrices.length > 0) {
        var mid = Math.floor(compPrices.length / 2);
        asIsValue = compPrices.length % 2 === 0
          ? Math.round((compPrices[mid - 1] + compPrices[mid]) / 2)
          : compPrices[mid];
      }
    }
    let arvPricePerSqft = null;
    let arvCompsUsed = 0;

    // Determine subject attributes
    const subjectSqft = sqft != null
      ? sqft
      : (data.subjectProperty && data.subjectProperty.squareFootage
          ? data.subjectProperty.squareFootage
          : null);
    let targetSqft = subjectSqft || null;
    const subjectBeds = beds != null
      ? beds
      : (data.subjectProperty && data.subjectProperty.bedrooms
          ? data.subjectProperty.bedrooms
          : null);
    const subjectBaths = baths != null
      ? baths
      : (data.subjectProperty && data.subjectProperty.bathrooms
          ? data.subjectProperty.bathrooms
          : null);

    // Step 1: Start with comps that have valid price and sqft
    let arvComps = tierComps.filter(c => c.price > 0 && c.squareFootage > 0);

    // Step 2: Exclude new construction
    arvComps = arvComps.filter(c => {
      if (c.listingType && c.listingType.toLowerCase().includes('new construction')) return false;
      return true;
    });

    // Step 2a: Exclude comps built significantly newer than the subject
    // A 1960s house should not be compared to a 2020 new build even if same size/beds/baths
    if (subjectYear) {
      const yearFiltered = arvComps.filter(c => {
        if (!c.yearBuilt) return true; // Keep comps with unknown year
        const yearDiff = c.yearBuilt - subjectYear;
        // Exclude comps built more than 25 years newer than subject
        // (newer homes are a fundamentally different product)
        // Allow older comps — a 1950s comp for a 1960s subject is fine
        if (yearDiff > 25) return false;
        return true;
      });
      if (yearFiltered.length >= 3) {
        arvComps = yearFiltered;
      }
    }

    // Step 2b: Exclude extreme price outliers
    // Only catches truly extreme cases (3x median) — lighter touch than before
    // to avoid removing legitimate high-value comps in thin markets
    if (arvComps.length >= 4) {
      const sortedPrices = arvComps.map(c => c.price).sort((a, b) => a - b);
      const mid = Math.floor(sortedPrices.length / 2);
      const medianPrice = sortedPrices.length % 2 === 0
        ? (sortedPrices[mid - 1] + sortedPrices[mid]) / 2
        : sortedPrices[mid];
      const priceFiltered = arvComps.filter(c => c.price >= medianPrice * 0.33 && c.price <= medianPrice * 3.0);
      if (priceFiltered.length >= 3) {
        arvComps = priceFiltered;
      }
    }

    // Step 3: Exclude comps outside ±25% sqft of subject (if we know subject sqft)
    // Slightly wider than before (25% vs 20%) because adjustments handle the difference
    if (subjectSqft) {
      const avgCompSqft = Math.round(arvComps.reduce((s, c) => s + c.squareFootage, 0) / arvComps.length);
      // Check if subject sqft is suspect (>40% off from comp average)
      let effectiveSqft = subjectSqft;
      if (avgCompSqft && (subjectSqft / avgCompSqft < 0.6 || subjectSqft / avgCompSqft > 1.6)) {
        effectiveSqft = avgCompSqft; // Use comp average when Rentcast data is wrong
      }
      const sqftLow = effectiveSqft * 0.75;
      const sqftHigh = effectiveSqft * 1.25;
      const sqftFiltered = arvComps.filter(c => c.squareFootage >= sqftLow && c.squareFootage <= sqftHigh);
      if (sqftFiltered.length >= 3) {
        arvComps = sqftFiltered;
      }
    }

    // Step 4: Cap at 10 most similar comps
    if (arvComps.length > 10) {
      arvComps = arvComps.slice(0, 10);
    }

    // Step 5: Compute adjusted prices using appraiser-style paired-sales adjustments
    if (arvComps.length >= 3) {
      // Determine effective subject sqft for adjustments
      const avgCompSqft = Math.round(arvComps.reduce((s, c) => s + c.squareFootage, 0) / arvComps.length);
      let targetSqftInner = subjectSqft || avgCompSqft;
      if (subjectSqft && avgCompSqft && (subjectSqft / avgCompSqft < 0.6 || subjectSqft / avgCompSqft > 1.6)) {
        targetSqftInner = avgCompSqft;
      }
      targetSqft = targetSqftInner;

      // Average comp beds/baths as fallback when subject data is missing
      const avgCompBeds = subjectBeds || Math.round(arvComps.reduce((s, c) => s + (c.bedrooms || 3), 0) / arvComps.length);
      const avgCompBaths = subjectBaths || (arvComps.reduce((s, c) => s + (c.bathrooms || 2), 0) / arvComps.length);

      const adjusted = arvComps.map(c => {
        const compPpsf = c.price / c.squareFootage;
        const w = (c.correlation != null && c.correlation > 0) ? c.correlation : 0.5;
        let totalAdj = 0;

        // --- GLA ADJUSTMENT (the 40% rule) ---
        // Adjust at 40% of comp's $/sqft per sqft difference
        // If subject is bigger, comp price goes UP (comp would cost more if it were bigger)
        // If subject is smaller, comp price goes DOWN
        const sqftDiff = targetSqft - c.squareFootage;
        if (Math.abs(sqftDiff) > Math.max(100, targetSqft * 0.05)) {
          const glaRate = compPpsf * 0.40;
          totalAdj += sqftDiff * glaRate;
        }

        // --- BATHROOM ADJUSTMENT ---
        // Full bath: max($3000, 1.5% of comp price)
        // Half bath: 55% of full bath value
        if (avgCompBaths != null && c.bathrooms != null) {
          const fullBathValue = Math.max(3000, c.price * 0.015);
          // Rentcast gives total baths (e.g., 2.5 = 2 full + 1 half)
          const subjectFull = Math.floor(avgCompBaths);
          const subjectHalf = (avgCompBaths % 1 >= 0.5) ? 1 : 0;
          const compFull = Math.floor(c.bathrooms);
          const compHalf = (c.bathrooms % 1 >= 0.5) ? 1 : 0;
          totalAdj += (subjectFull - compFull) * fullBathValue;
          totalAdj += (subjectHalf - compHalf) * (fullBathValue * 0.55);
        }

        // --- BEDROOM ADJUSTMENT ---
        // $0 when both >= 3 and GLA is adjusted (avoid double-counting)
        // Only apply at the 2→3 BR threshold (functional utility jump)
        if (avgCompBeds != null && c.bedrooms != null) {
          const brDiff = avgCompBeds - c.bedrooms;
          if (Math.min(avgCompBeds, c.bedrooms) < 3 && Math.abs(brDiff) >= 1) {
            totalAdj += brDiff * c.price * 0.06;
          }
          // Skip adjustment when both >= 3 (absorbed by GLA)
        }

        // --- AGE / YEAR BUILT ADJUSTMENT ---
        // Newer homes sell for more purely due to age (newer systems, layout, efficiency)
        // Only adjust when gap exceeds 15 years to avoid noise
        // Rate: 0.2% of comp price per year of difference
        // If subject is OLDER than comp, comp price is adjusted DOWN
        // (subject would sell for less than a newer comp, all else equal)
        if (subjectYear && c.yearBuilt) {
          const ageDiff = c.yearBuilt - subjectYear; // positive = comp is newer
          if (Math.abs(ageDiff) > 15) {
            const ageRate = c.price * 0.002; // 0.2% per year
            // Cap at 20 years of adjustment (4% max) to avoid overcorrecting
            const cappedDiff = Math.max(-20, Math.min(20, ageDiff));
            totalAdj -= cappedDiff * ageRate; // subtract because newer comp = inflate, so adjust down
          }
        }

        // --- COMPLIANCE CHECK ---
        // Flag comps with gross adjustment > 25% (FHA/lender threshold)
        const grossPct = Math.abs(totalAdj) / c.price;
        const reliable = grossPct <= 0.25;

        const adjustedPrice = c.price + totalAdj;
        return {
          price: c.price,
          adjustedPrice: Math.round(adjustedPrice),
          totalAdj: Math.round(totalAdj),
          ppsf: compPpsf,
          weight: reliable ? w : w * 0.5, // Downweight heavily adjusted comps
          comp: c,
          reliable
        };
      });

      // Sort adjusted prices ascending
      adjusted.sort((a, b) => a.adjustedPrice - b.adjustedPrice);
      arvCompsUsed = adjusted.length;

      // Compute weighted median of ALL adjusted prices (= as-is market value of subject)
      const totalWeight = adjusted.reduce((s, v) => s + v.weight, 0);
      let cumW = 0;
      let medianAdjPrice = adjusted[Math.floor(adjusted.length / 2)].adjustedPrice;
      for (let i = 0; i < adjusted.length; i++) {
        cumW += adjusted[i].weight;
        if (cumW >= totalWeight * 0.5) {
          medianAdjPrice = adjusted[i].adjustedPrice;
          break;
        }
      }

      // For ARV: use hybrid approach depending on comp spread
      // Tight spread (suburban) = 65th percentile works well
      // Wide spread (cheap/thin markets) = top-3 comp average is more stable
      const lowestAdj = adjusted[0].adjustedPrice;
      const highestAdj = adjusted[adjusted.length - 1].adjustedPrice;
      const spreadRatio = highestAdj / Math.max(lowestAdj, 1);

      if (spreadRatio > 2.5) {
        // WIDE SPREAD (thin/messy market): use highest RAW comp × 0.95
        // In these markets, adjustments add noise because the comp pool is too
        // heterogeneous. The highest comp represents the best recent sale,
        // which is the closest proxy for post-renovation value.
        // Use RAW price (not adjusted) because adjustments normalize to subject's
        // current condition, but ARV needs to reflect RENOVATED condition.
        const highestRaw = Math.max(...arvComps.map(c => c.price));
        estimatedARV = Math.round(highestRaw * 0.95);
      } else {
        // TIGHT SPREAD: 65th percentile works well for suburban markets
        let cumWArv = 0;
        let arvTarget = adjusted[adjusted.length - 1].adjustedPrice;
        for (let i = 0; i < adjusted.length; i++) {
          cumWArv += adjusted[i].weight;
          if (cumWArv >= totalWeight * 0.65) {
            arvTarget = adjusted[i].adjustedPrice;
            break;
          }
        }
        estimatedARV = arvTarget;

        // BRACKET VALIDATION (Fannie Mae 1004 rule):
        // ARV can never exceed the highest adjusted comp price
        if (estimatedARV > highestAdj) {
          estimatedARV = highestAdj;
        }
      }

      // Compute $/sqft for display
      if (estimatedARV && targetSqft) {
        arvPricePerSqft = Math.round(estimatedARV / targetSqft);
      }

      // Range: 25th and 75th percentile of adjusted prices
      let p25Price = adjusted[0].adjustedPrice;
      let p75Price = adjusted[adjusted.length - 1].adjustedPrice;
      let cumW25 = 0;
      for (let i = 0; i < adjusted.length; i++) {
        cumW25 += adjusted[i].weight;
        if (cumW25 >= totalWeight * 0.25) { p25Price = adjusted[i].adjustedPrice; break; }
      }
      let cumW75 = 0;
      for (let i = 0; i < adjusted.length; i++) {
        cumW75 += adjusted[i].weight;
        if (cumW75 >= totalWeight * 0.75) { p75Price = adjusted[i].adjustedPrice; break; }
      }
      arvLow = p25Price;
      arvHigh = p75Price;

      // Ensure range makes sense
      if (arvLow > estimatedARV) arvLow = estimatedARV;
      if (arvHigh < estimatedARV) arvHigh = estimatedARV;

      // Median ppsf for display
      var medianPpsf = targetSqft ? Math.round(medianAdjPrice / targetSqft) : null;
    }

    // ARV should never be lower than as-is value for an investor tool
    // When calculation produces lower, clamp to as-is with a note
    var arvLimitedUpside = false;
    if (estimatedARV && asIsValue && estimatedARV < asIsValue) {
      estimatedARV = asIsValue;
      arvLimitedUpside = true;
      if (targetSqft) arvPricePerSqft = Math.round(asIsValue / targetSqft);
      if (arvLow && arvLow < asIsValue) arvLow = asIsValue;
      if (arvHigh && arvHigh < asIsValue) arvHigh = asIsValue;
    }

    // Only show active listing labels when there is a genuine mix of sold and listed
    // If ALL comps show as Listed, Rentcast's status field is unreliable — hide labels
    var hasSold = finalComps.some(function(c){ return c.compStatus === 'Sold'; });
    var hasListed = finalComps.some(function(c){ return c.compStatus === 'Listed'; });
    var hasReliableStatus = hasSold && hasListed;
    if (!hasReliableStatus) {
      finalComps.forEach(function(c){ delete c.compStatus; });
    }

    // ========== ATTOM FALLBACK ==========
    // If Rentcast produced no usable data, try ATTOM as secondary source
    if (!asIsValue && !estimatedARV && process.env.ATTOM_API_KEY) {
      try {
        // Split address: "409 E Everett St, Marion, IL 62959" → address1 + address2
        var addrParts = address.split(',');
        if (addrParts.length >= 2) {
          var address1 = addrParts[0].trim();
          var address2 = addrParts.slice(1).join(',').trim();

          var attomResp = await fetch(
            'https://api.gateway.attomdata.com/propertyapi/v1.0.0/avm/detail?address1=' +
            encodeURIComponent(address1) + '&address2=' + encodeURIComponent(address2),
            {
              headers: { apikey: process.env.ATTOM_API_KEY, accept: 'application/json' },
              signal: AbortSignal.timeout(5000)
            }
          );

          if (attomResp.ok) {
            var attomData = await attomResp.json();
            var prop = attomData.property && attomData.property[0];

            if (prop && prop.avm && prop.avm.amount && prop.avm.amount.value > 0) {
              var avm = prop.avm;
              var attomAsIs = avm.amount.value;
              var attomARV = avm.condition
                ? (avm.condition.avmgoodhigh || avm.amount.high || attomAsIs)
                : (avm.amount.high || attomAsIs);
              var attomArvLow = avm.condition
                ? (avm.condition.avmgoodlow || avm.amount.low)
                : avm.amount.low;
              var attomArvHigh = avm.condition
                ? (avm.condition.avmgoodhigh || avm.amount.high)
                : avm.amount.high;
              var attomConfidence = avm.amount.scr || null;

              // Get property details from ATTOM
              var attomSqft = prop.building && prop.building.size
                ? (prop.building.size.livingsize || prop.building.size.universalsize || null)
                : null;
              var effectiveSqft = sqft || attomSqft;
              var attomPpsf = effectiveSqft ? Math.round(attomARV / effectiveSqft) : null;

              // If ARV is lower than as-is, clamp
              if (attomARV < attomAsIs) {
                attomARV = attomAsIs;
                attomArvLow = attomAsIs;
                attomArvHigh = attomAsIs;
              }

              return res.status(200).json({
                price: attomAsIs,
                priceRangeLow: avm.amount.low,
                priceRangeHigh: avm.amount.high,
                subjectProperty: {
                  squareFootage: attomSqft,
                  yearBuilt: prop.summary ? prop.summary.yearbuilt : null,
                  bedrooms: prop.building && prop.building.rooms ? prop.building.rooms.beds : null,
                  bathrooms: prop.building && prop.building.rooms ? prop.building.rooms.bathsfull : null
                },
                comparables: [],
                compTier: null,
                asIsValue: attomAsIs,
                estimatedARV: attomARV,
                arvLow: attomArvLow,
                arvHigh: attomArvHigh,
                arvPricePerSqft: attomPpsf,
                arvCompsUsed: 0,
                arvLimitedUpside: attomARV <= attomAsIs,
                medianPricePerSqft: null,
                includesActiveListings: false,
                source: 'attom',
                confidence: attomConfidence
              });
            }
          }
        }
      } catch (attomErr) {
        console.error('ATTOM fallback error:', attomErr.message);
        // ATTOM failed too — fall through to Rentcast response (which may be empty)
      }
    }
    // ========== END ATTOM FALLBACK ==========

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
      arvLimitedUpside: arvLimitedUpside,
      medianPricePerSqft: typeof medianPpsf !== 'undefined' ? medianPpsf : null,
      includesActiveListings: hasReliableStatus,
      source: 'rentcast',
      confidence: null
    });
  } catch (e) {
    console.error('ARV error:', e.message, e.stack);
    return res.status(500).json({ error: 'Failed to fetch ARV' });
  }
}
