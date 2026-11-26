/* Review Words: IndexedDB-backed persistence bridge.
   The existing app uses synchronous localStorage. This bridge hydrates it before app.js
   starts, then mirrors every write to IndexedDB while retaining localStorage fallback.
   注：页面里的读写现在都走 assets/modules/core/store.js；这里只剩两件事——
   1) 启动前把 IndexedDB 里的镜像灌回 localStorage（只在键缺失时灌，不会覆盖本地更新的数据）；
   2) 挂 Storage.prototype 钩子，把之后的每次写入顺手镜像到 IndexedDB。
   如果 localStorage 本身写失败（配额满），钩子拿不到值，由 store.js 直接补写 IndexedDB。 */
(function () {
  'use strict';
  var DB_NAME='review-words-db', STORE='kv', VERSION=1;
  function openDB(){return new Promise(function(resolve,reject){
    if(!('indexedDB' in window)){reject(new Error('IndexedDB unavailable'));return;}
    var req=indexedDB.open(DB_NAME,VERSION);
    req.onupgradeneeded=function(){var db=req.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:'key'});};
    req.onsuccess=function(){resolve(req.result);};req.onerror=function(){reject(req.error);};
  });}
  function readAll(db){return new Promise(function(resolve,reject){var tx=db.transaction(STORE,'readonly'),req=tx.objectStore(STORE).getAll();req.onsuccess=function(){resolve(req.result||[]);};req.onerror=function(){reject(req.error);};});}
  function put(db,key,value){try{var tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put({key:key,value:value,updatedAt:Date.now()});}catch(e){}}
  function boot(){
    openDB().then(function(db){
      return readAll(db).then(function(rows){
        rows.forEach(function(row){try{if(localStorage.getItem(row.key)===null)localStorage.setItem(row.key,row.value);}catch(e){}});
        var originalSet=Storage.prototype.setItem, originalRemove=Storage.prototype.removeItem;
        Storage.prototype.setItem=function(k,v){originalSet.call(this,k,v);if(this===localStorage)put(db,String(k),String(v));};
        Storage.prototype.removeItem=function(k){originalRemove.call(this,k);if(this===localStorage){try{var tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(String(k));}catch(e){}}};
        window.ReviewWordsDB={ready:true,exportAll:function(){return readAll(db);},put:function(k,v){put(db,k,v);}};
        loadApp();
      });
    }).catch(function(){
      window.ReviewWordsDB={ready:false,reason:'IndexedDB 不可用，当前使用 localStorage 降级存储。'};
      loadApp();
    });
  }
  function loadApp(){
    var app=document.createElement('script');app.src='./assets/app.js';
    app.onload=function(){var ext=document.createElement('script');ext.src='./assets/modules/reviewwords-enhancements.js';document.body.appendChild(ext);};
    document.body.appendChild(app);
  }
  boot();
})();