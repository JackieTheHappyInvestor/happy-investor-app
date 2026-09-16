// TEMPORARY debug endpoint for Realie API - DELETE AFTER TESTING
export default async function handler(req, res) {
  var key = process.env.REALIE_API_KEY;
  var out = {};

  // Mode 1: address lookup
  if (req.query.address) {
    var address = req.query.address;
    var state = req.query.state || 'IL';
    var city = req.query.city || '';
    var county = req.query.county || '';

    var url = 'https://app.realie.ai/api/public/property/address/?address=' +
      encodeURIComponent(address) + '&state=' + encodeURIComponent(state);
    if (city && county) {
      url += '&city=' + encodeURIComponent(city) + '&county=' + encodeURIComponent(county);
    }

    try {
      var r = await fetch(url, { headers: { 'Authorization': key } });
      var data = await r.json();
      out.addressLookup = { url: url, status: r.status, data: data };
    } catch (e) {
      out.addressLookup = { error: e.message };
    }
  }

  // Mode 2: comparables by lat/lng
  if (req.query.lat && req.query.lng) {
    var compsUrl = 'https://app.realie.ai/api/public/premium/comparables/?latitude=' +
      encodeURIComponent(req.query.lat) + '&longitude=' + encodeURIComponent(req.query.lng) +
      '&radius=' + (req.query.radius || '2') +
      '&months=' + (req.query.months || '18') +
      '&limit=' + (req.query.limit || '10');

    try {
      var cr = await fetch(compsUrl, { headers: { 'Authorization': key } });
      var cdata = await cr.json();
      out.comparables = { url: compsUrl, status: cr.status, data: cdata };
    } catch (e) {
      out.comparables = { error: e.message };
    }
  }

  return res.status(200).json(out);
}
