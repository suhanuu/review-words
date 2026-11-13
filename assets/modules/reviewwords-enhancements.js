(function(){
'use strict';
var $=function(id){return document.getElementById(id);};
var BOOKS_KEY='reviewwords.books.v1', ACTIVE_KEY='reviewwords.activeBook.v1', PREFIX='wordtype.v1:book:', ARTICLES='reviewwords.articles.v1', TASKS='reviewwords.dailyTasks.v1', AI_SETTINGS='reviewwords.aiSettings.v1';
function get(k,d){try{return JSON.parse(localStorage.getItem(k)||'null')||d;}catch(e){return d;}}
function active(){return localStorage.getItem(ACTIVE_KEY)||'redbook-2024';}
function archive(){return get(PREFIX+active(),{});}
function words(){var b=archive(), list=active()==='redbook-2024'?(window.WORD_BANK||[]).concat(b.custom||[]):(b.custom||[]);var m={};list.forEach(function(w){if(w&&w.w)m[w.w]=w;});return m;}
function weak(){
 var d=archive(), rec=d.records||{}, fav=d.favs||{}, all=words(), map={};
 Object.keys(rec).forEach(function(w){var r=rec[w]||{};if(r.last===1||(r.forgot||0)>0)map[w]={word:w,rank:3,source:['忘记'],meaning:(all[w]||{}).m||''};else if(r.last===2)map[w]={word:w,rank:2,source:['模糊'],meaning:(all[w]||{}).m||''};});
 Object.keys(fav).forEach(function(w){if(!map[w])map[w]={word:w,rank:1,source:['收藏'],meaning:(all[w]||{}).m||''};else map[w].source.push('收藏');});
 return Object.keys(map).map(function(k){return map[k];}).sort(function(a,b){return b.rank-a.rank||a.word.localeCompare(b.word);});
}
var selected={};
var selectedHistory={};
function renderWeak(){
 var host=$('weakWordList');if(!host)return;host.innerHTML='';var list=weak();
 list.forEach(function(x){if(selected[x.word]===undefined)selected[x.word]=true;var lab=document.createElement('label');lab.className='weak-word-chip';var cb=document.createElement('input');cb.type='checkbox';cb.checked=!!selected[x.word];cb.addEventListener('change',function(){selected[x.word]=cb.checked;});var span=document.createElement('span');span.textContent=x.word;var small=document.createElement('small');small.textContent=x.source.join(' / ');lab.append(cb,span,small);host.appendChild(lab);});
 $('weakPoolCount').textContent=list.length+' 个词 · '+list.filter(function(x){return selected[x.word]!==false;}).length+' 个已选';
 if(!list.length)host.textContent='暂时没有薄弱词。先去学习页评价几个单词，或收藏想巩固的词。';
}
function articles(){return get(ARTICLES,[]);}
function saveArticles(a){localStorage.setItem(ARTICLES,JSON.stringify(a));}
function saveCurrentArticle(obj){var a=articles();a.unshift(obj);saveArticles(a);return obj;}
function fitArticleTextareas(){['articleSource','articleTranslation'].forEach(function(id){var el=$(id);if(!el)return;el.style.height='auto';el.style.height=Math.max(el.scrollHeight,190)+'px';});}
function escapeHTML(s){return String(s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c];});}
function renderHighlightedArticle(content,targetWords){var safe=escapeHTML(content);(targetWords||[]).filter(Boolean).sort(function(a,b){return b.length-a.length;}).forEach(function(word){var escaped=escapeHTML(word).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');safe=safe.replace(new RegExp('(^|[^A-Za-z])('+escaped+')(?=[^A-Za-z]|$)','gi'),function(_,pre,hit){return pre+'<mark class=\"target-word-mark\">'+hit+'</mark>';});});return safe;}
function showArticle(a){$('articleSource').value=a.content||'';$('articleTranslation').value=a.translation||'';var preview=$('articleSourcePreview');if(preview){preview.innerHTML=renderHighlightedArticle(a.content||'',a.targetWords||[]);preview.hidden=false;$('articleSource').hidden=true;} $('articleStatus').textContent='已载入文章'+(a.difficulty?' · '+(a.difficulty==='cet4'?'四级 CET-4':a.difficulty==='cet6'?'六级 CET-6':a.difficulty):'');if($('articleWordCount'))$('articleWordCount').textContent=(a.wordCount||((a.content||'').match(/\b[\w'-]+\b/g)||[]).length)+' 词';fitArticleTextareas();}
function switchInternalView(name){document.querySelectorAll('.view').forEach(function(v){v.classList.toggle('is-active',v.id==='view-'+name);});document.body.classList.toggle('is-typing-screen',name==='typing');document.documentElement.classList.remove('is-drill-locked');document.body.classList.remove('is-drill-locked');window.scrollTo(0,0);var activeView=$('view-'+name);if(activeView&&name==='article-history'){activeView.scrollTop=0;}}
function historyKey(article,index){return article&&article.id?String(article.id):'legacy-'+index;}
function updateHistorySelection(){
 var list=articles(),checks=Array.prototype.slice.call(document.querySelectorAll('.history-article-check'));
 var chosen=checks.filter(function(c){return c.checked;}).length;
 var count=$('historySelectedCount'),del=$('btnDeleteSelectedArticles'),all=$('historySelectAll');
 if(count)count.textContent='已选择 '+chosen+' 篇';
 if(del)del.disabled=chosen===0;
 if(all){all.checked=checks.length>0&&chosen===checks.length;all.indeterminate=chosen>0&&chosen<checks.length;}
}
function renderHistory(){
 var host=$('articleHistory');if(!host)return;host.innerHTML='';
 var list=articles();
 list.forEach(function(a,index){
  var key=historyKey(a,index),row=document.createElement('div');row.className='article-history-item';row.dataset.historyKey=key;
  var pick=document.createElement('label');pick.className='history-article-pick';pick.setAttribute('aria-label','选择这篇文章');
  var cb=document.createElement('input');cb.type='checkbox';cb.className='history-article-check';cb.checked=!!selectedHistory[key];cb.addEventListener('change',function(){selectedHistory[key]=cb.checked;updateHistorySelection();});pick.appendChild(cb);
  var info=document.createElement('div');info.className='article-history-info';var title=document.createElement('strong');title.textContent=Array.isArray(a.targetWords)&&a.targetWords.length?a.targetWords.join(', '):(a.title||'练习文章');var meta=document.createElement('small');var level=a.difficulty==='cet4'?'四级 CET-4':a.difficulty==='cet6'?'六级 CET-6':a.difficulty||'未标注';var dt=a.createdAt?new Date(a.createdAt).toLocaleString():(a.date||'');meta.textContent=dt+' · '+(a.wordCount||0)+' 词 · '+level;info.append(title,meta);
  var b=document.createElement('button');b.className='ghost-btn';b.textContent='查看';b.addEventListener('click',function(){showArticle(a);switchInternalView('writing');});row.append(pick,info,b);host.appendChild(row);
 });
 if(!host.children.length)host.textContent='还没有保存的文章。';
 updateHistorySelection();
}
function deleteSelectedHistory(){
 var list=articles(),chosen=list.map(function(a,i){return selectedHistory[historyKey(a,i)]?i:-1;}).filter(function(i){return i>=0;});
 if(!chosen.length)return;
 if(!window.confirm('确定删除选中的 '+chosen.length+' 篇历史文章吗？删除后无法恢复。'))return;
 var remove={};chosen.forEach(function(i){remove[i]=true;});
 saveArticles(list.filter(function(a,i){return !remove[i];}));
 selectedHistory={};renderHistory();showToast('已删除 '+chosen.length+' 篇历史文章');
}
function showToast(message,isError){var node=$('rwToast');if(!node){node=document.createElement('div');node.id='rwToast';node.className='rw-toast';node.setAttribute('role','status');document.body.appendChild(node);}node.textContent=message;node.classList.toggle('is-error',!!isError);node.classList.add('is-visible');clearTimeout(window.__rwToastTimer);window.__rwToastTimer=setTimeout(function(){node.classList.remove('is-visible');},3600);}
function setGenerationProgress(state,message){var box=$('aiProgress');var text=$('aiProgressText');if(!box)return;box.classList.remove('is-idle','is-loading','is-success','is-error');box.classList.add('is-'+state);if(text)text.textContent=message||'';box.setAttribute('aria-label',message||'作文生成状态');}

function today(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function prepareTask(){var tasks=get(TASKS,{}),k=active()+':'+today();if(!tasks[k])tasks[k]={bookId:active(),date:today(),status:'待生成',createdAt:Date.now()};localStorage.setItem(TASKS,JSON.stringify(tasks));$('dailyTaskStatus').textContent='今日任务：'+tasks[k].status+'（不会自动调用 AI）';}
function readAISettings(){return get(AI_SETTINGS,{});}
function endpointFor(base){
 var u=new URL(base);
 if(u.protocol!=='https:' && !(u.hostname==='localhost'||u.hostname==='127.0.0.1')) throw new Error('API 地址必须使用 HTTPS（本地调试可使用 localhost）。');
 var p=u.pathname.replace(/\/+$/,'');
 if(/\/chat\/completions$/i.test(p)) return u.toString().replace(/\/+$/,'');
 if(/\/v1$/i.test(p)) u.pathname=p+'/chat/completions';
 else u.pathname=p+'/v1/chat/completions';
 return u.toString().replace(/\/+$/,'');
}
function validateAISettings(settings){
 if(!settings.baseUrl||!settings.apiKey||!settings.model) throw new Error('请填写 API Base URL、API Key 和模型名称。');
 endpointFor(settings.baseUrl);
 return settings;
}
function saveAISettings(showStatus){
 var settings={baseUrl:($('aiBaseUrl').value||'').trim(),apiKey:($('aiApiKey').value||'').trim(),model:($('aiModel').value||'').trim()};
 try{validateAISettings(settings);localStorage.setItem(AI_SETTINGS,JSON.stringify(settings));if(showStatus!==false)$('aiConfigStatus').textContent='设置已保存在当前浏览器。';return settings;}
 catch(e){$('aiConfigStatus').textContent=e.message;throw e;}
}
async function callCompatibleAPI(settings,messages,maxTokens,jsonMode){
 var endpoint=endpointFor(settings.baseUrl);
 var payload={model:settings.model,messages:messages,temperature:0.65,max_tokens:maxTokens||1200};
 if(jsonMode) payload.response_format={type:'json_object'};
 var resp=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+settings.apiKey},body:JSON.stringify(payload)});
 var raw=await resp.json().catch(function(){return {};});
 if(!resp.ok){var detail=raw.error&&raw.error.message?raw.error.message:(resp.status+' '+resp.statusText);throw new Error('API 请求失败：'+detail);}
 var choice=raw.choices&&raw.choices[0];
 var content=choice&&choice.message&&choice.message.content;
 if(Array.isArray(content)) content=content.map(function(x){return (x&&x.text)||'';}).join('');
 if(typeof content!=='string'||!content.trim()) throw new Error('API 返回内容为空，请检查模型是否支持 Chat Completions。');
 return {content:content.trim(),finishReason:(choice&&choice.finish_reason)||''};
}
// 有的模型会带 ```json 围栏、前后解释文字，甚至字符串里直接塞真实换行；
// 这里逐层剥掉再解析，避免明明有内容却判成「不是 JSON」。
function stripFence(text){
 var s=String(text==null?'':text).replace(/^\uFEFF/,'').trim();
 return s.replace(/^```[a-zA-Z]*\s*/,'').replace(/\s*```$/,'').trim();
}
function extractJsonObject(s){
 var start=s.indexOf('{');
 if(start<0) throw new Error('模型没有返回 JSON（返回内容开头：'+s.slice(0,120).replace(/\s+/g,' ')+'…）');
 var depth=0,inStr=false,esc=false;
 for(var i=start;i<s.length;i++){
  var ch=s.charAt(i);
  if(inStr){
   if(esc) esc=false;
   else if(ch==='\\') esc=true;
   else if(ch==='"') inStr=false;
   continue;
  }
  if(ch==='"'){inStr=true;continue;}
  if(ch==='{') depth++;
  else if(ch==='}'){depth--;if(depth===0) return s.slice(start,i+1);}
 }
 return s.slice(start);
}
function repairJsonText(body){
 var out='',inStr=false,esc=false;
 for(var i=0;i<body.length;i++){
  var c=body.charAt(i);
  if(inStr){
   if(esc){out+=c;esc=false;}
   else if(c==='\\'){out+=c;esc=true;}
   else if(c==='"'){out+=c;inStr=false;}
   else if(c==='\n'){out+='\\n';}
   else if(c==='\r'){out+='\\r';}
   else if(c==='\t'){out+='\\t';}
   else out+=c;
  }else{
   if(c==='"') inStr=true;
   out+=c;
  }
 }
 return out;
}
function parseArticleJSON(content){
 var body=extractJsonObject(stripFence(content));
 try{return JSON.parse(body);}catch(e){}
 try{return JSON.parse(repairJsonText(body));}catch(e){
  throw new Error('模型没有返回有效 JSON（返回内容开头：'+body.slice(0,120).replace(/\s+/g,' ')+'…）');
 }
}
// 兼容模型把键名写成中文的情况
function normalizeArticle(data){
 if(!data||typeof data!=='object'||Array.isArray(data)) return {};
 var pick=function(keys){
  for(var i=0;i<keys.length;i++){
   var v=data[keys[i]];
   if(typeof v==='string'&&v.trim()) return v;
  }
  return '';
 };
 return {
  title:pick(['title','标题']),
  content:pick(['content','正文','文章','passage','text']),
  translation:pick(['translation','翻译','中文翻译','译文']),
  difficulty:pick(['difficulty','难度','level'])
 };
}
async function testAISettings(){
 var settings;try{settings=saveAISettings(false);}catch(e){return;}
 $('btnTestAISettings').disabled=true;$('aiConfigStatus').textContent='正在测试连接……';
 try{await callCompatibleAPI(settings,[{role:'user',content:'Reply with exactly: OK'}],16);$('aiConfigStatus').textContent='连接成功：模型已返回内容。';}
 catch(e){$('aiConfigStatus').textContent='连接失败：'+e.message;}
 finally{$('btnTestAISettings').disabled=false;}
}
async function generate(){
 var chosen=weak().filter(function(x){return selected[x.word]!==false;}).slice(0,24);
 if(!chosen.length){$('aiStatus').textContent='没有选中的薄弱词。';setGenerationProgress('error','请先选择目标词');return;}
 var settings;try{settings=validateAISettings(readAISettings());}catch(e){$('aiStatus').textContent='请先打开「AI API 设置」并保存配置：'+e.message;setGenerationProgress('error','配置错误：'+e.message);var panel=$('aiSettingsPanel');if(panel)panel.open=true;return;}
 $('aiStatus').textContent='正在生成并校验文章……';setGenerationProgress('loading','正在生成作文…');$('btnGenerateArticle').disabled=true;
 try{
  var difficulty=$('aiDifficulty').value;
  var levelText=difficulty==='cet4'?'College English Test Band 4 (CET-4), use common intermediate vocabulary and clear sentence structures':'College English Test Band 6 (CET-6), use more varied vocabulary, richer sentence structures and stronger logical connections';
  var prompt='Write an original English learning passage of about 150 words at '+levelText+'. Naturally include EVERY target word exactly as written (same spelling; do not change inflection). Avoid a list-like style. Then provide a faithful Simplified Chinese translation. Return ONLY a single JSON object (no markdown, no code fence, no explanation) with keys title, content, translation, difficulty. Set difficulty to exactly "'+difficulty+'". Inside JSON strings use \\n for line breaks; never put a raw line break inside a string. Target words: '+chosen.map(function(x){return x.word;}).join(', ')+'.';
  var messages=[{role:'system',content:'You are an English-learning writing assistant. Reply with one valid JSON object and nothing else.'},{role:'user',content:prompt}];
  var answer;
  // 部分服务商不支持 response_format；报错就退回普通模式
  try{answer=await callCompatibleAPI(settings,messages,2400,true);}
  catch(e1){
   if(/response_format|json_object|not support|unsupported|invalid.*(parameter|field)|未知参数/i.test(e1.message)) answer=await callCompatibleAPI(settings,messages,2400,false);
   else throw e1;
  }
  var data;
  try{data=normalizeArticle(parseArticleJSON(answer.content));}
  catch(parseErr){
   // 让模型按同一上下文再输出一次纯 JSON，通常第二次就对了
   var fixMessages=messages.concat([
    {role:'assistant',content:String(answer.content).slice(0,3000)},
    {role:'user',content:'Your previous reply was not valid JSON. Reply again with ONLY the JSON object (title, content, translation, difficulty). Escape newlines as \\n and do not wrap it in markdown.'}
   ]);
   var retry=await callCompatibleAPI(settings,fixMessages,2400,false);
   try{data=normalizeArticle(parseArticleJSON(retry.content));}
   catch(e2){throw new Error(e2.message+(answer.finishReason==='length'?'（首次返回疑似被输出上限截断）':'')+'。可换一个更听话的模型，或再试一次。');}
  }
  if(!data.content||!data.translation)throw new Error('返回内容缺少英文正文或中文翻译');
  var lower=String(data.content).toLowerCase(),missing=chosen.filter(function(x){return !new RegExp('(^|[^a-z])'+x.word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^a-z]|$)','i').test(lower);});
  if(missing.length)throw new Error('文章未覆盖全部目标词：'+missing.map(function(x){return x.word;}).join(', '));
  var wc=(String(data.content).match(/\b[\w'-]+\b/g)||[]).length;
  if(wc<100||wc>190)throw new Error('文章长度为 '+wc+' 词，未达到约 150 词要求，请重试');
  var a=saveCurrentArticle({id:'article-'+Date.now(),bookId:active(),date:today(),title:data.title||'Daily weak-word writing',content:String(data.content),translation:String(data.translation),targetWords:chosen.map(function(x){return x.word;}),difficulty:difficulty,wordCount:wc,createdAt:new Date().toISOString(),provider:settings.model});
  showArticle(a);chosen.forEach(function(x){selected[x.word]=false;});renderWeak();$('aiStatus').textContent='生成成功';setGenerationProgress('success','生成成功 · '+wc+' 词');
  var tasks=get(TASKS,{}),k=active()+':'+today();tasks[k]={bookId:active(),date:today(),status:'已生成',articleId:a.id,createdAt:Date.now()};localStorage.setItem(TASKS,JSON.stringify(tasks));
 }catch(e){$('aiStatus').textContent='生成失败：'+e.message;setGenerationProgress('error','生成失败：'+e.message);}
 finally{$('btnGenerateArticle').disabled=false;}
}
function backup(){
 var data={format:'review-words-backup',version:1,exportedAt:new Date().toISOString(),items:{}};
 for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&k!==AI_SETTINGS&&(/^(wordtype\.v1|reviewwords\.)/.test(k)))data.items[k]=localStorage.getItem(k);}
 var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='review-words-backup-'+today()+'.json';a.click();setTimeout(function(){URL.revokeObjectURL(a.href);},1000);$('backupStatus').textContent='已导出 '+Object.keys(data.items).length+' 项本地数据。';
}
function restore(file){
 var reader=new FileReader();reader.onload=function(){try{var d=JSON.parse(String(reader.result||''));if(d.format!=='review-words-backup'||!d.items)throw new Error('不是有效的 Review Words 备份文件');if(!confirm('恢复将覆盖备份中同名的数据键，建议先导出当前备份。确定继续吗？'))return;Object.keys(d.items).forEach(function(k){if(k!==AI_SETTINGS&&/^(wordtype\.v1|reviewwords\.)/.test(k))localStorage.setItem(k,String(d.items[k]));});$('backupStatus').textContent='恢复成功，页面即将重新载入。';setTimeout(function(){location.reload();},500);}catch(e){$('backupStatus').textContent='恢复失败：'+e.message;}};reader.readAsText(file,'UTF-8');
}
function editDistance(a,b){var prev=Array.from({length:b.length+1},function(_,i){return i;}),cur=[];for(var i=1;i<=a.length;i++){cur=[i];for(var j=1;j<=b.length;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=cur;}return prev[b.length];}
function renderTypingStats(){var list=get('reviewwords.typingRecords.v1',[]);var n=list.length,avgW=n?Math.round(list.reduce(function(s,x){return s+(x.wpm||0);},0)/n):0,avgA=n?Math.round(list.reduce(function(s,x){return s+(x.accuracy||0);},0)/n*100):0,errs=list.reduce(function(s,x){return s+(x.errors||0);},0);if($('typingSessions'))$('typingSessions').textContent=n;if($('typingAvgWpm'))$('typingAvgWpm').textContent=avgW;if($('typingAvgAcc'))$('typingAvgAcc').textContent=avgA+'%';if($('typingTotalErrors'))$('typingTotalErrors').textContent=errs;if($('typingRecent')){$('typingRecent').innerHTML='';list.slice(0,8).forEach(function(x){var row=document.createElement('div');row.className='article-history-item';var t=document.createElement('span');t.textContent=x.date+' · '+x.mode+' · '+x.wpm+' WPM · '+Math.round(x.accuracy*100)+'% · '+x.errors+' 处差异';row.appendChild(t);$('typingRecent').appendChild(row);});if(!n)$('typingRecent').textContent='完成作文训练后，这里会显示成绩。';}}
function bind(){
 if(!$('weakWordList'))return;
 var cfg=readAISettings();if(cfg.baseUrl)$('aiBaseUrl').value=cfg.baseUrl;if(cfg.apiKey)$('aiApiKey').value=cfg.apiKey;if(cfg.model)$('aiModel').value=cfg.model;
 renderWeak();renderTypingStats();$('articleSource').addEventListener('input',function(){fitArticleTextareas();if($('articleWordCount'))$('articleWordCount').textContent=(($('articleSource').value.match(/\b[\w'-]+\b/g)||[]).length)+' 词';});$('articleTranslation').addEventListener('input',fitArticleTextareas);$('btnGenerateArticle').addEventListener('click',generate);$('btnSaveAISettings').addEventListener('click',function(){try{saveAISettings(true);}catch(e){}});$('btnTestAISettings').addEventListener('click',testAISettings);$('btnShowHistory').addEventListener('click',function(){renderHistory();switchInternalView('article-history');});if($('btnHistoryBack'))$('btnHistoryBack').addEventListener('click',function(){switchInternalView('writing');});if($('historySelectAll'))$('historySelectAll').addEventListener('change',function(){var checks=document.querySelectorAll('.history-article-check');Array.prototype.forEach.call(checks,function(cb){cb.checked=$('historySelectAll').checked;var row=cb.closest('.article-history-item');if(row)selectedHistory[row.dataset.historyKey]=cb.checked;});updateHistorySelection();});if($('btnDeleteSelectedArticles'))$('btnDeleteSelectedArticles').addEventListener('click',deleteSelectedHistory);
 $('btnExportBackup').addEventListener('click',backup);$('backupFile').addEventListener('change',function(){if(this.files[0])restore(this.files[0]);});
 $('btnSubmitWriting').addEventListener('click',function(){var source=$('articleSource').value,typed=$('writingInput').value;if(!source)return;var dist=editDistance(source,typed),max=Math.max(source.length,typed.length);var mins=Math.max((Date.now()-Number(window.__rwTypingStarted||Date.now()))/60000,1/60000);var rec=get('reviewwords.typingRecords.v1',[]);var accuracy=max?Math.max(0,1-dist/max):0;var correctChars=Math.max(0,source.length-dist);rec.unshift({bookId:active(),date:today(),mode:document.querySelector('[data-typing-mode].is-active')?.dataset.typingMode||'strict',accuracy:accuracy,errors:dist,wpm:Math.round(correctChars/5/mins),durationMs:mins*60000,articleId:articles()[0]?.id||null,article:source.slice(0,120)});localStorage.setItem('reviewwords.typingRecords.v1',JSON.stringify(rec.slice(0,500)));renderTypingStats();},true);
 document.querySelectorAll('.nav-btn[data-view="writing"]').forEach(function(b){b.addEventListener('click',renderWeak);});document.querySelectorAll('.nav-btn[data-view="stats"]').forEach(function(b){b.addEventListener('click',renderTypingStats);});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
})();