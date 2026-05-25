// Temporary test for ATTOM SalesComparables - DELETE AFTER
export default async function handler(req, res) {
  var address = req.query.address || '409 E Everett St, Marion, IL 62959';
  
  // Parse address into components
  var parts = address.split(',').map(function(s){ return s.trim(); });
  var street = parts[0];
  var cityStateZip = parts.slice(1).join(', ');
  var match = cityStateZip.match(/^(.*?),?\s+([A-Z]{2})\s+(\d{5})/);
  
  if (!match) return res.status(400).json({ error: 'Could not parse address', raw: cityStateZip });
  
  var city = match[1].replace(/,$/,'').trim();
  var state = match[2];
  var zip = match[3];

  try {
    var url = 'https://api.gateway.attomdata.com/property/v2/SalesComparables/Address/' +
      encodeURIComponent(street) + '/' +
      encodeURIComponent(city) + '/-/' +
      state + '/' + zip +
      '?searchType=Radius&minComps=1&maxComps=10&miles=5&saleDateRange=12';

    var r = await fetch(url, {
      headers: { apikey: process.env.ATTOM_API_KEY, accept: 'application/json' }
    });
    var data = await r.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
