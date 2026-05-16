// Quick test endpoint for ATTOM API - DELETE AFTER TESTING
export default async function handler(req, res) {
  var address1 = req.query.address1 || '409 E Everett St';
  var address2 = req.query.address2 || 'Marion IL 62959';

  try {
    var r = await fetch(
      'https://api.gateway.attomdata.com/propertyapi/v1.0.0/avm/detail?address1=' + encodeURIComponent(address1) + '&address2=' + encodeURIComponent(address2),
      { headers: { apikey: process.env.ATTOM_API_KEY, accept: 'application/json' } }
    );
    var data = await r.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
