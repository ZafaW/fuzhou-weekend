#!/usr/bin/env node
'use strict';
// 福州带娃周末出行 · 每日推送器（零依赖 Node，供平台 08:00 定时任务调用）
// ---------------------------------------------------------------
// 全程走 GitHub Contents API（无需 git clone）：
//   1) 从仓库拉 build_snapshot.js + 模板 HTML（保证用最新版生成器与知识库）
//   2) 复用 build_snapshot 的检索，得到「当日清单 POI」，与模板 SPOT_NOTES 比对
//      → 知识库缺失的新地点：用高德 POI 信息自动生成基础攻略并入（标记 _auto，待人工精修）
//      → 保证「每天确认已有 + 新搜索到的景点，且攻略不空缺」
//   3) node build_snapshot.js 生成自包含 今日.html（内嵌当天高德 POI）
//   4) 把 今日.html 写回仓库（index.html，经 GitHub Pages 渲染）
// 用法：GITHUB_TOKEN=xxx OWNER=xxx REPO=xxx node run_daily.js
// 依赖环境变量：GITHUB_TOKEN、OWNER、REPO

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = process.env.OWNER;
const REPO = process.env.REPO;
const BRANCH = process.env.BRANCH || 'main';
const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fz-'));
if(!TOKEN || !OWNER || !REPO){ console.error('[错] 缺少环境变量 GITHUB_TOKEN / OWNER / REPO'); process.exit(1); }

function gh(method, p, body){
  return new Promise((resolve,reject)=>{
    const data = body? JSON.stringify(body):null;
    const req = https.request('https://api.github.com'+p, {
      method,
      headers: {
        'Authorization': 'Bearer '+TOKEN,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'fz-weekend-bot',
        'Content-Type': 'application/json'
      }
    }, res=>{
      let b=''; res.on('data',c=>b+=c); res.on('end',()=>{
        let j=null; try{ j=JSON.parse(b); }catch(e){}
        if(res.statusCode>=200 && res.statusCode<300) resolve(j);
        else reject(new Error('GitHub '+method+' '+p+' -> '+res.statusCode+' '+(j&&j.message||b.slice(0,200))));
      });
    });
    req.on('error', reject);
    if(data) req.write(data);
    req.end();
  });
}
function b64dec(s){ return Buffer.from(s,'base64').toString('utf8'); }
function b64enc(s){ return Buffer.from(s,'utf8').toString('base64'); }
async function getFile(p, marker, tries){
  tries = tries || 1;
  let last = null;
  for(let i=0;i<tries;i++){
    try{
      const j = await gh('GET','/repos/'+OWNER+'/'+REPO+'/contents/'+encodeURIComponent(p)+'?ref='+BRANCH);
      if(!marker || Buffer.from(j.content,'base64').toString('utf8').includes(marker)) return j;
      last = j;  // Contents API 有最终一致延迟：刚 PUT 的模板可能短暂返回旧副本，校验标记后重试
    }catch(e){ last = null; }
    if(i<tries-1) await new Promise(r=>setTimeout(r,8000));
  }
  return last;
}
function normName(n){ return (n||'').replace(/[（(][^()（）]*[)）]/g,'').trim(); }

(async()=>{
  // 1) 拉生成器 + 模板
  const snap = await getFile('build_snapshot.js');
  const tpl = await getFile('福州带娃周末出行.html','奇达村',6);
  if(!snap || !tpl){ console.error('[错] 仓库缺少 build_snapshot.js 或 福州带娃周末出行.html（模板），请先推送这两个文件'); process.exit(1); }
  fs.writeFileSync(path.join(TMP,'build_snapshot.js'), b64dec(snap.content));
  const tplHtml = b64dec(tpl.content);
  fs.writeFileSync(path.join(TMP,'tpl.html'), tplHtml);
  console.log('[拉取] build_snapshot.js + 模板(知识库) 就绪');

  // 2) 每日确认：检索当日清单 POI，与知识库比对，自动补全缺口
  let patched = tplHtml, added = [], totalPoi = 0, autoCount = 0;
  try{
    const snapMod = require(path.join(TMP,'build_snapshot.js'));
    const pois = await snapMod.refreshPOIs(30);   // 与页面默认清单同范围（0-30km 评分≥4.0）
    totalPoi = pois.length;
    const m = tplHtml.match(/(const SPOT_NOTES=\{[\s\S]*?\n\};)/);
    const body = m ? m[1] : '';
    const have = new Set((body.match(/'([^']+)':\{u:/g)||[]).map(s=>((s.match(/^'([^']+)':\{u:/)||[])[1]||'')).filter(Boolean));
    const tail = [];
    for(const p of pois){
      const n = normName(p.name);
      if(!n || have.has(n)) continue;
      if([...have].some(h=>h.indexOf(n)>=0 || n.indexOf(h)>=0)) continue;   // 模糊去重
      const r = (p.biz_ext && p.biz_ext.rating) || '';
      const u = '高德检索到的带娃目的地（'+(p.type||'')+'），评分'+(r||'暂无')+'，位于'+(p.address||'')+'。具体玩法待人工补全。';
      const warn = '信息基于高德，仅供参考；出行前请核实开放时间与票价。';
      const food = '餐饮以'+(p.address||'当地')+'周边为准，建议地图搜索或自备。';
      tail.push("  '"+n+"':{u:'"+u+"',warn:'"+warn+"',food:'"+food+"',_auto:true}");
      added.push(n);
    }
    if(tail.length){
      patched = tplHtml.replace(/(const SPOT_NOTES=\{[\s\S]*?\n\};)/, m0=>m0.replace(/\n\};/,"\n"+tail.join(",\n")+"\n};"));
    }
    fs.writeFileSync(path.join(TMP,'tpl_patched.html'), patched);
    autoCount = added.length;
    console.log('[确认] 当日清单 POI '+totalPoi+' 个；知识库已有 '+have.size+' 个；自动补全 '+added.length+' 个新地点攻略（_auto 待精修）'+(added.length?('：'+added.join('、')):''));
  }catch(e){
    fs.writeFileSync(path.join(TMP,'tpl_patched.html'), tplHtml);
    console.error('[确认] 跳过自动补全：', e.message);
  }

  // 3) 生成自包含 HTML
  const outPath = path.join(TMP,'今日.html');
  try{
    execFileSync('node', [path.join(TMP,'build_snapshot.js'), path.join(TMP,'tpl_patched.html'), outPath], {stdio:'inherit', timeout:150000});
  }catch(e){ console.error('[错] 生成失败', e.message); process.exit(1); }
  const content = b64enc(fs.readFileSync(outPath,'utf8'));
  console.log('[生成] 今日.html 大小 '+(fs.statSync(outPath).size/1024).toFixed(0)+'KB');

  // 4) 写回仓库（更新或新建）。统一发布为 index.html
  const existing = await getFile('index.html');
  const payload = { message:'每日快照 '+new Date().toISOString().slice(0,10), content, branch: BRANCH };
  if(existing && existing.sha) payload.sha = existing.sha;
  await gh('PUT','/repos/'+OWNER+'/'+REPO+'/contents/'+encodeURIComponent('index.html'), payload);
  const raw = 'https://raw.githubusercontent.com/'+OWNER+'/'+REPO+'/'+BRANCH+'/index.html';
  const view = 'https://'+OWNER.toLowerCase()+'.github.io/'+REPO+'/';
  console.log('[完成] 已发布：'+raw);
  console.log('[查看] 渲染链接：'+view);
  // 5) 完善度小结
  console.log('[完善度] 当日 '+totalPoi+' 个地点均有攻略展示；其中 '+autoCount+' 个为自动生成，待人工精修（页面该地点攻略顶部标注「⚠️ 自动生成」）。');
})().catch(e=>{ console.error('[失败]', e.message); process.exit(1); });
