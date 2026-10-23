#!/usr/bin/env node
'use strict';
// 福州带娃周末出行 · 每日推送器（零依赖 Node，供平台 08:00 定时任务调用）
// ---------------------------------------------------------------
// 全程走 GitHub Contents API（无需 git clone）：
//   1) 从仓库拉 build_snapshot.js + 模板 HTML（保证用最新版生成器）
//   2) node build_snapshot.js 生成自包含 今日.html（内嵌当天高德 POI）
//   3) 把 今日.html 写回仓库（存在则更新，不存在则新建）
// 产物：index.html（稳定公开，经 htmlpreview.github.io / GitHub Pages 渲染为网页）
// 用法：GITHUB_TOKEN=xxx OWNER=xxx REPO=xxx node run_daily.js
// 依赖环境变量：GITHUB_TOKEN（细粒度 PAT，仅该仓库 contents:read&write）、OWNER、REPO

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
async function getFile(p){
  try{ const j=await gh('GET','/repos/'+OWNER+'/'+REPO+'/contents/'+encodeURIComponent(p)+'?ref='+BRANCH); return j; }
  catch(e){ return null; }
}

(async()=>{
  // 1) 拉生成器 + 模板
  const snap = await getFile('build_snapshot.js');
  const tpl = await getFile('福州带娃周末出行.html');
  if(!snap || !tpl){ console.error('[错] 仓库缺少 build_snapshot.js 或 福州带娃周末出行.html（模板），请先推送这两个文件'); process.exit(1); }
  fs.writeFileSync(path.join(TMP,'build_snapshot.js'), b64dec(snap.content));
  fs.writeFileSync(path.join(TMP,'福州带娃周末出行.html'), b64dec(tpl.content));
  console.log('[拉取] build_snapshot.js + 模板 就绪');

  // 2) 生成自包含 HTML
  const outPath = path.join(TMP,'今日.html');
  try{
    execFileSync('node', [path.join(TMP,'build_snapshot.js'), path.join(TMP,'福州带娃周末出行.html'), outPath], {stdio:'inherit', timeout:120000});
  }catch(e){ console.error('[错] 生成失败', e.message); process.exit(1); }
  const content = b64enc(fs.readFileSync(outPath,'utf8'));
  console.log('[生成] 今日.html 大小 '+(fs.statSync(outPath).size/1024).toFixed(0)+'KB');

  // 3) 写回仓库（更新或新建）。统一发布为 index.html（ASCII 文件名，便于 htmlpreview/githack/Pages 渲染）
  const existing = await getFile('index.html');
  const payload = { message:'每日快照 '+new Date().toISOString().slice(0,10), content, branch: BRANCH };
  if(existing && existing.sha) payload.sha = existing.sha;
  await gh('PUT','/repos/'+OWNER+'/'+REPO+'/contents/'+encodeURIComponent('index.html'), payload);
  const raw = 'https://raw.githubusercontent.com/'+OWNER+'/'+REPO+'/'+BRANCH+'/index.html';
  const view = 'https://htmlpreview.github.io/?https://raw.githubusercontent.com/'+OWNER+'/'+REPO+'/'+BRANCH+'/index.html';
  console.log('[完成] 已发布：'+raw);
  console.log('[查看] 渲染链接：'+view);
})().catch(e=>{ console.error('[失败]', e.message); process.exit(1); });
