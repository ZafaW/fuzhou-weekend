#!/usr/bin/env node
'use strict';
// 福州带娃周末出行 · 自包含快照生成器（零依赖 Node）
// ---------------------------------------------------------------
// 用途：被「每日 08:00 平台定时任务」调用，生成一份把当天高德 POI 内嵌进去的
//       自包含 HTML（免联网即可看到当天清单），交给 Artifact 发布为稳定公开链接。
// 流程：拉高德 → 距离/评分/类型门禁过滤 → 注入模板 EMBEDDED_SNAPSHOT → 写出自包含 HTML
// 用法：node build_snapshot.js [模板HTML路径] [输出HTML路径]
// 失败保护：若高德未返回足量地点，则原样写出模板（打开时自动走实时检索/种子回退），
//          绝不会生成空白页。

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TEMPLATE = process.argv[2] || path.join(ROOT, '福州带娃周末出行.html');
const OUTPUT = process.argv[3] || path.join(ROOT, '福州带娃周末出行_今日.html');
const KEY = (process.env.AMAP_KEY || 'b18549a937a71f7c108e8fb72b510ee5').trim();

// —— 与前端保持一致的检索参数 ——
const START = { lat: 26.0766, lng: 119.2397, name: '福建农林大学' };
const MIN_KM = 0, MAX_KM = 30, MIN_RATING = 4.0;
// 保底白名单：核心带娃地点若在常规关键词检索中漏网（高德结果排序每天会波动），逐个精确补捞
const MUST_HAVE = ['沙滩公园','西湖公园','闽江公园','闽江公园南园','福州市儿童公园','福州动物园','左海公园','金牛山公园','花海公园','黎明湖公园','乌塔公园','温泉公园','金鸡山公园','飞凤山奥体公园','福州国家森林公园','江心公园','烟台山公园','福道','闽江公园北园'];
const KWS = ['公园','儿童公园','动物园','动物乐园','海洋馆','海洋世界','水族馆','游乐场','游乐园','主题公园','亲子','萌宠','植物园','森林公园','湿地','沙滩','海滨','广场','图书馆','少儿','科技馆','科普','温泉','景点','风景区'];
const BLOCK_RE = /宠物|兽医|动物医院|卫生院|诊所|药店|药房|医院|门诊|超市|便利店|商场|购物中心|酒店|民宿|餐饮|饭店|餐厅|美食|咖啡|茶饮|住宅|小区|公寓|商铺|写字楼|公司|工厂|学校|幼儿园|培训|辅导|停车场|加油|加气|充电|银行|营业厅|维修|理发|美容/;
const ALLOW_RE = /公园|动物园|水族|海洋|儿童|亲子|游乐|主题公园|植物园|森林公园|湿地|海滨|沙滩|海滩|广场|图书馆|少儿|科技|科普|温泉|景点|风景区|露营|农场|采摘|萌宠/;
const UNMISTAKABLE = /动物园|海洋|水族|儿童公园|儿童乐园|游乐场|游乐园|主题公园|植物园|森林公园|湿地|沙滩|海滨|科普|科技馆|图书馆|萌宠|水世界/;

// —— GCJ-02 <-> WGS-84 ——
const a = 6378245.0, ee = 0.00669342162296594323;
function outOfChina(lat,lng){ return !(lng>73.66&&lng<135.05&&lat>3.86&&lat<53.55); }
function tLat(lng,lat){ let r=-100+2*lng+3*lat+0.2*lat*lat+0.1*lng*lat+0.2*Math.sqrt(Math.abs(lng)); r+=(20*Math.sin(6*lng*Math.PI)+20*Math.sin(2*lng*Math.PI))*2/3; r+=(20*Math.sin(lat*Math.PI)+40*Math.sin(lat/3*Math.PI))*2/3; r+=(160*Math.sin(lat/12*Math.PI)+320*Math.sin(lat*Math.PI/30))*2/3; return r; }
function tLng(lng,lat){ let r=300+lng+2*lat+0.1*lng*lng+0.1*lng*lat+0.1*Math.sqrt(Math.abs(lng)); r+=(20*Math.sin(6*lng*Math.PI)+20*Math.sin(2*lng*Math.PI))*2/3; r+=(20*Math.sin(lat*Math.PI)+40*Math.sin(lat/3*Math.PI))*2/3; r+=(150*Math.sin(lat/12*Math.PI)+300*Math.sin(lat/30*Math.PI))*2/3; return r; }
function wgs2gcj(wlat,wlng){ if(outOfChina(wlat,wlng)) return {lat:wlat,lng:wlng}; let dLat=tLat(wlng-105,wlat-35), dLng=tLng(wlng-105,wlat-35); const rad=wlat/180*Math.PI; let m=Math.sin(rad); m=1-ee*m*m; const sq=Math.sqrt(m); dLat=(dLat*180)/((a*(1-ee))/(m*sq)*Math.PI); dLng=(dLng*180)/(a/sq*Math.cos(rad)*Math.PI); return {lat:wlat+dLat,lng:wlng+dLng}; }
function gcj2wgs(glat,glng){ const g=wgs2gcj(glat,glng); return {lat:glat+(glat-g.lat),lng:glng+(glng-g.lng)}; }
function hav(A,B){ const R=6371,r=Math.PI/180; const dLat=(B.lat-A.lat)*r, dLng=(B.lng-A.lng)*r; const la1=A.lat*r, la2=B.lat*r; const h=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }

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
function isGoodPOI(p){ const s=(p.type||'')+'|'+(p.name||''); if(BLOCK_RE.test(s)) return false; return ALLOW_RE.test(p.type||''); }
function addEligible(p){
  if(!isGoodPOI(p)) return false;
  const combo=(p.type||'')+(p.name||'');
  if(UNMISTAKABLE.test(combo)) return true;
  const r=Number((p.biz_ext&&p.biz_ext.rating)||0);
  return r>=MIN_RATING;
}
function normName(n){ return (n||'').replace(/[（(][^()（）]*[)）]/g,'').trim(); }
function dateStr(d){ d=d||new Date(); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }

async function refreshPOIs(maxKm){
  maxKm = maxKm || MAX_KM;
  const all=[]; const dup=new Set();
  for(const kw of KWS){
    const pois = await amapText(kw, 1);
    for(const p of pois){ if(p && p.name && p.location){ const k=p.name+'|'+p.location; if(!dup.has(k)){ dup.add(k); all.push(p); } } }
  }
  const inRange = all.filter(p=>{
    const parts=(p.location||'').split(',').map(Number);
    if(parts.length!==2 || isNaN(parts[0])) return false;
    const w=gcj2wgs(parts[1], parts[0]);
    const km=hav(w, START);
    return km>=MIN_KM && km<=maxKm;
  });
  const eligible = inRange.filter(addEligible);
  const seen=new Set();
  let out = eligible.filter(p=>{ const n=normName(p.name); if(seen.has(n)) return false; seen.add(n); return true; });
  // 保底白名单补捞：常规检索漏网的核心地点，用专名精确检索一次
  const inRangeKm=(p)=>{ const parts=(p.location||'').split(',').map(Number); if(parts.length!==2||isNaN(parts[0])) return Infinity; const w=gcj2wgs(parts[1],parts[0]); return hav(w,START); };
  for(const mh of MUST_HAVE){
    const core=mh.replace(/^福州市/,'');
    if(out.some(p=>normName(p.name).indexOf(core)>=0)) continue;
    const pois=await amapText(mh,1);
    const hit=pois.find(p=>p&&p.name&&p.location&&addEligible(p)&&normName(p.name).indexOf(core)>=0&&inRangeKm(p)<=maxKm);
    if(hit){ out.push(hit); console.log('[补捞] 白名单地点漏网已补回：'+hit.name); }
  }
  return out;
}

if(require.main===module){
(async()=>{
  let html;
  try{ html = fs.readFileSync(TEMPLATE, 'utf8'); }
  catch(e){ console.error('[错] 找不到模板：', TEMPLATE, e.message); process.exit(1); }
  if(!html.includes('const EMBEDDED_SNAPSHOT = null;')){
    console.error('[错] 模板缺少 EMBEDDED_SNAPSHOT 占位符，无法注入'); process.exit(1);
  }
  let pois=[];
  try{ pois = await refreshPOIs(); }
  catch(e){ console.error('[warn] 高德检索异常：', e.message); }
  // 失败保护：足量才注入，否则原样写出（打开时走实时/种子回退）
  if(pois.length < 5){
    try{ fs.writeFileSync(OUTPUT, html); }catch(e){ console.error('[错] 写盘失败', e.message); process.exit(1); }
    console.log('[快照] 高德仅返回 '+pois.length+' 条（不足5），已原样写出模板（打开时自动实时检索）。date='+dateStr());
    process.exit(0);
  }
  const injected = html.replace(
    'const EMBEDDED_SNAPSHOT = null;',
    'const EMBEDDED_SNAPSHOT = '+JSON.stringify(pois)+';'
  );
  try{ fs.writeFileSync(OUTPUT, injected); }
  catch(e){ console.error('[错] 写盘失败', e.message); process.exit(1); }
  console.log('[快照] 已生成自包含 HTML：'+OUTPUT+'  date='+dateStr()+'  内嵌 POI='+pois.length+' 个  文件大小='+(fs.statSync(OUTPUT).size/1024).toFixed(0)+'KB');
})();
}

// 供 run_daily.js 复用：导出检索与门禁参数（require 时不触发生成）
module.exports = { refreshPOIs, amapText, START, MIN_KM, MAX_KM, MIN_RATING, KWS, BLOCK_RE, ALLOW_RE, normName, addEligible };
