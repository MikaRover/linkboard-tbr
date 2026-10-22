// Smart backlink checker — fetches the page that should contain the backlink,
// looks for the target URL, and reports status. The logic lives in _lib/linkcheck.js
// (also used by the scheduled pending-link checker).

const { isSafeHost } = require('./_lib/security');
const { checkLink } = require('./_lib/linkcheck');

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});

  const { linkIn, linkTo, anchor } = req.body || {};
  if(!linkIn || !linkTo) return res.status(400).json({result:'⚠️ Missing linkIn/linkTo'});
  if(!isSafeHost(linkIn)) return res.status(400).json({result:'⚠️ Invalid or disallowed URL'});

  return res.json(await checkLink({ linkIn, linkTo, anchor }));
};
