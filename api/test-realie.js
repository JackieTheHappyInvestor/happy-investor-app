// TEMPORARY debug endpoint for Realie API - DELETE AFTER TESTING
export default async function handler(req, res) {
  var address = req.query.address || '409 E Everett St';
  var state = req.query.state || 'IL';
  var city = req.query.city || '';
  var county = req.query.county || '';

  var url = 'https://app.realie.ai/api/public/property/address/?address=' +
    encodeURIComponent(address) + '&state=' + encodeURIComponent(state);

  if (city && county) {
    url += '&city=' + encodeURIComponent(city) + '&county=' + encodeURIComponent(county);
  }

  try {
    var r = await fetch(url, {
      headers: { 'Authorization': process.env.REALIE_API_KEY }
    });
    var data = await r.json();
    return res.status(200).json({
      requestUrl: url.replace(/Authorization[^&]*/, ''),
      status: r.status,
      data: data
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
