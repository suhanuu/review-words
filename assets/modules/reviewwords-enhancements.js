(function(){
'use strict';
var $=function(id){return document.getElementById(id);};
var BOOKS_KEY='reviewwords.books.v1', ACTIVE_KEY='reviewwords.activeBook.v1', PREFIX='wordtype.v1:book:', ARTICLES='reviewwords.articles.v1', TASKS='reviewwords.dailyTasks.v1', WORKER='reviewwords.workerUrl.v1';
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
function renderWeak(){
 var host=$('weakWordList');if(!host)return;host.innerHTML='';var list=weak();
 list.forEach(function(x){if(selected[x.word]===undefined)selected[x.word]=true;var lab=document.createElement('label');lab.className='weak-word-chip';var cb=document.createElement('input');cb.type='checkbox';cb.checked=!!selected[x.word];cb.addEventListener('change',function(){selected[x.word]=cb.checked;});var span=document.createElement('span');span.textContent=x.word;var small=document.createElement('small');small.textContent=x.source.join(' / ');lab.append(cb,span,small);host.appendChild(lab);});
 $('weakPoolCount').textContent=list.length+' 个词 · '+list.filter(function(x){return selected[x.word]!==false;}).length+' 个已选';
 if(!list.length)host.textContent='暂时没有薄弱词。先去学习页评价几个单词，或收藏想巩固的词。';
}
function articles(){return get(ARTICLES,[]);}
function saveArticles(a){localStorage.setItem(ARTICLES,JSON.stringify(a));}
function saveCurrentArticle(obj){var a=articles();a.unshift(obj);saveArticles(a);return obj;}
function showArticle(a){$('articleSource').value=a.content||'';$('articleTranslation').value=a.translation||'';$('articleStatus').textContent='已载入文章';}
function renderHistory(){
 var host=$('articleHistory');if(!host)return;host.hidden=false;host.innerHTML='';
 articles().slice(0,30).forEach(function(a){var row=document.createElement('div');row.className='article-history-item';var t=document.createElement('span');t.textContent=(a.title||'练习文章')+' · '+(a.createdAt||'').slice(0,10)+' · '+(a.wordCount||0)+' 词';var b=document.createElement('button');b.textContent='载入';b.addEventListener('click',function(){showArticle(a);});row.append(t,b);host.appendChild(row);});
 if(!host.children.length)host.textContent='还没有保存的文章。';
}
function today(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function prepareTask(){var tasks=get(TASKS,{}),k=active()+':'+today();if(!tasks[k])tasks[k]={bookId:active(),date:today(),status:'待生成',createdAt:Date.now()};localStorage.setItem(TASKS,JSON.stringify(tasks));$('dailyTaskStatus').textContent='今日任务：'+tasks[k].status+'（不会自动调用 AI）';}
async function generate(){
 var chosen=weak().filter(function(x){return selected[x.word]!==false;}).slice(0,24);
 if(!chosen.length){$('aiStatus').textContent='没有选中的薄弱词。';return;}
 var url=($('aiWorkerUrl').value||'').trim();if(!url){$('aiStatus').textContent='请先填写 Cloudflare Worker HTTPS 地址。';return;}
 localStorage.setItem(WORKER,url);$('aiStatus').textContent='正在生成并校验文章……';$('btnGenerateArticle').disabled=true;
 try{
  var resp=await fetch(url.replace(/\/$/,'')+'/generate-article',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({words:chosen.map(function(x){return x.word;}),difficulty:$('aiDifficulty').value,targetLength:150,language:'en',includeTranslation:true})});
  if(!resp.ok)throw new Error('服务端返回 '+resp.status);
  var data=await resp.json();if(!data.content||!data.translation)throw new Error('返回内容缺少英文正文或中文翻译');
  var lower=data.content.toLowerCase(),missing=chosen.filter(function(x){return !new RegExp('(^|[^a-z])'+x.word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^a-z]|$)','i').test(lower);});
  if(missing.length)throw new Error('文章未覆盖全部目标词：'+missing.map(function(x){return x.word;}).join(', '));
  var wc=(data.content.match(/\b[\w'-]+\b/g)||[]).length;
  if(wc<100||wc>190)throw new Error('文章长度为 '+wc+' 词，未达到约 150 词要求，请重试');
  var a=saveCurrentArticle({id:'article-'+Date.now(),bookId:active(),date:today(),title:data.title||'Daily weak-word writing',content:data.content,translation:data.translation,targetWords:chosen.map(function(x){return x.word;}),difficulty:data.difficulty||$('aiDifficulty').value,wordCount:wc,createdAt:new Date().toISOString(),provider:data.provider||'cloudflare-worker'});
  showArticle(a);chosen.forEach(function(x){selected[x.word]=false;});renderWeak();$('aiStatus').textContent='生成成功，已保存；本批目标词 '+chosen.length+' 个，正文 '+wc+' 词。剩余已选词可继续生成下一篇。';
  var tasks=get(TASKS,{}),k=active()+':'+today();tasks[k]={bookId:active(),date:today(),status:'已生成',articleId:a.id,createdAt:Date.now()};localStorage.setItem(TASKS,JSON.stringify(tasks));$('dailyTaskStatus').textContent='今日任务：已生成';
 }catch(e){$('aiStatus').textContent='生成失败：'+e.message;}
 finally{$('btnGenerateArticle').disabled=false;}
}
function backup(){
 var data={format:'review-words-backup',version:1,exportedAt:new Date().toISOString(),items:{}};
 for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&(/^(wordtype\.v1|reviewwords\.)/.test(k)))data.items[k]=localStorage.getItem(k);}
 var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='review-words-backup-'+today()+'.json';a.click();setTimeout(function(){URL.revokeObjectURL(a.href);},1000);$('backupStatus').textContent='已导出 '+Object.keys(data.items).length+' 项本地数据。';
}
function restore(file){
 var reader=new FileReader();reader.onload=function(){try{var d=JSON.parse(String(reader.result||''));if(d.format!=='review-words-backup'||!d.items)throw new Error('不是有效的 Review Words 备份文件');if(!confirm('恢复将覆盖备份中同名的数据键，建议先导出当前备份。确定继续吗？'))return;Object.keys(d.items).forEach(function(k){if(/^(wordtype\.v1|reviewwords\.)/.test(k))localStorage.setItem(k,String(d.items[k]));});$('backupStatus').textContent='恢复成功，页面即将重新载入。';setTimeout(function(){location.reload();},500);}catch(e){$('backupStatus').textContent='恢复失败：'+e.message;}};reader.readAsText(file,'UTF-8');
}
function editDistance(a,b){var prev=Array.from({length:b.length+1},function(_,i){return i;}),cur=[];for(var i=1;i<=a.length;i++){cur=[i];for(var j=1;j<=b.length;j++)cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=cur;}return prev[b.length];}
function renderTypingStats(){var list=get('reviewwords.typingRecords.v1',[]);var n=list.length,avgW=n?Math.round(list.reduce(function(s,x){return s+(x.wpm||0);},0)/n):0,avgA=n?Math.round(list.reduce(function(s,x){return s+(x.accuracy||0);},0)/n*100):0,errs=list.reduce(function(s,x){return s+(x.errors||0);},0);if($('typingSessions'))$('typingSessions').textContent=n;if($('typingAvgWpm'))$('typingAvgWpm').textContent=avgW;if($('typingAvgAcc'))$('typingAvgAcc').textContent=avgA+'%';if($('typingTotalErrors'))$('typingTotalErrors').textContent=errs;if($('typingRecent')){$('typingRecent').innerHTML='';list.slice(0,8).forEach(function(x){var row=document.createElement('div');row.className='article-history-item';var t=document.createElement('span');t.textContent=x.date+' · '+x.mode+' · '+x.wpm+' WPM · '+Math.round(x.accuracy*100)+'% · '+x.errors+' 处差异';row.appendChild(t);$('typingRecent').appendChild(row);});if(!n)$('typingRecent').textContent='完成作文训练后，这里会显示成绩。';}}
function bind(){
 if(!$('weakWordList'))return;
 var u=localStorage.getItem(WORKER);if(u)$('aiWorkerUrl').value=u;
 renderWeak();renderTypingStats();$('btnGenerateArticle').addEventListener('click',generate);$('btnPrepareDaily').addEventListener('click',prepareTask);$('btnShowHistory').addEventListener('click',renderHistory);
 $('btnExportBackup').addEventListener('click',backup);$('backupFile').addEventListener('change',function(){if(this.files[0])restore(this.files[0]);});
 $('btnStartWriting').addEventListener('click',function(){window.__rwTypingStarted=Date.now();var s=$('articleSource').value.trim();if(s){var a=saveCurrentArticle({id:'manual-'+Date.now(),bookId:active(),title:'手动文章',content:s,translation:$('articleTranslation').value,wordCount:(s.match(/\b[\w'-]+\b/g)||[]).length,createdAt:new Date().toISOString()});}},true);
 $('btnSubmitWriting').addEventListener('click',function(){var source=$('articleSource').value,typed=$('writingInput').value;if(!source)return;var dist=editDistance(source,typed),max=Math.max(source.length,typed.length);var mins=Math.max((Date.now()-Number(window.__rwTypingStarted||Date.now()))/60000,1/60000);var rec=get('reviewwords.typingRecords.v1',[]);var accuracy=max?Math.max(0,1-dist/max):0;var correctChars=Math.max(0,source.length-dist);rec.unshift({bookId:active(),date:today(),mode:document.querySelector('[data-typing-mode].is-active')?.dataset.typingMode||'strict',accuracy:accuracy,errors:dist,wpm:Math.round(correctChars/5/mins),durationMs:mins*60000,articleId:articles()[0]?.id||null,article:source.slice(0,120)});localStorage.setItem('reviewwords.typingRecords.v1',JSON.stringify(rec.slice(0,500)));renderTypingStats();},true);
 document.querySelectorAll('.nav-btn[data-view="writing"]').forEach(function(b){b.addEventListener('click',renderWeak);});document.querySelectorAll('.nav-btn[data-view="stats"]').forEach(function(b){b.addEventListener('click',renderTypingStats);});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
})();