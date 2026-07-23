// Temporary debug - DELETE AFTER
export default async function handler(req, res) {
  var apiKey = process.env.GOOGLE_PLACES_API_KEY;
  var zip = req.query.zip || '75150';

  // Step 1: Geocode
  var geoResp = await fetch(
    'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(zip) + '&components=country:US&key=' + apiKey
  );
  var geoData = await geoResp.json();
  
  if (!geoData.results || !geoData.results.length) {
    return res.status(200).json({ step: 'geocode_failed', geoData: geoData });
  }

  var location = geoData.results[0].geometry.location;
  var cityComp = (geoData.results[0].address_components || []).find(function(c) {
    return (c.types || []).indexOf('locality') !== -1;
  });
  var stateComp = (geoData.results[0].address_components || []).find(function(c) {
    return (c.types || []).indexOf('administrative_area_level_1') !== -1;
  });

  // Step 2: Search Places
  var textQuery = 'licensed general contractor home renovation ' + (cityComp ? cityComp.long_name : '') + ' ' + (stateComp ? stateComp.short_name : '');
  
  var placesResp = await fetch(
    'https://places.googleapis.com/v1/places:searchText',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating'
      },
      body: JSON.stringify({
        textQuery: textQuery,
        locationBias: {
          circle: {
            center: { latitude: location.lat, longitude: location.lng },
            radius: 50000.0
          }
        },
        pageSize: 5
      })
    }
  );
  var placesData = await placesResp.json();

  return res.status(200).json({
    geocode: { city: cityComp ? cityComp.long_name : null, state: stateComp ? stateComp.short_name : null, lat: location.lat, lng: location.lng },
    query: textQuery,
    placesStatus: placesResp.status,
    placesData: placesData
  });
}
