#!/usr/bin/env node
'use strict';
// 福州带娃周末出行 · 每日推送器（零依赖 Node，供平台 08:00 定时任务调用）
// ---------------------------------------------------------------
// 全程走 GitHub Contents API（无需 git clone）：
//   1) 从仓库拉 build_snapshot.js + 模板 HTML + origins.json（起点清单）
//   2) 围绕「origins.json 里记录的每一个起点」做 80km 周边检索，合并去重 → 候选 POI
//   3) 与模板 SPOT_NOTES 比对：知识库缺失的新地点 → 用高德信息自动生成基础攻略并入
//      （标记 _auto，待人工精修；子设施如「虎馆/植物园子区」若地址已含某父景区名则跳过）
//   4) node build_snapshot.js 生成自包含 今日.html（内嵌当天高德 POI）
//   5) 把 今日.html / 模板 / origins.json 写回仓库（index.html 经 GitHub Pages 渲染）
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

// 把自动补全的新条目「安全地」追加进 SPOT_NOTES 块：
// 键与值一律用 JSON.stringify 生成（引号/换行/反斜杠/$ 全部转义），绝不产生语法错误；
// 用函数式 replace，避免高德数据里的 $ 被当成替换模式。
function patchSpotNotes(tplHtml, added){
  if(!added.length) return tplHtml;
  const m = tplHtml.match(/(const SPOT_NOTES=\{[\s\S]*?\n\};)/);
  if(!m) return tplHtml;
  const block = m[1];
  const inner = block.slice('const SPOT_NOTES={'.length, block.length-2); // 去掉首尾 {}
  const trimmed = inner.replace(/\s+$/,'');
  const lastChar = trimmed.slice(-1);
  const sep = (lastChar===',') ? '' : ',';   // 已有逗号则复用，否则补一个
  const lines = added.map(a=>"  "+JSON.stringify(a.n)+": "+JSON.stringify({u:a.u,warn:a.warn,food:a.food,_auto:true}));
  const newInner = trimmed + sep + '\n' + lines.join(',\n') + '\n';
  return tplHtml.replace(block, () => 'const SPOT_NOTES={' + newInner + '};');
}

(async()=>{
  // 1) 拉生成器 + 模板 + 起点清单
  const snap = await getFile('build_snapshot.js');
  const tpl = await getFile('福州带娃周末出行.html','奇达村',6);
  if(!snap || !tpl){ console.error('[错] 仓库缺少 build_snapshot.js 或 福州带娃周末出行.html（模板），请先推送这两个文件'); process.exit(1); }
  fs.writeFileSync(path.join(TMP,'build_snapshot.js'), b64dec(snap.content));
  const tplHtml0 = b64dec(tpl.content);
  fs.writeFileSync(path.join(TMP,'tpl.html'), tplHtml0);
  const snapMod = require(path.join(TMP,'build_snapshot.js'));

  // 2) 起点清单
  let origins;
  try{
    const oj = await getFile('origins.json');
    origins = JSON.parse(b64dec(oj.content)).origins || [];
  }catch(e){ origins = null; }
  if(!Array.isArray(origins) || !origins.length){
    origins = [{ name:'农林大学(默认)', lng: snapMod.START.lng, lat: snapMod.START.lat }];
    // 写回种子 origins.json
    try{
      await gh('PUT','/repos/'+OWNER+'/'+REPO+'/contents/'+encodeURIComponent('origins.json'),
        { message:'初始化起点清单', content: b64enc(JSON.stringify({origins}, null, 2)), branch: BRANCH });
      console.log('[起点] 已写入种子 origins.json（默认：农林大学）');
    }catch(e){ console.error('[起点] 种子写入失败（每日仍按默认检索）：', e.message); }
  }
  console.log('[起点] 共 '+origins.length+' 个：'+origins.map(o=>o.name).join('、'));

  // 3) 每日确认：围绕每个起点 80km 检索，合并去重
  let merged = [];
  try{
    merged = await snapMod.aroundSearchAll(origins, 80);
    // 兼容：默认起点再补一次关键词文本检索（0-30km），覆盖周边检索可能漏掉的类别
    const def = await snapMod.refreshPOIs(30);
    const seen = new Set(merged.map(p=>(p.name||'')+'|'+(p.location||'')));
    for(const p of def){ const k=(p.name||'')+'|'+(p.location||''); if(!seen.has(k)){ seen.add(k); merged.push(p); } }
    console.log('[检索] 围绕 '+origins.length+' 个起点 80km 合并去重后 POI '+merged.length+' 个');
  }catch(e){ console.error('[检索] 异常：', e.message); }

  // 4) 与知识库比对，自动补全缺口（安全合并）
  let patched = tplHtml0, added = [], autoCount = 0, skipSub = 0;
  try{
    const m = tplHtml0.match(/(const SPOT_NOTES=\{[\s\S]*?\n\};)/);
    const have = new Set((m[1].match(/'([^']+)':\{u:/g)||[]).map(s=>((s.match(/^'([^']+)':\{u:/)||[])[1]||'')));
    const haveArr = [...have];
    // 自动补全「精修标准」：按类型给出实用攻略，不再输出「待人工补全」占位；仍标记 _auto 便于识别待进一步打磨
    const autoFill = (p) => {
      const t = (p.type||'').split(';')[0] || '';
      const r = (p.biz_ext && p.biz_ext.rating) || '';
      const addr = p.address || '当地';
      const rate = r ? ('评分'+r) : '评分暂无（以现场为准）';
      const head = '高德检索到的带娃目的地（'+t+'），'+rate+'，位于'+addr+'。';
      let u, warn, food;
      if (/图书|科教|文化|博物|展览|展覽/.test(t)) {
        u = head + '室内避暑遛娃、免费借阅，多有少儿阅览与绘本专区，低幼宝宝也能安静翻书；空调凉爽不晒，泡半天省心';
        warn = '馆内一般无餐饮售卖，可带水杯（多数有直饮水）；开放时间各馆不同（通常周一闭馆、周末延长），出行前查该馆公众号；带低幼娃注意轻声';
        food = '馆内无餐；就近商圈餐饮解决（路线见地图）';
      } else if (/体育|休闲|游乐|主题公园|游乐园|亲子|玩乐/.test(t)) {
        u = head + '以游乐/运动设施为主，适合带娃放电；室内外结合，注意项目适合年龄';
        warn = '多为收费、项目另计；周末人多排队；动物/游乐区注意卫生与手消毒；低幼选软包区';
        food = '馆内小卖部或商场内餐饮丰富（路线见地图）';
      } else { // 公园/广场/风景名胜/湿地/海滨/植物园/动物园 等户外绿地
        u = head + '城市绿地/景点，多免费开放，适合推车散步、草坪野餐、看景放风；江/河/山景类还能看日落';
        warn = '园内树荫与设施参差，正午暴晒带遮阳；江/水边段务必盯紧娃；无餐饮或仅小卖部，自带饮水零食；开放时间请出行前核实';
        food = '园内基本无餐厅，就近商圈餐饮（路线见地图）';
      }
      return { u, warn, food };
    };
    for(const p of merged){
      const n = normName(p.name);
      if(!n || have.has(n)) continue;
      if(haveArr.some(h=>h.indexOf(n)>=0 || n.indexOf(h)>=0)) continue;   // 模糊去重
      const addr = (p.address||'') + (p.name||'');
      if(haveArr.some(h=>addr.indexOf(h)>=0)){ skipSub++; continue; }      // 子设施（地址含父景区名）跳过
      const note = autoFill(p);
      added.push({ n, u: note.u, warn: note.warn, food: note.food });
    }
    patched = patchSpotNotes(tplHtml0, added);
    autoCount = added.length;
    console.log('[确认] 知识库已有 '+have.size+' 个；本次自动补全 '+added.length+' 个新地点（_auto 待精修）'+(added.length?('：'+added.join('、')):''));
    console.log('[确认] 跳过子设施 '+skipSub+' 个（地址已含父景区，如动物园内虎馆、植物园子区）');
  }catch(e){
    patched = tplHtml0;
    console.error('[确认] 跳过自动补全：', e.message);
  }

  // 5) 生成自包含 HTML（默认起点 0-30km 快照，内嵌再扩为所有起点 80km 合并）
  const outPath = path.join(TMP,'今日.html');
  try{
    fs.writeFileSync(path.join(TMP,'tpl_patched.html'), patched);
    execFileSync('node', [path.join(TMP,'build_snapshot.js'), path.join(TMP,'tpl_patched.html'), outPath], {stdio:'inherit', timeout:150000});
  }catch(e){ console.error('[错] 生成失败', e.message); process.exit(1); }
  let outHtml = fs.readFileSync(outPath,'utf8');

  // 6) 让内嵌快照也覆盖「所有起点 80km」合并结果（离线也能看到全量清单）
  try{
    const slim = merged.map(p=>({ name:p.name, location:p.location, type:p.type, address:p.address,
      rating:(p.biz_ext&&p.biz_ext.rating)||'', cost:(p.biz_ext&&p.biz_ext.cost)||'' }));
    // 注意：高德 type 字段含半角分号（如「公园广场;公园」），必须用「匹配完整数组」而非 [^;]*，否则会在数据里的 ; 处提前截断
    outHtml = outHtml.replace(/const EMBEDDED_SNAPSHOT = (\[[\s\S]*?\]);/, () => 'const EMBEDDED_SNAPSHOT = '+JSON.stringify(slim)+';');
    console.log('[快照] 内嵌 POI 已扩展为所有起点 80km 合并结果（'+slim.length+' 个）');
  }catch(e){ console.error('[快照] 保留默认快照：', e.message); }

  const content = b64enc(outHtml);
  console.log('[生成] 今日.html 大小 '+(fs.statSync(outPath).size/1024).toFixed(0)+'KB');

  // 7) 写回仓库：index.html（发布） + 模板（累积自动补全） + origins.json 若变化由上游维护
  const existing = await getFile('index.html');
  const payload = { message:'每日快照 '+new Date().toISOString().slice(0,10)+' · 扩库+'+autoCount, content, branch: BRANCH };
  if(existing && existing.sha) payload.sha = existing.sha;
  await gh('PUT','/repos/'+OWNER+'/'+REPO+'/contents/'+encodeURIComponent('index.html'), payload);
  const tplSha = (await getFile('福州带娃周末出行.html')).sha;
  await gh('PUT','/repos/'+OWNER+'/'+REPO+'/contents/'+encodeURIComponent('福州带娃周末出行.html'),
    { message:'每日自动补全累计（'+autoCount+' 个）', content: b64enc(patched), branch: BRANCH, sha: tplSha });
  const raw = 'https://raw.githubusercontent.com/'+OWNER+'/'+REPO+'/'+BRANCH+'/index.html';
  const view = 'https://'+OWNER.toLowerCase()+'.github.io/'+REPO+'/';
  console.log('[完成] 已发布：'+raw);
  console.log('[查看] 渲染链接：'+view);
  console.log('[完善度] 当日围绕 '+origins.length+' 个起点 80km 共 '+merged.length+' 个地点；其中 '+autoCount+' 个为自动生成，待人工精修（页面该地点攻略顶部标注「⚠️ 自动生成」）。');
})().catch(e=>{ console.error('[失败]', e.message); process.exit(1); });
