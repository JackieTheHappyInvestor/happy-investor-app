export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { zip, type, category } = req.query;
  if (!zip) return res.status(400).json({ error: 'Zip required' });

  const TYPE_RULES = {
    lender: { deny: ['real_estate_agency'] },
    dscr: { deny: ['real_estate_agency'] },
    title: { deny: ['real_estate_agency'] },
    contractor: { deny: ['real_estate_agency'] },
    accountant: { deny: ['real_estate_agency'] },
    attorney: { deny: ['real_estate_agency'] }
  };

  const BRAND_DENYLIST = {
    lender: ['tower loan', 'mariner finance', 'heights finance', 'sun loan', 'sunloan', 'onemain', 'world finance', 'republic finance', 'lendmark', 'security finance', 'regional finance', 'check into cash', 'check n go', 'advance america', 'speedy cash', 'ace cash', 'title max', 'titlemax', 'cash america'],
    dscr: ['tower loan', 'mariner finance', 'heights finance', 'sun loan', 'sunloan', 'onemain', 'world finance', 'republic finance', 'lendmark', 'security finance', 'regional finance', 'check into cash', 'check n go', 'advance america', 'speedy cash', 'ace cash', 'title max', 'titlemax', 'cash america']
  };

  const FLATFEE_LISTINGS = [
    { name: 'Houzeo', formatted_address: 'All 50 states · From $249 + 0.5% at closing · houzeo.com', rating: 4.8 },
    { name: 'Unreal Estate', formatted_address: '49 states · $0 upfront + 0.5% at closing · unrealestate.com', rating: 4.2 },
    { name: 'List With Freedom', formatted_address: '47 states · From $89 + 0.5% at closing · listwithfreedom.com', rating: 3.2 },
    { name: 'Fizber', formatted_address: 'All 50 states · From $270 flat fee · fizber.com', rating: 4.8 },
    { name: 'Beycome', formatted_address: '14 states · $99 flat, no closing fees · beycome.com', rating: 4.4 },
    { name: 'Homecoin', formatted_address: '22+ states · $95–$149 flat, $0 at closing · homecoin.com', rating: 4.4 }
  ];

  if (category === 'flatfee') {
    return res.status(200).json({ results: FLATFEE_LISTINGS });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  try {
    const geoResponse = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(zip)}&components=country:US&key=${apiKey}`
    );
    const geoData = await geoResponse.json();

    if (!geoData.results || !geoData.results.length) {
      return res.status(200).json({ results: [] });
    }

    const location = geoData.results[0].geometry.location;
    const stateComp = (geoData.results[0].address_components || []).find(function (c) {
      return (c.types || []).indexOf('administrative_area_level_1') !== -1;
    });
    const stateShort = stateComp ? stateComp.short_name : null;
    const cityComp = (geoData.results[0].address_components || []).find(function (c) {
      return (c.types || []).indexOf('locality') !== -1;
    });
    const cityName = cityComp ? cityComp.long_name : '';

    const textQuery = [type || 'service', cityName, stateShort].filter(Boolean).join(' ');

    const response = await fetch(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.addressComponents,places.types'
        },
        body: JSON.stringify({
          textQuery: textQuery,
          locationBias: {
            circle: {
              center: { latitude: location.lat, longitude: location.lng },
              radius: 50000.0
            }
          },
          pageSize: 20
        })
      }
    );

    const data = await response.json();

    let results = (data.places || []).map(function (p) {
      const stateMatch = (p.addressComponents || []).find(function (c) {
        return (c.types || []).indexOf('administrative_area_level_1') !== -1;
      });
      return {
        name: p.displayName && p.displayName.text ? p.displayName.text : '',
        formatted_address: p.formattedAddress || '',
        rating: p.rating || null,
        user_ratings_total: p.userRatingCount || 0,
        _state: stateMatch ? stateMatch.shortText : null,
        _types: p.types || []
      };
    });

    if (stateShort) {
      results = results.filter(function (r) {
        return !r._state || r._state === stateShort;
      });
    }

    const rules = TYPE_RULES[category];
    if (rules && rules.deny && rules.deny.length) {
      results = results.filter(function (r) {
        for (let i = 0; i < rules.deny.length; i++) {
          if (r._types.indexOf(rules.deny[i]) !== -1) return false;
        }
        return true;
      });
    }

    const brandDeny = BRAND_DENYLIST[category];
    if (brandDeny && brandDeny.length) {
      results = results.filter(function (r) {
        const nameLower = (r.name || '').toLowerCase();
        for (let i = 0; i < brandDeny.length; i++) {
          if (nameLower.indexOf(brandDeny[i]) !== -1) return false;
        }
        return true;
      });
    }

    results = results.map(function (r) {
      return {
        name: r.name,
        formatted_address: r.formatted_address,
        rating: r.rating,
        user_ratings_total: r.user_ratings_total
      };
    });

    res.status(200).json({ results: results });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch team data' });
  }
}
