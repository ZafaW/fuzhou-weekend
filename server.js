#!/usr/bin/env node
'use strict';
// 福州带娃周末出行 · 后台定时刷新服务（零依赖 Node）
// ---------------------------------------------------------------
// 职责：
//   1) 静态托管本目录（含 福州带娃周末出行.html）
//   2) GET /api/today   → 返回当日清单 JSON（当天缓存，避免重复消耗高德配额）
//   3) GET /api/refresh → 立即重新检索并刷新当天缓存（手动触发/调试）
//   4) 每天 08:00 自动调高德拉最新清单并写缓存（真·后台，进程常开即每日自动跑）
// 用法：
//   node server.js                  # 默认端口 8787（常开服务模式）
//   node server.js --once           # 只刷一次当天缓存后退出（给 Serverless/云函数 Cron 用）
//   PORT=9000 AMAP_KEY=你的Key node server.js
// 部署：在云主机/VPS/树莓派 上常开运行（pm2 或 nohup 守护），用户浏览器访问
//       http://<公网IP>:8787/福州带娃周末出行.html 即可，清单每天云端自动更新。

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = __dirname;
const CACHE_DIR = path.join(ROOT, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'today.json');
const PORT = Number(process.env.PORT) || 8787;
const KEY = (process.env.AMAP_KEY || 'b18549a937a71f7c108e8fb72b510ee5').trim();

// —— 与前端保持一致的检索参数（改这里即可调整搜索范围）——
const START = { lat: 26.062, lng: 119.278, name: '农林大学' }; // 起点：农林大学
const MIN_KM = 0, MAX_KM = 30, MIN_RATING = 4.0;               // 距离窗口 / 评分门禁
const KWS = ['公园','儿童公园','动物园','动物乐园','海洋馆','海洋世界','水族馆','游乐场','游乐园','主题公园','亲子','萌宠','植物园','森林公园','湿地','沙滩','海滨','广场','图书馆','少儿','科技馆','科普','温泉','景点','风景区'];
const BLOCK_RE = /宠物|兽医|动物医院|卫生院|诊所|药店|药房|医院|门诊|超市|便利店|商场|购物中心|酒店|民宿|餐饮|饭店|餐厅|美食|咖啡|茶饮|住宅|小区|公寓|商铺|写字楼|公司|工厂|学校|幼儿园|培训|辅导|停车场|加油|加气|充电|银行|营业厅|维修|理发|美容/;
const ALLOW_RE = /公园|动物园|水族|海洋|儿童|亲子|游乐|主题公园|植物园|森林公园|湿地|海滨|沙滩|海滩|广场|图书馆|少儿|科技|科普|温泉|景点|风景区|露营|农场|采摘|萌宠/;
const UNMISTAKABLE = /动物园|海洋|水族|儿童公园|儿童乐园|游乐场|游乐园|主题公园|植物园|森林公园|湿地|沙滩|海滨|科普|科技馆|图书馆|萌宠|水世界/;

// —— GCJ-02 <-> WGS-84（与前端完全相同，保证坐标一致）——
const a = 6378245.0, ee = 0.00669342162296594323;
function outOfChina(lat,lng){ return !(lng>73.66&&lng<135.05&&lat>3.86&&lat<53.55); }
function tLat(lng,lat){ let r=-100+2*lng+3*lat+0.2*lat*lat+0.1*lng*lat+0.2*Math.sqrt(Math.abs(lng)); r+=(20*Math.sin(6*lng*Math.PI)+20*Math.sin(2*lng*Math.PI))*2/3; r+=(20*Math.sin(lat*Math.PI)+40*Math.sin(lat/3*Math.PI))*2/3; r+=(160*Math.sin(lat/12*Math.PI)+320*Math.sin(lat*Math.PI/30))*2/3; return r; }
function tLng(lng,lat){ let r=300+lng+2*lat+0.1*lng*lng+0.1*lng*lat+0.1*Math.sqrt(Math.abs(lng)); r+=(20*Math.sin(6*lng*Math.PI)+20*Math.sin(2*lng*Math.PI))*2/3; r+=(20*Math.sin(lat*Math.PI)+40*Math.sin(lat/3*Math.PI))*2/3; r+=(150*Math.sin(lat/12*Math.PI)+300*Math.sin(lat/30*Math.PI))*2/3; return r; }
function wgs2gcj(wlat,wlng){ if(outOfChina(wlat,wlng)) return {lat:wlat,lng:wlng}; let dLat=tLat(wlng-105,wlat-35), dLng=tLng(wlng-105,wlat-35); const rad=wlat/180*Math.PI; let m=Math.sin(rad); m=1-ee*m*m; const sq=Math.sqrt(m); dLat=(dLat*180)/((a*(1-ee))/(m*sq)*Math.PI); dLng=(dLng*180)/(a/sq*Math.cos(rad)*Math.PI); return {lat:wlat+dLat,lng:wlng+dLng}; }
function gcj2wgs(glat,glng){ const g=wgs2gcj(glat,glng); return {lat:glat+(glat-g.lat),lng:glng+(glng-g.lng)}; }
function hav(A,B){ const R=6371,r=Math.PI/180; const dLat=(B.lat-A.lat)*r, dLng=(B.lng-A.lng)*r; const la1=A.lat*r, la2=B.lat*r; const h=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }

// —— 高德 Web 服务·文本搜索（extensions=all 才返回评分/人均）——
function amapText(kw, page){
  page = page || 1;
  return new Promise((resolve)=>{
    const q = 'https://restapi.amap.com/v3/place/text?key='+encodeURIComponent(KEY)+
      '&keywords='+encodeURIComponent(kw)+'&city='+encodeURIComponent('福州')+
      '&citylimit=true&offset=25&page='+page+'&extensions=all';
    const req = https.get(q, res=>{
      let body=''; res.on('data',c=>body+=c); res.on('end',()=>{
        try{ const j=JSON.parse(body); if(j && j.infocode==='10000' && Array.isArray(j.pois)) resolve(j.pois); else resolve([]); }
        catch(e){ resolve([]); }
      });
    });
    req.on('error',()=>resolve([]));
    req.setTimeout(8000, ()=>{ try{ req.destroy(); }catch(e){} resolve([]); });
  });
}

// —— POI 准入：只保留真正的「带娃目的地」——
function isGoodPOI(p){ const s=(p.type||'')+'|'+(p.name||''); if(BLOCK_RE.test(s)) return false; return ALLOW_RE.test(p.type||''); }
function addEligible(p){
  if(!isGoodPOI(p)) return false;
  const combo=(p.type||'')+(p.name||'');
  if(UNMISTAKABLE.test(combo)) return true;            // 明确目的地，直接收
  const r=Number((p.biz_ext&&p.biz_ext.rating)||0);
  return r>=MIN_RATING;                                 // 普通公园/广场需评分达标
}
function normName(n){ return (n||'').replace(/[（(][^()（）]*[)）]/g,'').trim(); }
function dateStr(d){ d=d||new Date(); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); } // 与前端 hotSeed 一致：无前导零

// —— 生成当日清单（缓存到 cache/today.json）——
async function refreshToday(){
  const all=[]; const dup=new Set();
  for(const kw of KWS){
    const pois = await amapText(kw, 1);
    for(const p of pois){ if(p && p.name && p.location){ const k=p.name+'|'+p.location; if(!dup.has(k)){ dup.add(k); all.push(p); } } }
  }
  // 距离过滤（高德 location 为 "lng,lat" GCJ-02）
  const inRange = all.filter(p=>{
    const parts=(p.location||'').split(',').map(Number);
    if(parts.length!==2 || isNaN(parts[0])) return false;
    const w=gcj2wgs(parts[1], parts[0]);
    const km=hav(w, START);
    return km>=MIN_KM && km<=MAX_KM;
  });
  // 评分/类型门禁
  const eligible = inRange.filter(addEligible);
  // 同名去重（更精细的同场所合并交给前端 mergePOIs 处理）
  const seen=new Set(); const pois=eligible.filter(p=>{ const n=normName(p.name); if(seen.has(n)) return false; seen.add(n); return true; });
  const snap={ date:dateStr(), source:'amap', generatedAt:new Date().toISOString(), count:pois.length, pois };
  try{ fs.mkdirSync(CACHE_DIR,{recursive:true}); fs.writeFileSync(CACHE_FILE, JSON.stringify(snap,null,2)); }
  catch(e){ console.error('[写缓存失败]', e.message); }
  return snap;
}
function readToday(){ try{ return JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')); }catch(e){ return null; } }

// —— 每天 08:00 自动刷新（进程常开即生效）——
function scheduleDaily(){
  const now=new Date(); const next=new Date(now);
  next.setHours(8,0,0,0); if(next<=now) next.setDate(next.getDate()+1);
  const ms=next-now;
  setTimeout(async()=>{
    try{ const s=await refreshToday(); console.log('[定时] 每日08:00刷新完成', s.date, '共', s.count, '个'); }
    catch(e){ console.error('[定时] 刷新失败', e.message); }
    scheduleDaily();
  }, ms);
  console.log('[调度] 下次自动刷新:', next.toLocaleString());
}

// —— HTTP 服务 ——
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/api/today'){
    const snap=readToday()||{date:dateStr(),source:'none',pois:[]};
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(snap)); return;
  }
  if(u.pathname==='/api/refresh'){
    try{ const s=await refreshToday(); res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(s)); }
    catch(e){ res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:String(e.message||e)})); }
    return;
  }

  // ===== 起点同步：读取 / 保存 origins.json（写 GitHub，令牌只在本服务端） =====
  if(req.method==='OPTIONS'){
    res.writeHead(204,{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type, x-admin-pin',
      'Access-Control-Max-Age':'86400'
    });
    res.end(); return;
  }
  function ghConf(){
    try{
      const c=JSON.parse(fs.readFileSync('/root/.config/fz/gh.json','utf8'));
      if(c.token && c.owner && c.repo) return c;
    }catch(e){}
    return null;
  }
  function ghApi(method, p, body, token){
    return new Promise((resolve,reject)=>{
      const data=body?JSON.stringify(body):null;
      const r=https.request('https://api.github.com'+p, {
        method,
        headers:{ 'Authorization':'Bearer '+token, 'Accept':'application/vnd.github+json', 'User-Agent':'fz-backend', 'Content-Type':'application/json' }
      }, x=>{
        let b=''; x.on('data',c=>b+=c); x.on('end',()=>{
          let j=null; try{ j=JSON.parse(b); }catch(e){}
          if(x.statusCode>=200&&x.statusCode<300) resolve(j); else reject(new Error('GitHub '+x.statusCode+' '+(j&&j.message||b.slice(0,150))));
        });
      });
      r.on('error',reject); r.setTimeout(15000,()=>{ try{r.destroy();}catch(e){} reject(new Error('GitHub 超时')); });
      if(data) r.write(data); r.end();
    });
  }
  function b64dec(s){ return Buffer.from(s,'base64').toString('utf8'); }
  function b64enc(s){ return Buffer.from(s,'utf8').toString('base64'); }
  async function getOrigins(){
    const c=ghConf(); if(!c) throw new Error('服务端未配置令牌');
    try{
      const j=await ghApi('GET','/repos/'+c.owner+'/'+c.repo+'/contents/origins.json?ref='+(c.branch||'main'),null,c.token);
      let origins=[]; try{ origins=(JSON.parse(b64dec(j.content)).origins)||[]; }catch(e){}
      return { sha:j.sha, origins };
    }catch(e){ return { sha:null, origins:[] }; }
  }
  async function putOrigins(sha, origins){
    const c=ghConf(); if(!c) throw new Error('服务端未配置令牌');
    const body={ message:'起点同步（后端自动）', content:b64enc(JSON.stringify({origins},null,2)), branch:c.branch||'main' };
    if(sha) body.sha=sha;
    return ghApi('PUT','/repos/'+c.owner+'/'+c.repo+'/contents/origins.json',body,c.token);
  }
  if(u.pathname==='/api/origins' && req.method==='GET'){
    try{
      const { origins }=await getOrigins();
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ ok:true, origins }));
    }catch(e){
      res.writeHead(500,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ ok:false, error:String(e.message||e) }));
    }
    return;
  }
  if(u.pathname==='/api/save-origins' && req.method==='POST'){
    if(!checkPin(req)){ deny(); return; }   // 起点写入必须鉴权（历史缺陷：该接口无鉴权，起点可被任意增删）
    let body='';
    req.on('data',d=>{ body+=d; if(body.length>100000) req.destroy(); });
    req.on('end', async ()=>{
      try{
        const j=JSON.parse(body||'{}');
        const incoming=Array.isArray(j.origins)?j.origins:[];
        const clean=incoming
          .filter(o=>o && o.name && isFinite(+o.lng) && isFinite(+o.lat))
          .slice(0,30)
          .map(o=>({ name:String(o.name).slice(0,40), lng:+(+o.lng).toFixed(6), lat:+(+o.lat).toFixed(6) }));
        if(!clean.length){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({ok:false,error:'没有有效起点'})); return; }
        const { sha, origins }=await getOrigins();
        const merged=[...origins];
        for(const o of clean){
          const dup=merged.some(m=>m.name===o.name || (Math.abs(m.lat-o.lat)<0.0005 && Math.abs(m.lng-o.lng)<0.0005));
          if(!dup) merged.push(o);
        }
        if(merged.length>50) merged.length=50;
        await putOrigins(sha, merged);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok:true, total:merged.length, added:merged.length-origins.length }));
      }catch(e){
        res.writeHead(500,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok:false, error:String(e.message||e) }));
      }
    });
    return;
  }
  // 删除起点：按 name（或坐标近似）从 origins.json 移除（前端删除按钮调用，避免刷新后又被 loadRepoOrigins 合并回来）
  if(u.pathname==='/api/delete-origin' && req.method==='POST'){
    if(!checkPin(req)){ deny(); return; }   // 起点删除必须鉴权（历史缺陷：该接口无鉴权）
    let body='';
    req.on('data',d=>{ body+=d; if(body.length>100000) req.destroy(); });
    req.on('end', async ()=>{
      try{
        const j=JSON.parse(body||'{}');
        const target={ name:String(j.name||'').trim(), lng:+j.lng, lat:+j.lat };
        if(!target.name || !isFinite(target.lng) || !isFinite(target.lat)){
          res.writeHead(400,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({ok:false,error:'缺少 name/lng/lat'})); return;
        }
        const { sha, origins }=await getOrigins();
        const next=origins.filter(o=>{
          const sameName=o.name===target.name;
          const sameCoord=Math.abs(o.lat-target.lat)<0.0005 && Math.abs(o.lng-target.lng)<0.0005;
          return !(sameName || sameCoord);
        });
        const removed=origins.length-next.length;
        if(removed>0){ await putOrigins(sha, next); }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok:true, removed, total:next.length }));
      }catch(e){
        res.writeHead(500,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok:false, error:String(e.message||e) }));
      }
    });
    return;
  }
  // ===== 地理编码代理：后端直连高德，绕开浏览器对 restapi.amap.com 的跨域/劫持 =====
  // 支持两种模式：
  //   1) 普通模式（默认）：返回 JSON（用于 fetch）
  //   2) iframe 模式（?cb=1）：返回一段会向父窗口 postMessage 的 HTML，绕开 fetch 的跨域限制
  if(u.pathname==='/api/geocode'){
    const addr=(u.searchParams.get('address')||'').trim();
    const useCb=u.searchParams.get('cb')==='1';
    const send=(code,data)=>{
      if(useCb){
        const html='<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>'+
          'try{parent.postMessage(JSON.stringify('+JSON.stringify({_fzGeocode:1,code,data})+'),"*");}catch(e){}'+
          '<\/script></body></html>';
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
        res.end(html);
      } else {
        res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify(data));
      }
    };
    if(!addr){ send(400,{ok:false,error:'缺少 address 参数'}); return; }
    const q='https://restapi.amap.com/v3/geocode/geo?key='+encodeURIComponent(KEY)+'&address='+encodeURIComponent(addr)+'&city=福州';
    https.get(q, r2=>{
      let b=''; r2.on('data',c=>b+=c); r2.on('end',()=>{
        try{
          const j=JSON.parse(b);
          if(j && j.status==='1' && j.geocodes && j.geocodes[0]){
            send(200,{ ok:true, location:j.geocodes[0].location, formatted:j.geocodes[0].formatted_address });
          } else {
            send(200,{ ok:false, error:'未找到该地址', info:j&&j.info });
          }
        }catch(e){
          send(500,{ ok:false, error:'高德响应解析失败' });
        }
      });
    }).on('error',()=>{
      send(502,{ ok:false, error:'高德服务不可达' });
    }).setTimeout(10000, function(){ this.destroy(); });
    return;
  }
  // ===== 管理接口：知识库 / 文档库（数据台 data.html 使用）=====
  // 鉴权：写操作需带请求头 x-admin-pin，取值由环境变量 ADMIN_PIN 提供（不写入仓库）
  // PIN 取值优先级：① 环境变量 ADMIN_PIN ② 服务端本地文件（默认 ./admin_pin.txt，不进仓库）
  // 改为每次请求实时读取，改口令无需重启服务；两者都没有时保持未设置状态（fail-closed）。
  const PIN_FILE = (process.env.ADMIN_PIN_FILE||'').trim() || path.join(process.cwd(), 'admin_pin.txt');
  function readPinFile(){ try{ return fs.readFileSync(PIN_FILE,'utf8').trim(); }catch(e){ return ''; } }
  function currentPin(){
    const env = (process.env.ADMIN_PIN||'').trim();
    if(env) return { pin:env, from:'env' };
    const f = readPinFile();
    if(f) return { pin:f, from:'file' };
    return { pin:'', from:'none' };
  }
  const bootPin = currentPin();
  if(bootPin.from==='none'){
    console.warn('[警告] 未设置 ADMIN_PIN（环境变量或 '+PIN_FILE+'），管理接口将拒绝所有写操作；可调用 /api/set-pin 首次设置');
  }else{
    console.log('[启动] 管理 PIN 来源：'+(bootPin.from==='env'?'环境变量 ADMIN_PIN':'文件 '+PIN_FILE));
  }
  // 关键：未设置时必须拒绝写操作（fail-closed）。
  // 历史缺陷：PIN 为空时 (header||'')==='' 恒成立，导致全站写接口实际无鉴权。
  function checkPin(r){ const p=currentPin().pin; return p!=='' && (r.headers['x-admin-pin']||'')===p; }
  function validDocPath(p){ return /^docs\/[^\/]+(\/[^\/]+)*\.(md|txt)$/i.test(p) && p.indexOf('..')<0 && p.length<200; }
  function send(obj, code){
    res.writeHead(code||200,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(obj));
  }
  function deny(){ send({ok:false,error:'需要管理 PIN（请求头 x-admin-pin）'},401); }
  function ghPath(p){ return p.split('/').map(encodeURIComponent).join('/'); }
  async function getRepoFile(p){
    const c=ghConf(); if(!c) throw new Error('服务端未配置令牌');
    try{
      const j=await ghApi('GET','/repos/'+c.owner+'/'+c.repo+'/contents/'+ghPath(p)+'?ref='+(c.branch||'main'),null,c.token);
      return { content:b64dec(j.content), sha:j.sha };
    }catch(e){ return null; }
  }
  async function putRepoFile(p, content, message){
    const c=ghConf(); if(!c) throw new Error('服务端未配置令牌');
    const old=await getRepoFile(p);
    const body={ message, content:b64enc(content), branch:c.branch||'main' };
    if(old && old.sha) body.sha=old.sha;
    return ghApi('PUT','/repos/'+c.owner+'/'+c.repo+'/contents/'+ghPath(p),body,c.token);
  }
  async function delRepoFile(p, message){
    const c=ghConf(); if(!c) throw new Error('服务端未配置令牌');
    const old=await getRepoFile(p);
    if(!old) return { ok:true, noop:true };
    return ghApi('DELETE','/repos/'+c.owner+'/'+c.repo+'/contents/'+ghPath(p),{ message, sha:old.sha, branch:c.branch||'main' },c.token);
  }
  // —— SPOT_NOTES 解析 / 回写（与 run_daily.js 的格式约定完全兼容：const SPOT_NOTES={...换行};）——
  function parseKB(html){
    const m=html.match(/const SPOT_NOTES=\{([\s\S]*?)\n\};/);
    if(!m) return null;
    return new Function('return {'+m[1]+'}')();
  }
  function writeKB(html, obj){
    const block='const SPOT_NOTES='+JSON.stringify(obj,null,2)+';';
    if(/const SPOT_NOTES=\{[\s\S]*?\n\};/.test(html)) return html.replace(/const SPOT_NOTES=\{[\s\S]*?\n\};/, ()=>block);
    return html;
  }
  function readBody(){
    return new Promise((resolve,reject)=>{
      let b=''; req.on('data',d=>{ b+=d; if(b.length>2000000) req.destroy(); });
      req.on('end',()=>resolve(b)); req.on('error',reject);
    });
  }
  function kbCategory(name, note){
    const s=(name||'')+'|'+((note&&(note.u||note.warn))||'');
    if(/图书馆|少儿阅读|绘本|书吧/.test(s)) return '图书馆阅读';
    if(/博物馆|科技馆|科普|展览|纪念馆|美术馆|规划馆/.test(s)) return '博物馆科普';
    if(/海洋|水族|海底|海世界|极地/.test(s)) return '海洋水族';
    if(/沙滩|海滨|海滩|浴场/.test(s)) return '沙滩海滨';
    if(/温泉/.test(s)) return '温泉';
    if(/动物园|动物乐园|萌宠|百鸟|野生动物|鸟语林/.test(s)) return '动物园萌宠';
    if(/乐园|游乐场|游乐园|欢乐世界/.test(s)) return '乐园游乐';
    if(/公园|湿地|绿地|郊野|森林公园|生态/.test(s)) return '公园绿地';
    if(/广场|街区|古厝|老街|小镇|古镇|历史|风情|古街/.test(s)) return '广场街区';
    return '其他目的地';
  }

  // POST /api/verify-pin {pin} —— 登录校验（数据台整页加密访问）
  if(u.pathname==='/api/verify-pin' && req.method==='POST'){
    const raw=await readBody();
    let j; try{ j=JSON.parse(raw||'{}'); }catch(e){ send({ok:false}); return; }
    const cur=currentPin();
    if(cur.pin===''){ send({ ok:false, needSetup:true, error:'服务端尚未设置管理口令；请在服务器写入 '+PIN_FILE+' 或设置环境变量 ADMIN_PIN，也可调用 /api/set-pin 首次设置' }); return; }
    send({ ok: String(j.pin||'')===cur.pin });
    return;
  }
  // POST /api/set-pin {oldPin, newPin} —— 设置/修改管理口令
  // 未设置口令时允许首次设置（此时系统本就裸奔，设上即变安全）；已设置则必须校验原口令。
  // 仅文件模式可网页修改；环境变量模式需在部署环境调整。
  if(u.pathname==='/api/set-pin' && req.method==='POST'){
    const raw=await readBody();
    let j={}; try{ j=JSON.parse(raw||'{}'); }catch(e){}
    const cur=currentPin();
    const oldPin=String(j.oldPin||''), newPin=String(j.newPin||'').trim();
    if(!newPin || newPin.length<4){ send({ok:false,error:'新口令至少 4 位'}); return; }
    if(cur.pin!=='' && oldPin!==cur.pin){ send({ok:false,error:'原口令不正确'}); return; }
    if(cur.from==='env'){ send({ok:false,error:'当前口令来自环境变量 ADMIN_PIN，不支持网页修改；请取消该环境变量后改用文件模式'}); return; }
    try{
      fs.writeFileSync(PIN_FILE, newPin, { mode:0o600 });
      console.log('[口令] 已更新（'+PIN_FILE+'）');
      send({ ok:true, from:'file' });
    }catch(e){ send({ok:false,error:'服务端无法写入口令文件：'+String(e.message||e)}); }
    return;
  }
  // GET /api/pin-status —— 供前端判断是否需要首次设置（不泄露口令本身）
  if(u.pathname==='/api/pin-status' && req.method==='GET'){
    const cur=currentPin();
    send({ ok:true, set:cur.pin!=='', from:cur.from });
    return;
  }
  // GET /api/kb —— 读取知识库（服务端代理，绕开手机直连 raw.githubusercontent 失败的问题）
  if(u.pathname==='/api/kb' && req.method==='GET'){
    if(!checkPin(req)){ deny(); return; }
    try{
      const f=await getRepoFile('index.html');
      if(!f){ send({ok:false,error:'仓库中未找到 index.html'},404); return; }
      const obj=parseKB(f.content);
      if(!obj){ send({ok:false,error:'index.html 中未解析到 SPOT_NOTES'},500); return; }
      const sm=f.content.match(/const EMBEDDED_SNAPSHOT\s*=\s*(\[[\s\S]*?\]);/);
      let snapCount=null; if(sm){ try{ snapCount=new Function('return '+sm[1])().length; }catch(e){} }
      let lastCommit=null;
      try{
        const c=ghConf();
        const arr=await ghApi('GET','/repos/'+c.owner+'/'+c.repo+'/commits?path='+encodeURIComponent('index.html')+'&per_page=1',null,c.token);
        if(arr && arr[0]) lastCommit={ date:arr[0].commit.author.date, sha:arr[0].sha.slice(0,7), message:(arr[0].commit.message||'').split('\n')[0] };
      }catch(e){}
      send({ ok:true, notes:obj, snapshot:{ count:snapCount }, lastCommit });
    }catch(e){ send({ok:false,error:String(e.message||e)},500); }
    return;
  }
  // POST /api/kb-save {name,u,warn,food} —— 新增/修改知识库条目（同时写模板与 index.html）
  if(u.pathname==='/api/kb-save' && req.method==='POST'){
    if(!checkPin(req)){ deny(); return; }
    const raw=await readBody();
    let j; try{ j=JSON.parse(raw||'{}'); }catch(e){ send({ok:false,error:'JSON 解析失败'}); return; }
    const name=String(j.name||'').trim().slice(0,60);
    const entry={ u:String(j.u||'').trim().slice(0,1500), warn:String(j.warn||'').trim().slice(0,800), food:String(j.food||'').trim().slice(0,800) };
    if(!name || !entry.u){ send({ok:false,error:'需要 name 与 u 字段'}); return; }
    try{
      const results=[];
      for(const p of ['福州带娃周末出行.html','index.html']){
        const f=await getRepoFile(p);
        if(!f){ results.push({file:p, error:'文件不存在'}); continue; }
        const obj=parseKB(f.content); if(!obj){ results.push({file:p, error:'解析失败'}); continue; }
        obj[name]=entry;                                   // 覆盖即修改；新名即新增
        const out=writeKB(f.content, obj);
        if(out===f.content){ results.push({file:p, error:'内容无变化'}); continue; }
        await putRepoFile(p, out, '知识库'+(j._isNew?'新增':'更新')+'：'+name+'（数据台）');
        results.push({file:p, ok:true});
      }
      send({ok:true, results});
    }catch(e){ send({ok:false,error:String(e.message||e)},500); }
    return;
  }
  // POST /api/kb-delete {name} —— 删除知识库条目
  if(u.pathname==='/api/kb-delete' && req.method==='POST'){
    if(!checkPin(req)){ deny(); return; }
    const raw=await readBody();
    let j; try{ j=JSON.parse(raw||'{}'); }catch(e){ send({ok:false,error:'JSON 解析失败'}); return; }
    const name=String(j.name||'').trim(); if(!name){ send({ok:false,error:'缺少 name'}); return; }
    try{
      const results=[];
      for(const p of ['福州带娃周末出行.html','index.html']){
        const f=await getRepoFile(p);
        if(!f){ results.push({file:p, error:'文件不存在'}); continue; }
        const obj=parseKB(f.content); if(!obj || !obj[name]){ results.push({file:p, error:'条目不存在'}); continue; }
        delete obj[name];
        await putRepoFile(p, writeKB(f.content, obj), '知识库删除：'+name+'（数据台）');
        results.push({file:p, ok:true});
      }
      send({ok:true, results});
    }catch(e){ send({ok:false,error:String(e.message||e)},500); }
    return;
  }
  // GET /api/docs —— 列出 docs/ 下全部文档（递归）
  if(u.pathname==='/api/docs' && req.method==='GET'){
    if(!checkPin(req)){ deny(); return; }
    try{
      const c=ghConf(); if(!c) throw new Error('服务端未配置令牌');
      const t=await ghApi('GET','/repos/'+c.owner+'/'+c.repo+'/git/trees/'+(c.branch||'main')+'?recursive=1',null,c.token);
      const docs=(t.tree||[]).filter(x=>x.type==='blob' && x.path.indexOf('docs/')===0).map(x=>({path:x.path, size:x.size}));
      send({ok:true, docs});
    }catch(e){ send({ok:false,error:String(e.message||e)},500); }
    return;
  }
  // GET /api/doc?path=docs/xxx.md —— 读取单个文档
  if(u.pathname==='/api/doc' && req.method==='GET'){
    if(!checkPin(req)){ deny(); return; }
    try{
      const p=decodeURIComponent(u.searchParams.get('path')||'');
      if(!validDocPath(p)){ send({ok:false,error:'路径不合法'},400); return; }
      const f=await getRepoFile(p);
      if(!f){ send({ok:false,error:'文档不存在'},404); return; }
      send({ok:true, path:p, content:f.content});
    }catch(e){ send({ok:false,error:String(e.message||e)},500); }
    return;
  }
  // POST /api/doc-save {path,content,message} —— 新建/保存文档
  if(u.pathname==='/api/doc-save' && req.method==='POST'){
    if(!checkPin(req)){ deny(); return; }
    const raw=await readBody();
    let j; try{ j=JSON.parse(raw||'{}'); }catch(e){ send({ok:false,error:'JSON 解析失败'}); return; }
    const p=String(j.path||'');
    if(!validDocPath(p)){ send({ok:false,error:'路径不合法（需 docs/分类/文件.md）'},400); return; }
    try{
      await putRepoFile(p, String(j.content||''), j.message || '文档保存：'+p+'（数据台）');
      send({ok:true, path:p});
    }catch(e){ send({ok:false,error:String(e.message||e)},500); }
    return;
  }
  // POST /api/doc-delete {path} —— 删除文档
  if(u.pathname==='/api/doc-delete' && req.method==='POST'){
    if(!checkPin(req)){ deny(); return; }
    const raw=await readBody();
    let j; try{ j=JSON.parse(raw||'{}'); }catch(e){ send({ok:false,error:'JSON 解析失败'}); return; }
    const p=String(j.path||'');
    if(p.indexOf('docs/')!==0 || p.indexOf('..')>=0){ send({ok:false,error:'路径不合法'},400); return; }
    try{
      await delRepoFile(p, '文档删除：'+p+'（数据台）');
      send({ok:true, path:p});
    }catch(e){ send({ok:false,error:String(e.message||e)},500); }
    return;
  }
  // POST /api/doc-import {url,category,title} —— 抓取网页正文转 Markdown 存入文档库
  if(u.pathname==='/api/doc-import' && req.method==='POST'){
    if(!checkPin(req)){ deny(); return; }
    const raw=await readBody();
    let j; try{ j=JSON.parse(raw||'{}'); }catch(e){ send({ok:false,error:'JSON 解析失败'}); return; }
    const url=String(j.url||''); const title=String(j.title||'').trim().slice(0,80); const category=(String(j.category||'收集箱').trim()||'收集箱').replace(/[\/\\]/g,'-').slice(0,30);
    if(!/^https?:\/\//.test(url)){ send({ok:false,error:'需要合法的 http(s) 链接'}); return; }
    if(!title){ send({ok:false,error:'需要 title'}); return; }
    try{
      const htmlSrc=await new Promise((resolve,reject)=>{
        https.get(url,{headers:{'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)'}},r=>{
          if(r.statusCode>=300 && r.statusCode<400 && r.headers.location){ r.resume(); reject(new Error('重定向:'+r.headers.location)); return; }
          if(r.statusCode!==200){ r.resume(); reject(new Error('HTTP '+r.statusCode)); return; }
          let b=''; r.on('data',c=>b+=c); r.on('end',()=>resolve(b));
        }).on('error',reject).setTimeout(15000,function(){ try{this.destroy();}catch(e){} reject(new Error('抓取超时')); });
      });
      // 提取正文：去 script/style → 块级转换 → 去标签
      let t=htmlSrc
        .replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<!--[\s\S]*?-->/g,'')
        .replace(/<(h1)[^>]*>/gi,'\n# ').replace(/<(h2)[^>]*>/gi,'\n## ').replace(/<(h3)[^>]*>/gi,'\n### ')
        .replace(/<(p|div|br|li|tr)[^>]*>/gi,'\n')
        .replace(/<[^>]+>/g,'')
        .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
        .split('\n').map(l=>l.trim()).filter(l=>l).join('\n\n');
      t=t.replace(/\n{3,}/g,'\n\n');
      if(t.length<50){ send({ok:false,error:'该网页正文太短（可能是 JS 渲染页），建议手动复制内容用「新建文档」保存'}); return; }
      const fname=title.replace(/[\/\\:*?"<>|\s#]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||('import-'+Date.now());
      const doc='# '+title+'\n\n> 来源：'+url+'\n> 导入时间：'+new Date().toLocaleString('zh-CN',{hour12:false})+'\n\n'+t.slice(0,20000)+'\n';
      const path='docs/'+category+'/'+fname+'.md';
      await putRepoFile(path, doc, '网页导入：'+title+'（数据台）');
      send({ok:true, path, chars:t.length});
    }catch(e){ send({ok:false,error:'导入失败：'+String(e.message||e)},500); }
    return;
  }
  // POST /api/docs-sync —— 从知识库一键重建分类文档库（docs/分类/地点.md + docs/README.md）
  if(u.pathname==='/api/docs-sync' && req.method==='POST'){
    if(!checkPin(req)){ deny(); return; }
    try{
      const c=ghConf(); if(!c) throw new Error('服务端未配置令牌');
      const f=await getRepoFile('index.html');
      const obj=parseKB(f && f.content || '');
      if(!obj){ send({ok:false,error:'知识库解析失败'}); return; }
      // 按分类组织
      const cats={};
      for(const k of Object.keys(obj)){
        const cat=kbCategory(k, obj[k]);
        (cats[cat]=cats[cat]||[]).push({name:k, note:obj[k]});
      }
      // Git Data API 多文件单次提交
      const ref=await ghApi('GET','/repos/'+c.owner+'/'+c.repo+'/git/ref/heads/'+(c.branch||'main'),null,c.token);
      const headCommit=ref.object.sha;
      const head=await ghApi('GET','/repos/'+c.owner+'/'+c.repo+'/git/commits/'+headCommit,null,c.token);
      const baseTree=head.tree.sha;
      const today=new Date().toLocaleDateString('zh-CN');
      const files=[{ path:'docs/README.md', content:'# 📚 带娃目的地资料库\n\n> 由知识库 SPOT_NOTES 自动生成 · 更新于 '+today+'\n> 共 '+Object.keys(obj).length+' 个地点，'+Object.keys(cats).length+' 个分类\n\n'
        +Object.keys(cats).map(cat=>'- **'+cat+'**（'+cats[cat].length+' 个）：'+cats[cat].map(s=>'['+s.name+']('+encodeURIComponent(cat)+'/'+encodeURIComponent(s.name)+'.md'+')').join('、')).join('\n')+'\n' }];
      for(const cat of Object.keys(cats)){
        for(const s of cats[cat]){
          const n=s.note;
          const md='# '+s.name+'\n\n'
            +'- **分类**：'+cat+'\n- **来源**：知识库 SPOT_NOTES'+(n._auto?'（自动生成，可精修）':'（已精修）')+'\n- **更新**：'+today+'\n\n'
            +'## 🎯 玩法推荐\n\n'+(n.u||'（待补充）')+'\n\n'
            +'## ⚠️ 注意事项\n\n'+(n.warn||'（暂无）')+'\n\n'
            +'## 🍚 餐饮建议\n\n'+(n.food||'（暂无）')+'\n';
          files.push({ path:'docs/'+cat+'/'+s.name+'.md', content:md });
        }
      }
      // 创建 blobs
      const tree=[];
      for(const f2 of files){
        const blob=await ghApi('POST','/repos/'+c.owner+'/'+c.repo+'/git/blobs',{content:b64enc(f2.content),encoding:'base64'},c.token);
        tree.push({ path:f2.path, mode:'100644', type:'blob', sha:blob.sha });
      }
      const newTree=await ghApi('POST','/repos/'+c.owner+'/'+c.repo+'/git/trees',{base_tree:baseTree, tree},c.token);
      const commit=await ghApi('POST','/repos/'+c.owner+'/'+c.repo+'/git/commits',{message:'资料库重建：知识库 → docs/ 分类文档（'+files.length+' 个文件）', tree:newTree.sha, parents:[headCommit]},c.token);
      await ghApi('PATCH','/repos/'+c.owner+'/'+c.repo+'/git/refs/heads/'+(c.branch||'main'),{sha:commit.sha},c.token);
      send({ok:true, files:files.length, categories:Object.keys(cats).map(k=>({name:k,count:cats[k].length})), commit:commit.sha.slice(0,7)});
    }catch(e){ send({ok:false,error:String(e.message||e)},500); }
    return;
  }

  // 静态托管（防目录穿越）
  let p = decodeURIComponent(u.pathname);
  if(p==='/' || p==='') p='/index.html';
  let fp = path.join(ROOT, p);
  if(!fp.startsWith(ROOT)){ res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8'}); res.end('403 Forbidden'); return; }
  fs.stat(fp,(err,st)=>{
    if(err){ res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('404 Not Found'); return; }
    if(st.isDirectory()) fp=path.join(fp,'index.html');
    fs.readFile(fp,(e,data)=>{
      if(e){ res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('404 Not Found'); return; }
      const ext=path.extname(fp).toLowerCase();
      res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream'});
      res.end(data);
    });
  });
});

// —— 启动 ——
if(process.argv.includes('--once')){
  // 单次模式：刷一次缓存后退出（供 Serverless/云函数 Cron 调用，无需常开）
  refreshToday().then(s=>{ console.log('[单次] 已生成', s.date, '共', s.count, '个'); process.exit(0); })
    .catch(e=>{ console.error('[单次] 失败', e.message); process.exit(1); });
} else {
  server.listen(PORT, ()=>{
    console.log('[启动] 福州带娃后台服务: http://localhost:'+PORT+'/');
    const snap=readToday();
    if(!snap || snap.date!==dateStr()){
      console.log('[启动] 无当日缓存，立即检索生成…');
      refreshToday().then(s=>console.log('[启动] 生成完成，当日推荐', s.count, '个')).catch(e=>console.error('[启动] 生成失败', e.message));
    } else {
      console.log('[启动] 已恢复当日缓存 ('+snap.date+')，'+snap.count+' 个');
    }
    scheduleDaily();
  });
}
