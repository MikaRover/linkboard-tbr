// Smart backlink checker — fetches the page that should contain the backlink,
// looks for the target URL, and reports status. The logic lives in _lib/linkcheck.js
// (also used by the scheduled pending-link checker). POST {action:...} runs one of
// the site tools in _lib/sitetools.js instead (Safe Browsing, PageRank, screenshot, DNS).

const { isSafeHost } = require('./_lib/security');
const { checkLink } = require('./_lib/linkcheck');
const { handleSiteTool } = require('./_lib/sitetools');

module.exports = async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method==='OPTIONS') return res.status(200).end();
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});

  if(req.body && req.body.action) return handleSiteTool(req, res, req.body.action);

  const { linkIn, linkTo, anchor } = req.body || {};
  if(!linkIn || !linkTo) return res.status(400).json({result:'⚠️ Missing linkIn/linkTo'});
  if(!isSafeHost(linkIn)) return res.status(400).json({result:'⚠️ Invalid or disallowed URL'});

  return res.json(await checkLink({ linkIn, linkTo, anchor }));
};
