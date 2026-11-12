// Cloudflare Worker for Review Words (GitHub Pages frontend).
// Configure GEMINI_API_KEY as a Worker Secret; never put it in the static repository.
const MODEL = 'gemini-2.5-flash';
const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin'
});
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').trim();
    if (allowed && origin && origin !== allowed) return new Response('Origin not allowed', {status:403});
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:cors(origin)});
    const url = new URL(request.url);
    if (url.pathname !== '/generate-article' || request.method !== 'POST')
      return new Response('Not found',{status:404,headers:cors(origin)});
    if (!env.GEMINI_API_KEY) return json({error:'Missing GEMINI_API_KEY secret'},500,origin);
    try {
      const body = await request.json();
      const words = Array.isArray(body.words) ? body.words.map(x=>String(x).trim()).filter(Boolean).slice(0,24) : [];
      if (!words.length) return json({error:'words is required'},400,origin);
      const difficulty = ['A2','B1','B2'].includes(body.difficulty) ? body.difficulty : 'adaptive';
      const targetLength = Math.min(180,Math.max(100,Number(body.targetLength)||150));
      const prompt = `Write an original English learning passage of about ${targetLength} words, CEFR ${difficulty==='adaptive'?'adaptive A2-B2':difficulty}. Naturally include EVERY target word exactly as written (same spelling; do not change inflection). Avoid a list-like style. Then provide a faithful Simplified Chinese translation. Return ONLY valid JSON with keys title, content, translation, difficulty. Target words: ${words.join(', ')}.`;
      const api = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
      const upstream = await fetch(api,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{responseMimeType:'application/json',temperature:0.65}})});
      const raw = await upstream.json();
      if (!upstream.ok) return json({error:'AI provider error',detail:raw.error?.message||upstream.statusText},502,origin);
      const text = raw.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('') || '';
      const result = JSON.parse(text.replace(/^```json\s*|\s*```$/g,''));
      if (!result.content || !result.translation) throw new Error('AI response missing content or translation');
      const content = String(result.content);
      const missing = words.filter(w=>!new RegExp(`(^|[^A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^A-Za-z]|$)`,'i').test(content));
      if (missing.length) return json({error:'Target words missing',missing},422,origin);
      return json({title:result.title||'Daily Writing Practice',content,translation:String(result.translation),difficulty:result.difficulty||difficulty,provider:MODEL},200,origin);
    } catch (e) { return json({error:'Generation failed',detail:e.message},500,origin); }
  }
};
function json(data,status,origin){return new Response(JSON.stringify(data),{status,headers:{...cors(origin),'Content-Type':'application/json; charset=utf-8'}});}
