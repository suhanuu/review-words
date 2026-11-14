(function(){
'use strict';
var $=function(id){return document.getElementById(id);};
var BOOKS_KEY='reviewwords.books.v1', ACTIVE_KEY='reviewwords.activeBook.v1', PREFIX='wordtype.v1:book:', ARTICLES='reviewwords.articles.v1', TASKS='reviewwords.dailyTasks.v1', AI_SETTINGS='reviewwords.aiSettings.v1', SELECTION='reviewwords.weakSelection.v1';
var RECOMMEND_MIN=6, RECOMMEND_MAX=12, SWEET_MIN=8, SWEET_MAX=10, HARD_MAX=24, DEFAULT_PICK=10;
// 文案只在这里拼：以后调整区间，页面上的说明、计数、确认弹窗会一起变
function rangeText(){return RECOMMEND_MIN+'–'+RECOMMEND_MAX;}
function sweetText(){return SWEET_MIN+'–'+SWEET_MAX;}
function get(k,d){try{return JSON.parse(localStorage.getItem(k)||'null')||d;}catch(e){return d;}}
function active(){return localStorage.getItem(ACTIVE_KEY)||'redbook-2024';}
function archive(){return get(PREFIX+active(),{});}
function words(){var b=archive(), list=active()==='redbook-2024'?(window.WORD_BANK||[]).concat(b.custom||[]):(b.custom||[]);var m={};list.forEach(function(w){if(w&&w.w)m[w.w]=w;});return m;}
function weak(){
 var d=archive(), rec=d.records||{}, all=words(), map={};
 Object.keys(rec).forEach(function(w){var r=rec[w]||{};
  if(r.last===1||(r.forgot||0)>0) map[w]={word:w,group:'forgot',rank:3,meaning:(all[w]||{}).m||''};
  else if(r.last===2) map[w]={word:w,group:'fuzzy',rank:2,meaning:(all[w]||{}).m||''};
 });
 // 仅收藏的词不进入选词池：收藏由「我的收藏」页承载
 return Object.keys(map).map(function(k){return map[k];}).sort(function(a,b){return b.rank-a.rank||a.word.localeCompare(b.word);});
}
function weakGroups(){
 var out={forgot:[],fuzzy:[]};
 weak().forEach(function(x){out[x.group].push(x);});
 return out;
}
function selectionMap(){var m=get(SELECTION,{});return (m&&typeof m==='object'&&!Array.isArray(m))?m:{};}
function saveSelectionMap(m){localStorage.setItem(SELECTION,JSON.stringify(m));}
function defaultSelection(){return weak().slice(0,DEFAULT_PICK).map(function(x){return x.word;});}
// 三态：未初始化（无键 / null）自动选 10；用户清空（[]）不回填；池变动只做 prune
function getSelection(){
 var m=selectionMap(),k=active();
 if(!Object.prototype.hasOwnProperty.call(m,k)||m[k]===null){
  var init=defaultSelection();
  if(!init.length)return [];           // 池为空时保持未初始化，等有词后再自动选
  m[k]=init;saveSelectionMap(m);return init.slice();
 }
 var saved=Array.isArray(m[k])?m[k].slice():[],pool=Object.create(null);
 weak().forEach(function(x){pool[x.word]=true;});
 var pruned=saved.filter(function(w){return !!pool[w];});
 if(pruned.length!==saved.length){m[k]=pruned;saveSelectionMap(m);}
 return pruned;
}
function saveSelection(list){var m=selectionMap();m[active()]=list.slice();saveSelectionMap(m);}

var selectedHistory={};
var draft=[];

function renderWeak(){
 var host=$('weakWordList');if(!host)return;
 host.innerHTML='';
 var chosen=getSelection(),pool=weak(),byWord={};
 pool.forEach(function(x){byWord[x.word]=x;});
 chosen.forEach(function(w){
  var x=byWord[w]||{word:w,group:'fuzzy'};
  var lab=document.createElement('label');lab.className='weak-word-chip is-selected';
  var span=document.createElement('span');span.textContent=x.word;
  var small=document.createElement('small');small.textContent=x.group==='forgot'?'忘了':'模糊';
  lab.append(span,small);host.appendChild(lab);
 });
 if(!chosen.length)host.textContent='暂未选择目标词，点「查看 / 选择」开始。';
 var fresh=pool.filter(function(x){return chosen.indexOf(x.word)<0;}).length;
 $('weakPoolCount').textContent='已选 '+chosen.length+' / '+pool.length+' 个词 · 建议 '+rangeText();
 var note=$('weakPoolNote');
 if(note)note.textContent=chosen.length
  ? '本次生成只使用上面的 '+chosen.length+' 个词；点「查看 / 选择」调整。'+(fresh?'另有 '+fresh+' 个新薄弱词未选。':'')
  : '还没有选择目标词，点「查看 / 选择」开始选词。';
}

function syncNav(name){document.querySelectorAll('.nav-btn[data-view]').forEach(function(b){b.classList.toggle('is-active',b.dataset.view===name);});}
function pickerGroup(hostId,countId,group){
 var host=$(hostId);if(!host)return;
 host.innerHTML='';
 var items=weakGroups()[group];
 items.forEach(function(x){
  var lab=document.createElement('label');lab.className='weak-word-chip';
  var cb=document.createElement('input');cb.type='checkbox';cb.checked=draft.indexOf(x.word)>=0;
  cb.addEventListener('change',function(){
   var i=draft.indexOf(x.word);
   if(cb.checked&&i<0)draft.push(x.word);
   else if(!cb.checked&&i>=0)draft.splice(i,1);
   updatePickerBar();
  });
  var span=document.createElement('span');span.textContent=x.word;
  lab.append(cb,span);host.appendChild(lab);
 });
 if(!items.length){var p=document.createElement('p');p.className='weak-picker-group-empty';p.textContent='这一组暂时没有词。';host.appendChild(p);}
 if($(countId))$(countId).textContent=items.length+' 个词';
}
function renderPickerGroups(){pickerGroup('weakGroupForgot','weakGroupForgotCount','forgot');pickerGroup('weakGroupFuzzy','weakGroupFuzzyCount','fuzzy');}
function updatePickerBar(){
 var n=draft.length,bar=$('weakPickerBar'),tip=$('weakPickerTip'),count=$('weakPickerCount'),hint=$('weakPickerHint');
 var state=n>RECOMMEND_MAX?'warn':(n>0&&n<RECOMMEND_MIN?'low':'ok');
 [bar,tip].forEach(function(node){if(!node)return;node.classList.remove('is-ok','is-low','is-warn');node.classList.add('is-'+state);});
 if(count)count.textContent='已选 '+n+' 个';
 if(hint)hint.textContent=n>RECOMMEND_MAX
  ? '超过建议区间，生成前会再确认一次；目标词多容易漏词、需要重试，更费 token。'
  : (n>0&&n<RECOMMEND_MIN?'选得偏少，练习强度可能不足（仍可生成）。':(n?'在建议区间内。':'请先选择目标词。'));
}
function renderWeakPicker(){
 draft=getSelection().slice();
 renderPickerGroups();
 var empty=$('weakPickerEmpty');if(empty)empty.hidden=weak().length>0;
 updatePickerBar();
}
function openWeakPicker(){renderWeakPicker();switchInternalView('weak-words');syncNav('writing');}
function sameSet(a,b){
 if(a.length!==b.length)return false;
 var x=a.slice().sort(),y=b.slice().sort();
 for(var i=0;i<x.length;i++){if(x[i]!==y[i])return false;}
 return true;
}
function backWeakPicker(){
 var saved=getSelection();
 if(!sameSet(draft,saved)&&!window.confirm('还有勾选没确认，返回会丢掉这些改动。确定返回吗？'))return;
 draft=saved.slice();switchInternalView('writing');syncNav('writing');renderWeak();
}
function setPickerGroup(group,on){
 var wordsInGroup=weakGroups()[group].map(function(x){return x.word;});
 draft=draft.filter(function(w){return wordsInGroup.indexOf(w)<0;});
 if(on)wordsInGroup.forEach(function(w){if(draft.indexOf(w)<0)draft.push(w);});
 renderPickerGroups();updatePickerBar();
}
function autoPick(){draft=defaultSelection();renderPickerGroups();updatePickerBar();}
function confirmWeakPicker(){
 if(draft.length>HARD_MAX){showToast('最多只能选 '+HARD_MAX+' 个目标词，请先减少。',true);return;}
 saveSelection(draft);renderWeak();switchInternalView('writing');syncNav('writing');
 showToast('已保存 '+draft.length+' 个目标词');
}
function articles(){return get(ARTICLES,[]);}
function saveArticles(a){localStorage.setItem(ARTICLES,JSON.stringify(a));}
function saveCurrentArticle(obj){var a=articles();a.unshift(obj);saveArticles(a);return obj;}
function fitArticleTextareas(){['articleSource','articleTranslation'].forEach(function(id){var el=$(id);if(!el)return;el.style.height='auto';el.style.height=Math.max(el.scrollHeight,190)+'px';});}
function escapeHTML(s){return String(s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c];});}
function renderHighlightedArticle(content,targetWords){var safe=escapeHTML(content);(targetWords||[]).filter(Boolean).sort(function(a,b){return b.length-a.length;}).forEach(function(word){var escaped=escapeHTML(word).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');safe=safe.replace(new RegExp('(^|[^A-Za-z])('+escaped+')(?=[^A-Za-z]|$)','gi'),function(_,pre,hit){return pre+'<mark class=\"target-word-mark\">'+hit+'</mark>';});});return safe;}
function showArticle(a){$('articleSource').value=a.content||'';$('articleTranslation').value=a.translation||'';var preview=$('articleSourcePreview');if(preview){preview.innerHTML=renderHighlightedArticle(a.content||'',a.targetWords||[]);preview.hidden=false;$('articleSource').hidden=true;} $('articleStatus').textContent='已载入文章'+(a.difficulty?' · '+(a.difficulty==='cet4'?'四级 CET-4':a.difficulty==='cet6'?'六级 CET-6':a.difficulty==='kaoyan'?'考研英语':a.difficulty):'');if($('articleWordCount'))$('articleWordCount').textContent=(a.wordCount||((a.content||'').match(/\b[\w'-]+\b/g)||[]).length)+' 词';fitArticleTextareas();}
function switchInternalView(name){document.querySelectorAll('.view').forEach(function(v){v.classList.toggle('is-active',v.id==='view-'+name);});document.body.classList.toggle('is-typing-screen',name==='typing');document.documentElement.classList.remove('is-drill-locked');document.body.classList.remove('is-drill-locked');window.scrollTo(0,0);var activeView=$('view-'+name);if(activeView&&(name==='article-history'||name==='weak-words')){activeView.scrollTop=0;}}
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
  var info=document.createElement('div');info.className='article-history-info';var title=document.createElement('strong');title.textContent=Array.isArray(a.targetWords)&&a.targetWords.length?a.targetWords.join(', '):(a.title||'练习文章');var meta=document.createElement('small');var level=a.difficulty==='cet4'?'四级 CET-4':a.difficulty==='cet6'?'六级 CET-6':a.difficulty==='kaoyan'?'考研英语':a.difficulty||'未标注';var dt=a.createdAt?new Date(a.createdAt).toLocaleString():(a.date||'');meta.textContent=dt+' · '+(a.wordCount||0)+' 词 · '+level;info.append(title,meta);
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
 var chosenWords=getSelection();
 if(!chosenWords.length){$('aiStatus').textContent='还没有选择目标词。';setGenerationProgress('error','请先选择目标词');openWeakPicker();return;}
 if(chosenWords.length>HARD_MAX){$('aiStatus').textContent='目标词过多。';setGenerationProgress('error','最多 '+HARD_MAX+' 个目标词，请先减少');openWeakPicker();return;}
 if(chosenWords.length>RECOMMEND_MAX&&!window.confirm('本次选择了 '+chosenWords.length+' 个目标词，超过建议的 '+rangeText()+' 个。目标词越多，模型越容易漏词、需要重试，会明显增加 token 消耗。仍要继续生成吗？')){setGenerationProgress('idle','');return;}
 var chosen=chosenWords.map(function(w){return {word:w};});
 var settings;try{settings=validateAISettings(readAISettings());}catch(e){$('aiStatus').textContent='请先打开「AI API 设置」并保存配置：'+e.message;setGenerationProgress('error','配置错误：'+e.message);var panel=$('aiSettingsPanel');if(panel)panel.open=true;return;}
 $('aiStatus').textContent='正在生成并校验文章……';setGenerationProgress('loading','正在生成作文（'+chosen.length+' 个目标词）…');$('btnGenerateArticle').disabled=true;
 try{
  var difficulty=$('aiDifficulty').value;
  var levelText=difficulty==='cet4'
    ?'College English Test Band 4 (CET-4) level: roughly 4,500-word vocabulary, everyday and campus topics, clear and simple sentence structures, no rare or archaic words'
    :difficulty==='kaoyan'
      ?'Chinese postgraduate entrance exam (Kaoyan) English level: roughly 5,500-6,000-word academic vocabulary, longer and more complex sentences with subordination, formal register, no first-person narration'
      :'College English Test Band 6 (CET-6) level: roughly 6,000-word vocabulary, more varied wording, richer sentence structures and stronger logical links';
  var structure=difficulty==='kaoyan'
    ?' Write it as a three-paragraph argumentative essay with a fixed structure: paragraph 1 introduces the topic and states a clear thesis; paragraph 2 develops the thesis with one or two reasons and one concrete example; paragraph 3 restates the thesis and closes with a forward-looking sentence. Avoid "I think / in my opinion" and keep the voice objective and general.'
    :'';
  var prompt='Write an original English learning passage of about 150 words at '+levelText+'.'+structure+' Naturally include EVERY target word exactly as written (same spelling; do not change inflection). Avoid a list-like style. Then provide a faithful Simplified Chinese translation. Return ONLY a single JSON object (no markdown, no code fence, no explanation) with keys title, content, translation, difficulty. Set difficulty to exactly "'+difficulty+'". Inside JSON strings use \\n for line breaks; never put a raw line break inside a string. Target words: '+chosen.map(function(x){return x.word;}).join(', ')+'.';
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
 // 本批词生成成功后移出选择集，方便接着选下一批；用 toast 说明去向，避免以为词丢了
 showArticle(a);
 saveSelection(getSelection().filter(function(w){return chosenWords.indexOf(w)<0;}));
 renderWeak();
 var restCount=getSelection().length;
 showToast('本批 '+chosenWords.length+' 个词已完成'+(restCount?'，还剩 '+restCount+' 个待选':'，今日薄弱词已全部完成'));
 $('aiStatus').textContent='生成成功';setGenerationProgress('success','生成成功 · '+wc+' 词');
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
 renderWeak();renderTypingStats();
 // 区间与默认数量只在常量里维护，这里一次性写进说明文案
 if($('weakPickerTipText'))$('weakPickerTipText').innerHTML='建议每次选 <strong>'+rangeText()+'</strong> 个词（推荐 '+sweetText()+'）。目标词过多时模型容易漏词、需要重试，反而更费 token；最多可选 '+HARD_MAX+' 个。';
 if($('btnWeakAutoPick'))$('btnWeakAutoPick').textContent='按优先级自动选 '+DEFAULT_PICK+' 个';
 $('btnOpenWeakPicker').addEventListener('click',openWeakPicker);
 if($('btnWeakPickerBack'))$('btnWeakPickerBack').addEventListener('click',backWeakPicker);
 if($('btnWeakAutoPick'))$('btnWeakAutoPick').addEventListener('click',autoPick);
 if($('btnWeakConfirm'))$('btnWeakConfirm').addEventListener('click',confirmWeakPicker);
 document.querySelectorAll('[data-group-all]').forEach(function(b){b.addEventListener('click',function(){setPickerGroup(b.dataset.groupAll,true);});});
 document.querySelectorAll('[data-group-none]').forEach(function(b){b.addEventListener('click',function(){setPickerGroup(b.dataset.groupNone,false);});});
 $('articleSource').addEventListener('input',function(){fitArticleTextareas();if($('articleWordCount'))$('articleWordCount').textContent=(($('articleSource').value.match(/\b[\w'-]+\b/g)||[]).length)+' 词';});$('articleTranslation').addEventListener('input',fitArticleTextareas);$('btnGenerateArticle').addEventListener('click',generate);$('btnSaveAISettings').addEventListener('click',function(){try{saveAISettings(true);}catch(e){}});$('btnTestAISettings').addEventListener('click',testAISettings);$('btnShowHistory').addEventListener('click',function(){renderHistory();switchInternalView('article-history');});if($('btnHistoryBack'))$('btnHistoryBack').addEventListener('click',function(){switchInternalView('writing');});if($('historySelectAll'))$('historySelectAll').addEventListener('change',function(){var checks=document.querySelectorAll('.history-article-check');Array.prototype.forEach.call(checks,function(cb){cb.checked=$('historySelectAll').checked;var row=cb.closest('.article-history-item');if(row)selectedHistory[row.dataset.historyKey]=cb.checked;});updateHistorySelection();});if($('btnDeleteSelectedArticles'))$('btnDeleteSelectedArticles').addEventListener('click',deleteSelectedHistory);
 $('btnExportBackup').addEventListener('click',backup);$('backupFile').addEventListener('change',function(){if(this.files[0])restore(this.files[0]);});
 $('btnSubmitWriting').addEventListener('click',function(){var source=$('articleSource').value,typed=$('writingInput').value;if(!source)return;var dist=editDistance(source,typed),max=Math.max(source.length,typed.length);var mins=Math.max((Date.now()-Number(window.__rwTypingStarted||Date.now()))/60000,1/60000);var rec=get('reviewwords.typingRecords.v1',[]);var accuracy=max?Math.max(0,1-dist/max):0;var correctChars=Math.max(0,source.length-dist);rec.unshift({bookId:active(),date:today(),mode:document.querySelector('[data-typing-mode].is-active')?.dataset.typingMode||'strict',accuracy:accuracy,errors:dist,wpm:Math.round(correctChars/5/mins),durationMs:mins*60000,articleId:articles()[0]?.id||null,article:source.slice(0,120)});localStorage.setItem('reviewwords.typingRecords.v1',JSON.stringify(rec.slice(0,500)));renderTypingStats();},true);
 document.querySelectorAll('.nav-btn[data-view="writing"]').forEach(function(b){b.addEventListener('click',function(){renderWeak();syncNav('writing');});});document.querySelectorAll('.nav-btn[data-view="stats"]').forEach(function(b){b.addEventListener('click',renderTypingStats);});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
})();
/* ---------- 手机底部导航：「更多」面板（UI 第 3 步） ---------- */
(function () {
  var tabbar = document.getElementById('tabbar');
  if (!tabbar) return;
  var sheet = document.getElementById('moreSheet');
  var mask = document.getElementById('moreMask');
  var moreBtn = document.getElementById('btnMore');
  var closeBtn = document.getElementById('btnMoreClose');
  if (!sheet || !mask || !moreBtn) return;

  function isOpen() { return sheet.classList.contains('open'); }
  function open() {
    sheet.classList.add('open');
    mask.classList.add('open');
    document.body.classList.add('more-open');
    moreBtn.setAttribute('aria-expanded', 'true');
    sheet.setAttribute('aria-hidden', 'false');
  }
  function close() {
    sheet.classList.remove('open');
    mask.classList.remove('open');
    document.body.classList.remove('more-open');
    moreBtn.setAttribute('aria-expanded', 'false');
    sheet.setAttribute('aria-hidden', 'true');
  }
  function go(view) {
    close();
    var target = document.querySelector('.nav-btn[data-view="' + view + '"]');
    if (target) target.click();
  }
  function syncMore() {
    var active = document.querySelector('.view.is-active');
    var name = active ? active.id.replace('view-', '') : '';
    moreBtn.classList.toggle('is-active', name === 'books' || name === 'words' || name === 'favs');
  }

  moreBtn.addEventListener('click', function () { isOpen() ? close() : open(); });
  mask.addEventListener('click', close);
  if (closeBtn) closeBtn.addEventListener('click', close);
  Array.prototype.forEach.call(sheet.querySelectorAll('[data-goto]'), function (b) {
    b.addEventListener('click', function () { go(b.getAttribute('data-goto')); });
  });
  var settingsBtn = document.getElementById('moreSettings');
  if (settingsBtn) settingsBtn.addEventListener('click', function () {
    close();
    var t = document.getElementById('btnSettings');
    if (t) t.click();
  });
  var themeBtn = document.getElementById('moreTheme');
  if (themeBtn) themeBtn.addEventListener('click', function () {
    close();
    var t = document.getElementById('btnTheme');
    if (t) t.click();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen()) close(); });
  tabbar.addEventListener('click', function (e) {
    if (e.target.closest('#btnMore')) return;
    if (isOpen()) close();
  });
  var main = document.querySelector('.main');
  if (main && window.MutationObserver) {
    new MutationObserver(syncMore).observe(main, { attributes: true, attributeFilter: ['class'], subtree: true });
  }
  syncMore();
})();