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
  // 必须锚定「行首 };」结束（非贪婪 .*? 会被字段值里的 }; 提前截断，导致整块内容丢失）
  const m = tplHtml.match(/(const SPOT_NOTES=\{[\s\S]*?\n\};)/);
  if(!m) return tplHtml;
  // 安全校验：解析出的块若无条目或条目数明显偏少，说明锚点不对，宁可不动
  const cntInBlock=(m[1].match(/['"][^'"]+['"]:\s*\{\s*['"]?u['"]?\s*:/g)||[]).length;
  if(cntInBlock===0) return tplHtml;
  const block = m[1];
  const inner = block.slice('const SPOT_NOTES={'.length, block.length-2); // 去掉首尾 {}
  const trimmed = inner.replace(/\s+$/,'');
  const sep = (trimmed.slice(-1)===',') ? '' : ',';   // 已有逗号则复用，否则补一个
  const lines = added.map(a=>"  "+JSON.stringify(a.n)+": "+JSON.stringify({u:a.u,warn:a.warn,food:a.food,_auto:true,_type:a._type||'',_addr:a._addr||'',_rating:a._rating||''}));
  const newInner = trimmed + sep + '\n' + lines.join(',\n') + '\n';
  return tplHtml.replace(block, () => 'const SPOT_NOTES={' + newInner + '};');
}

/* ===== 同场所细分点合并（跨起点合并结果去重，避免同一片沙滩/公园刷出多条） =====
   只做两类「高置信」合并，宁少勿错：
   A) 「父名-子点」：父名已在列表中 → 子点并入父名
   B) 同一场所的不同叫法：核心名相近 + 同在海边/山边（≤5km）+ 名称都以同类型词结尾
   —— 刻意不按「类型相同」合并，避免「福州广场」被并进某个公园这类误伤。 */
const SUB_SUFFIX=/(观景台|观景平台|瞭望台|观景塔|观景点|北门|南门|东门|西门|正门|大门|入口|出口|出入口|主入口|停车场|停车区|游客中心|游客服务中心|售票处|售票厅|服务中心|服务区|服务站|咨询台|卫生间|洗手间|公厕|驿站|美食广场|美食街|商铺|店铺|一期|二期|三期|东区|西区|南区|北区|中区|儿童乐园|游乐区|萌宠园|科普区|表演场|观景区|游览区|体验区|亲子区|戏水区|沙池|凉亭|旱溪|柳树平台|平台|码头|栈道|步道|绿道|廊桥|雕塑|石碑|喷泉|花海|草坪|露营区|野餐区)$/;
/* 类型词按「越长越具体」排序，先匹配到更具体的（沙滩公园 应判为公园，而不是沙滩） */
const KINDS=['海滨浴场','浴场','森林公园','湿地公园','儿童公园','主题公园','沙滩公园','海滨公园','海洋世界','水族馆','科技馆','图书馆','植物园','动物园','风景区','古镇','古街','温泉','沙滩','海滩','湿地','公园','广场'];
function haversineKm(a,b){
  const R=6371, rad=x=>x*Math.PI/180;
  const dLat=rad(b.lat-a.lat), dLng=rad(b.lng-a.lng);
  const s=Math.sin(dLat/2)**2 + Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
const ADMIN_PREFIX=/^(福州市|福建省|福州|中国|长乐区|长乐市|长乐|闽侯县|闽侯|连江县|连江|永泰县|永泰|罗源县|罗源|闽清县|闽清|平潭县|平潭|马尾区|马尾|晋安区|晋安|仓山区|仓山|鼓楼区|鼓楼|台江区|台江|琅岐镇|琅岐|琯头镇|晓澳镇|漳港街道|漳港|白沙镇)/;
/* 剥掉行政前缀 + 括号；保留连字符（用于识别「父名-子点」），由调用方按需去连字符 */
function coreName(n, keepDash){
  let s=(n||'').replace(/[（(][^()（）]*[)）]/g,'').trim();
  s=s.replace(ADMIN_PREFIX,'').trim();
  if(!keepDash) s=s.replace(/[－\-—]/g,'');
  return s.trim();
}
/* 名称的「类型词」：取落尾的那个（沙滩公园→沙滩公园，侯官沙滩→沙滩） */
function kindOf(n){
  const s=coreName(n);
  for(const k of KINDS){ if(s.endsWith(k)) return k; }
  return '';
}
/* 去掉类型词后的「专名」，用于判断是否同一场所 */
/* 类型词是否同类：沙滩/海滩/沙滩公园 属同一类滨海场所；公园 与 沙滩公园 可跨（沙滩公园内实体） */
function kinCompatible(a,b){
  if(a===b) return true;
  const sea=/沙滩|海滩|海滨|浴场/;
  if(sea.test(a) && sea.test(b)) return true;
  return false;
}
function stemOf(n){
  const s=coreName(n), k=kindOf(n);
  if(!k || !s.endsWith(k)) return s;
  let st=s.slice(0, s.length-k.length);
  // 「沙滩公园」整名就是类型词 → 再剥一层泛类型词（公园），专名回到「沙滩」
  if(!st && /^(沙滩|海滩|湿地|森林|海滨|儿童|主题)公园$/.test(k)) st=k.replace(/公园$/,'');
  // 「体育公园」等把属性当专名时，剥掉「体育」这类非专有属性词，避免与「金牛山公园」混淆
  st=st.replace(/(体育|休闲|郊野|城市|综合|文化|生态)$/,'');
  return st;
}

/* 同地异名 / 重复地点的「副名→主名」映射。
   自动任务据此把候选里的副名归并到主名（不论有无坐标），并清理知识库内部重复。
   发现新重复时在此追加一行即可（副名在前、主名在后），零误伤。
   主名本身无需列出——aliasOf 对未映射名返回自身。 */
const ALIAS = {
  '农大沙滩':'沙滩公园',
  '福州沙滩':'沙滩公园',
  '福州沙滩公园':'沙滩公园',
  '乌龙江沙滩':'沙滩公园',
  '乌龙江沙滩公园':'沙滩公园',
  '闽江沙滩':'沙滩公园',
  '金山沙滩':'沙滩公园',
  '沙滩公园(乌龙江)':'沙滩公园',
};
/* 名称归一：副名→主名；未映射名返回自身（即主名）。用于跨候选 / 跨知识库的等价判定 */
function aliasOf(n){
  const c=coreName(n);
  return ALIAS[n] || ALIAS[c] || ALIAS[stemOf(n)] || n;
}

/* ===== 大模型深度提质（可选，零依赖 OpenAI 兼容接口）=====
   仅对 SPOT_NOTES 中 _auto:true（机器生成、待精修）的条目做提质；
   人工精修过的条目（无 _auto）永不触碰。提质后标记 _llm:true + _llm_date，
   避免重复花费；超过 LLM_REUPGRADE_DAYS 天的 _auto 条目会被重新提质。
   未配置 LLM_API_KEY 时自动降级（沿用 autoFill 基础攻略），不影响主流程。 */
const LLM_API_KEY = (process.env.LLM_API_KEY||'').trim();
const LLM_BASE_URL = (process.env.LLM_BASE_URL||'https://api.deepseek.com/v1').replace(/\/+$/,'');
const LLM_MODEL = (process.env.LLM_MODEL||'deepseek-chat').trim();
const LLM_REUPGRADE_DAYS = Math.max(0, Number(process.env.LLM_REUPGRADE_DAYS||'30')||0);
const LLM_MAX_PER_RUN = Math.max(1, Number(process.env.LLM_MAX_PER_RUN||'40')||1);
const LLM_ENABLED = !!LLM_API_KEY;

function todayISO(){ const d=new Date(); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }
function dateDiffDays(s){ try{ const a=new Date(s), b=new Date(); return Math.floor((b-a)/86400000); }catch(e){ return 999; } }
function stripJson(text){
  if(!text) return null;
  let t=text.trim();
  const i=t.indexOf('{'), j=t.lastIndexOf('}');
  if(i>=0&&j>i) t=t.slice(i,j+1);
  try{ return JSON.parse(t); }catch(e){ return null; }
}
// OpenAI 兼容 chat/completions（零依赖 https）
function llmChat(system, user){
  return new Promise((resolve,reject)=>{
    if(!LLM_ENABLED) return reject(new Error('LLM 未启用'));
    const body=JSON.stringify({model:LLM_MODEL, messages:[{role:'system',content:system},{role:'user',content:user}], temperature:0.6, max_tokens:500, response_format:{type:'json_object'}});
    let u; try{ u=new URL(LLM_BASE_URL+'/chat/completions'); }catch(e){ return reject(e); }
    const req=https.request({hostname:u.hostname,port:u.port||443,path:u.pathname+(u.search||''),method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+LLM_API_KEY}}, res=>{
      let b=''; res.on('data',c=>b+=c); res.on('end',()=>{
        try{
          if(res.statusCode!==200) return reject(new Error('LLM HTTP '+res.statusCode+' '+(b||'').slice(0,160)));
          const j=JSON.parse(b); const txt=(j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content)||'';
          if(!txt) return reject(new Error('LLM 返回空'));
          resolve(txt);
        }catch(e){ reject(new Error('LLM 解析失败 '+(b||'').slice(0,160))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, ()=>{ try{req.destroy();}catch(e){} reject(new Error('LLM 超时')); });
    req.write(body); req.end();
  });
}
const LLM_SYSTEM = '你是福州本地亲子出行攻略编辑。根据用户提供的地点【类型、地址、评分】等真实信息及通用带娃常识，撰写具体、实用的亲子游玩攻略。仅基于给定信息与常识，严禁编造具体票价、营业时间、设施名称、电话、路线等细节；不确定就用通用建议。只输出一个 JSON 对象（不要解释文字）：{"u":"怎么玩/亮点，口语化，60字内","warn":"注意事项，50字内","food":"餐饮建议，40字内"}';
function llmUpgradeOne(name, kind, addr, rating){
  const info='地点：'+name+'\n类型：'+(kind||'亲子目的地')+'\n地址：'+(addr||'当地')+'\n评分：'+(rating||'暂无');
  return llmChat(LLM_SYSTEM, info+'\n\n请基于以上真实信息，为该地点撰写差异化亲子攻略（沙滩、森林、动物园、湿地等类型应有不同侧重）。').then(stripJson).then(o=>{
    if(!o||typeof o.u!=='string'||typeof o.warn!=='string'||typeof o.food!=='string'||!o.u.trim()||!o.warn.trim()||!o.food.trim()) return null;
    return { u:o.u.trim().slice(0,80), warn:o.warn.trim().slice(0,70), food:o.food.trim().slice(0,60) };
  }).catch(()=>null);
}
// 解析并重写 SPOT_NOTES 中的 _auto 待精修条目（超时/失败降级、每轮上限、可定时重提质）
// 前提：SPOT_NOTES 条目值为扁平 JSON（u/warn/food/_auto 等），字符串值不含花括号
/* ===== 每日信息保鲜（零额外 API，复用当天 merged 高德数据）=====
   命中（名称/别名一致）→ 写 _rating_now（最新评分）；
   未命中且「曾检索到过」（已有 _rating_now）→ 保守标 _gone（可能停业/搬迁/超范围）；
   未命中且无历史记录 → 不动（避免对远郊/冷门地点误报停业）。 */
/* 重写 SPOT_NOTES 单行条目：务必保留原行尾逗号。
   历史事故：直接用 '  name: {...}' 覆写会吞掉行尾逗号，使下一行条目被解析为
   「字符串 + 字符串」→ 整段内联脚本 SyntaxError → 页面白屏。此处统一收口。 */
function setNoteLine(lines, r, name, val){
  const hadComma = /,\s*$/.test(lines[r]);
  lines[r] = '  '+JSON.stringify(name)+': '+JSON.stringify(val)+(hadComma?',':'');
}
/* 求值 SPOT_NOTES 条目值：历史条目既有严格 JSON，也有 {u:'...'} 这类 JS 字面量，
   统一用 V8 在空上下文求值，使两类条目都能参与保鲜（JSON.parse 会漏掉后者）。 */
function evalJsObj(src){
  const vm=require('vm');
  return new vm.Script('('+src+')').runInNewContext(Object.create(null));
}
function countNoteEntries(block){
  const entryRe=/^\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:\s*(\{.*\})\s*,?\s*$/;
  return block.split('\n').filter(l=>entryRe.test(l)).length;
}
/* SPOT_NOTES 自检：条目数不变 + 每个条目值作为 JS 表达式可编译
   （兼容 {u:'...'} 这类非严格 JSON 的历史写法） */
function assertNotesBlockOk(block, expectCount, label){
  const vm=require('vm');
  const entryRe=/^\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:\s*(\{.*\})\s*,?\s*$/;
  let n=0, bad=0;
  for(const line of block.split('\n')){
    const mm=line.match(entryRe); if(!mm) continue;
    n++;
    try{ new vm.Script('('+mm[2]+')'); }
    catch(e){ bad++; if(bad<=3) console.warn('[自检] 条目值不可编译，跳过：'+mm[1].slice(0,24)+'… '+e.message); }
  }
  if(bad>0) throw new Error(label+' 自检失败：'+bad+' 条条目值无法作为 JS 表达式编译');
  if(expectCount!=null && n!==expectCount) throw new Error(label+' 自检失败：条目数 '+n+' ≠ 预期 '+expectCount);
  return n;
}
/* 发布前语法体检：把页面所有内联 <script> 交给 V8 编译（只编译不执行）。
   任一脚本有语法错误即中止发布，保留线上旧版本，避免白屏。 */
function assertPageJsOk(html, label){
  const vm=require('vm');
  const blocks=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(m=>!/\ssrc\s*=/i.test(m[1]||'')).map(m=>m[2]).filter(s=>s.trim().length>0);
  if(!blocks.length){ console.error('[体检] '+label+' 未找到任何内联脚本，已中止发布'); process.exit(1); }
  blocks.forEach((code,i)=>{
    try{ new vm.Script(code, {filename:label+'#inline'+i+'.js'}); }
    catch(e){ console.error('[体检] '+label+' 内联脚本#'+i+' 语法错误，已中止发布（线上保留旧版）：'+e.message); process.exit(1); }
  });
  const m=html.match(/(const SPOT_NOTES=\{[\s\S]*?\n\};)/);
  if(m){
    try{ assertNotesBlockOk(m[1], null, label+' SPOT_NOTES'); }catch(e){ console.error('[体检] '+e.message+'，已中止发布'); process.exit(1); }
    // 严格 JSON 检查：条目值必须能被 JSON.parse（常规检查由 normalizeNotes 兜底，此处为最后确认）
    const entryRe=/^\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:\s*(\{.*\})\s*,?\s*$/;
    let nonStrict=0;
    for(const line of m[1].split('\n')){
      const em=line.match(entryRe); if(!em) continue;
      try{ JSON.parse(em[2]); }catch(e){ nonStrict++; }
    }
    if(nonStrict>0){ console.error('[体检] '+label+' SPOT_NOTES 仍有 '+nonStrict+' 条非严格 JSON，已中止发布'); process.exit(1); }
  }
}
/* 格式守卫（常规检查）：把 SPOT_NOTES 中非严格 JSON 的条目统一为严格 JSON。
   覆盖两类历史写法：单引号键（'动物园':）与 JS 字面量值（{u:'…',warn:'…'}）。
   2026-10-26 已一次性清理 252 条；此处作为常规检查长期保留，防止旧格式再次混入。 */
function normalizeNotes(html){
  const m = html.match(/(const SPOT_NOTES=\{[\s\S]*?\n\};)/);
  if(!m) return { html, changed:0 };
  const block = m[1];
  const entryRe = /^\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:\s*(\{.*\})\s*,?\s*$/;
  const lines = block.split('\n');
  const beforeCount = countNoteEntries(block);
  const out = []; let changed = 0, failed = 0;
  for(const line of lines){
    const mm = line.match(entryRe);
    if(!mm){ out.push(line); continue; }
    const rawKey = mm[1], q = rawKey[0];
    let name = rawKey.slice(1,-1);
    name = q === "'" ? name.replace(/\\'/g, "'") : name.replace(/\\"/g, '"');
    let val;
    try{ val = evalJsObj(mm[2]); }
    catch(e){ failed++; console.warn('[格式] 条目值无法求值，保持原样：'+name); out.push(line); continue; }
    const hadComma = /,\s*$/.test(line);
    const nl = '  '+JSON.stringify(name)+': '+JSON.stringify(val)+(hadComma?',':'');
    if(nl !== line) changed++;
    out.push(nl);
  }
  if(!changed){ if(failed) console.warn('[格式] '+failed+' 条无法规范化，请人工检查'); return { html, changed:0 }; }
  const newBlock = out.join('\n');
  assertNotesBlockOk(newBlock, beforeCount, '格式守卫后 SPOT_NOTES');
  console.log('[格式] 已统一 '+changed+' 条为非严格 JSON 的条目（键名/值统一双引号）');
  return { html: html.replace(block, newBlock), changed };
}
async function freshenNotes(html, merged){
  const m=html.match(/(const SPOT_NOTES=\{[\s\S]*?\n\};)/);
  if(!m || !Array.isArray(merged)) return html;
  const block=m[1];
  const lines=block.split('\n');
  const entryRe=/^\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:\s*(\{.*\})\s*,?\s*$/;
  const byName=new Map();
  for(const p of merged){
    const nm=(p.name||'').trim(); if(!nm) continue;
    const key=aliasOf(nm);
    if(!byName.has(key)) byName.set(key, p);
  }
  const rows=[];
  const beforeCount = countNoteEntries(block);   // 自检基线：改动前的条目总数
  for(let r=0;r<lines.length;r++){
    const mm=lines[r].match(entryRe); if(!mm) continue;
    const name=mm[1].slice(1,-1).replace(/\\'/g,"'").replace(/\\"/g,'"');
    let val; try{ val=evalJsObj(mm[2]); }catch(e){ continue; }
    rows.push({r,name,val});
  }
  let refreshed=0, gone=0, changed=0;
  for(const {r,name,val} of rows){
    const key=aliasOf(name);
    const hit=byName.get(key);
    if(hit){
      const rating=(hit.biz_ext&&hit.biz_ext.rating)||'';
      const nv=Object.assign({},val,{_rating_now:rating});
      delete nv._gone; delete nv._gone_date;
      if(JSON.stringify(nv)!==JSON.stringify(val)){ setNoteLine(lines, r, name, nv); changed++; }
      refreshed++;
    }else if(val._rating_now){
      const nv=Object.assign({},val,{_gone:true,_gone_date:todayISO()});
      if(JSON.stringify(nv)!==JSON.stringify(val)){ setNoteLine(lines, r, name, nv); changed++; gone++; }
    }
  }
  if(!changed){ console.log('[保鲜] 无结构化字段变化'); return html; }
  console.log('[保鲜] 刷新 '+refreshed+' 个地点最新评分；'+gone+' 个今日未检索到已标「可能失效」；共 '+changed+' 条更新');
  const newBlock = lines.join('\n');
  assertNotesBlockOk(newBlock, beforeCount, '保鲜后 SPOT_NOTES');   // 逗号/JSON 兜底自检
  return html.replace(block, newBlock);
}

async function llmUpgradeNotes(html){
  if(!LLM_ENABLED){ console.log('[LLM] 未配置 LLM_API_KEY，跳过深度提质（沿用 autoFill 基础攻略）'); return html; }
  const m=html.match(/(const SPOT_NOTES=\{[\s\S]*?\n\};)/);
  if(!m) return html;
  const block=m[1];
  const lines=block.split('\n');
  // 条目均为单行 JSON（key: 扁平 JSON 值）；按行解析，避免跨行/前瞻的脆弱性
  const entryRe=/^\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:\s*(\{.*\})\s*,?\s*$/;
  const targets=[];
  for(let r=0;r<lines.length;r++){
    const mm=lines[r].match(entryRe);
    if(!mm) continue;
    const name=mm[1].slice(1,-1).replace(/\\'/g,"'").replace(/\\"/g,'"');
    let val; try{ val=JSON.parse(mm[2]); }catch(e){ continue; }
    if(val._auto!==true) continue;
    const need=(!val._llm)||(LLM_REUPGRADE_DAYS>0 && val._llm_date && dateDiffDays(val._llm_date)>=LLM_REUPGRADE_DAYS);
    if(!need) continue;
    targets.push({r,name,val});
  }
  if(!targets.length){ console.log('[LLM] 无待提质条目（_auto 均已 AI 精修过）'); return html; }
  console.log('[LLM] 计划深度提质 '+targets.length+' 个 _auto 条目（上限 '+LLM_MAX_PER_RUN+'/轮，串行+超时保护）');
  let ok=0, fail=0;
  for(let i=0;i<targets.length && ok+fail<LLM_MAX_PER_RUN;i++){
    const t=targets[i];
    const kind=t.val._type||kindOf(t.name)||'';
    const out=await llmUpgradeOne(t.name, kind, t.val._addr, t.val._rating);
    if(!out){ fail++; continue; }
    const newVal=Object.assign({}, t.val, {u:out.u, warn:out.warn, food:out.food, _auto:true, _llm:true, _llm_date:todayISO()});
    setNoteLine(lines, t.r, t.name, newVal);
    ok++;
  }
  console.log('[LLM] 深度提质完成：成功 '+ok+' / 失败(降级保留原攻略) '+fail+(ok+fail>=LLM_MAX_PER_RUN?'（已达本轮上限，余下下次跑）':''));
  if(ok===0) return html;
  return html.replace(block, lines.join('\n'));
}

function xy(p){
  const parts=(p.location||'').split(',').map(Number);
  if(parts.length!==2 || isNaN(parts[0])||isNaN(parts[1])) return null;
  return {lng:parts[0], lat:parts[1]};   // 均为高德 GCJ-02，可直接算距离
}
function ratingOf(p){ const r=p.biz_ext&&p.biz_ext.rating; const v=Number(Array.isArray(r)?0:r); return isNaN(v)?0:v; }
/* 组内挑最该展示的主条目：非子点优先 → 有评分优先 → 评分高 → 有地址 */
function pickMain(group){
  return group.slice().sort((a,b)=>{
    const aSub=(SUB_SUFFIX.test(coreName(a.name))||/[－\-—]/.test(a.name))?0:1;
    const bSub=(SUB_SUFFIX.test(coreName(b.name))||/[－\-—]/.test(b.name))?0:1;
    if(aSub!==bSub) return bSub-aSub;
    const ar=ratingOf(a), br=ratingOf(b);
    if((ar>0)!==(br>0)) return (br>0)-(ar>0);
    if(br!==ar) return br-ar;
    return (b.address?1:0)-(a.address?1:0);
  })[0];
}
function dedupeSamePlace(list){
  const n=list.length;
  const dead=new Array(n).fill(false);
  const folded=[];
  const core=list.map(p=>coreName(p.name, true));
  const pos=list.map(xy);
  const addrOf=p=>String(p.address||'').replace(/[（(][^()（）]*[)）]/g,'');
  // 明确子设施：动物馆/展馆/亭台/入口/停车/驿站等（不包含「沙滩/公园/乐园/度假村」这类独立场所名）
  const SUB_ONLY=/(观景台|观景平台|瞭望台|观景塔|观景点|北门|南门|东门|西门|正门|大门|主入口|入口|出口|出入口|停车场|停车区|游客中心|游客服务中心|售票处|售票厅|服务中心|服务区|服务站|咨询台|卫生间|洗手间|公厕|驿站|美食广场|美食街|一期|二期|三期|东区|西区|南区|北区|中区|游乐区|萌宠园|科普区|表演场|观景区|游览区|体验区|亲子区|戏水区|沙池|凉亭|旱溪|柳树平台|平台|码头|栈道|步道|绿道|廊桥|雕塑|石碑|喷泉|花海|草坪|露营区|野餐区|广场)$/;
  const EXHIBIT=/^[一-龥]{1,5}(馆|区|苑|舍|笼|棚|池|展区|展示|馆区)$/;
  const isSubName=(nm)=>{
    const c=coreName(nm);
    if(EXHIBIT.test(c) && !/沙滩|海滩|公园|乐园|度假村|酒店|餐厅/.test(c)) return true;
    // 「XX-凉亭 / XX-主入口广场 / XX-长颈鹿馆」形态
    const m=c.match(/^(.{2,})[－\-—](.+)$/);
    if(m && (SUB_ONLY.test(m[2]) || EXHIBIT.test(m[2]))) return true;
    return false;
  };

  // A) 「父名-子点」：父名在列表中 → 子点并入
  for(let i=0;i<n;i++){
    if(dead[i]) continue;
    const m=core[i].match(/^(.{2,})[－\-—](.+)$/);
    if(!m) continue;
    if(!isSubName(list[i].name)) continue;
    const parent=m[1].trim();
    const pIdx=core.findIndex((cj,j)=>j!==i && !dead[j] && (cj===parent || cj===parent+'公园' || coreName(list[j].name)===parent));
    if(pIdx>=0){ dead[i]=true; folded.push({name:list[i].name, into:list[pIdx].name}); }
  }

  // B) 纯子设施名（华南虎馆/狼馆/河马馆）→ 地址写明在某场所内，则并入该场所
  for(let i=0;i<n;i++){
    if(dead[i]) continue;
    if(!isSubName(list[i].name)) continue;          // 只对「明确子设施」启用，独立场所名绝不并
    const ai=addrOf(list[i]);
    if(!ai) continue;
    let best=-1, bestLen=0;
    for(let j=0;j<n;j++){
      if(j===i||dead[j]) continue;
      const nm=list[j].name;
      if(!/公园|动物园|景区|景区|风景区|乐园|海洋|度假村|广场/.test(nm)) continue;
      const nj=coreName(nm);
      if(nj.length<3) continue;
      if(ai.includes(nj) && nj.length>bestLen){ best=j; bestLen=nj.length; }
    }
    if(best>=0){ dead[i]=true; folded.push({name:list[i].name, into:list[best].name}); }
  }

  // B2) 「XX-子设施」且 XX 本身就在列表中 → 并入（沙滩公园-凉亭 / 沙滩公园-主入口广场）
  for(let i=0;i<n;i++){
    if(dead[i]) continue;
    const m=core[i].match(/^(.{2,})[－\-—](.+)$/);
    if(!m) continue;
    if(!(SUB_ONLY.test(m[2]) || EXHIBIT.test(m[2]))) continue;
    const parent=m[1].trim();
    const pIdx=core.findIndex((cj,j)=>j!==i && !dead[j] && (cj===parent || cj===parent+'公园'));
    if(pIdx>=0){ dead[i]=true; folded.push({name:list[i].name, into:list[pIdx].name}); }
  }

  // C) 同场所不同叫法合并（增强版）。合并条件（任一满足即合并）：
  //   1) 别名归一：副名→同一主名（不依赖坐标，彻底解决「农大沙滩=沙滩公园」类）
  //   2) 近距同大类：滨海类≤0.5km / 其它同类≤0.3km（同一片沙滩的不同官方名必然极近）
  //   3) 词根相近且≤1.5km（原逻辑，覆盖「侯官沙滩/侯官村沙滩公园」）
  //   4) 地址锚点重叠（一方地址含另一方核心名，如「沙滩公园内」）
  const idxs=[...Array(n).keys()].filter(i=>!dead[i]);
  const used=new Set();
  const seaRe=/沙滩|海滩|海滨|浴场/;
  for(let a=0;a<idxs.length;a++){
    if(used.has(a)) continue;
    const ia=idxs[a], pa=list[ia];
    const ka=kindOf(pa.name), sa=stemOf(pa.name), xa=pos[ia];
    const aa=aliasOf(pa.name);
    const group=[ia];
    for(let b=a+1;b<idxs.length;b++){
      if(used.has(b)) continue;
      const ib=idxs[b], pb=list[ib], xb=pos[ib];
      // 1) 别名归一：副名指向同一主名 → 直接合并（即使无坐标）
      if(aa===aliasOf(pb.name)){ group.push(ib); used.add(b); continue; }
      if(!xb) continue;
      const kb=kindOf(pb.name), sb=stemOf(pb.name);
      if(!kinCompatible(ka,kb)) continue;
      const d=haversineKm(xa,xb);
      const D=(seaRe.test(ka)&&seaRe.test(kb))?0.5:0.3;
      const stemClose=(sa&&sb)&&(sa===sb || (sa.length<sb.length? (sb.startsWith(sa)&&sb.length-sa.length<=2) : (sa.startsWith(sb)&&sa.length-sb.length<=2)));
      const anchor=(addrOf(pa)&&addrOf(pb))&&(addrOf(pa).includes(coreName(pb.name))||addrOf(pb).includes(coreName(pa.name)));
      if(d<=D || (stemClose&&d<=1.5) || anchor){ group.push(ib); used.add(b); }
    }
    used.add(a);
    if(group.length>1){
      // 优先选「主名」（自身即别名主、不在副名表），否则按评分/地址挑主条目
      const mains=group.map(i=>list[i]);
      const main=mains.find(m=>aliasOf(m.name)===m.name) || pickMain(mains);
      for(const i of group){ if(list[i]!==main){ dead[i]=true; folded.push({name:list[i].name, into:main.name}); } }
    }
  }
  return {list:list.filter((p,i)=>!dead[i]), folded};
}

/* 清理知识库（SPOT_NOTES）内部重复：按 ALIAS 把「副名」条目删掉，保留主名条目。
   只在 ALIAS 已确认的范围内清理，零误伤；删除后做结构自检，失败则原样返回。 */
function dedupeNotesHtml(html){
  const m=html.match(/(const SPOT_NOTES=\{[\s\S]*?\n\};)/);
  if(!m) return html;
  const block=m[1];
  const keys=[...block.matchAll(/^\s*'([^']+)':\{/gm)].map(x=>x[1]);
  const have=new Set(keys);
  const drops=keys.filter(k=>{ const a=aliasOf(k); return a && a!==k && have.has(a); });
  if(!drops.length) return html;
  let newBlock=block;
  for(const k of drops){ newBlock=removeNoteEntry(newBlock,k); }
  const cnt=(block.match(/^\s*'([^']+)':\{/gm)||[]).length;
  const newCnt=(newBlock.match(/^\s*'([^']+)':\{/gm)||[]).length;
  if(newCnt!==cnt-drops.length) return html;   // 删除异常，宁可不清理
  console.log('[库内] 清理重复地点 '+drops.length+' 条（'+drops.join('、')+' → 主名）');
  return html.replace(block, newBlock);
}
/* 从 SPOT_NOTES 块中删除名为 key 的整条（含其后逗号）。按大括号配对，遇异常返回原块。 */
function removeNoteEntry(block, key){
  const start=block.indexOf("'"+key+"':{");
  if(start<0) return block;
  const ob=block.indexOf('{', start);
  if(ob<0) return block;
  let depth=0, j=ob;
  for(; j<block.length; j++){
    if(block[j]==='{') depth++;
    else if(block[j]==='}'){ depth--; if(depth===0){ j++; break; } }
  }
  if(depth!==0) return block;
  let end=j;
  const tail=block.slice(end);
  const cm=tail.match(/^\s*,/);
  if(cm) end+=cm[0].length;
  return block.slice(0,start)+block.slice(end);
}

(async()=>{
  // 1) 拉生成器 + 模板 + 起点清单
  const snap = await getFile('build_snapshot.js');
  // 读取模板：用「结构标记」而非具体地名做校验（地名会随清单更新消失，导致标记永不命中→白等重试）
  const tpl = await getFile('福州带娃周末出行.html','const SPOT_NOTES={',3);
  if(!snap || !tpl){ console.error('[错] 仓库缺少 build_snapshot.js 或 福州带娃周末出行.html（模板），请先推送这两个文件'); process.exit(1); }
  fs.writeFileSync(path.join(TMP,'build_snapshot.js'), b64dec(snap.content));
  const tplHtml0 = b64dec(tpl.content);
  // 自检：模板必须是「干净模板」（含快照占位符），否则每天都会在生成环节失败
  if(!tplHtml0.includes('const EMBEDDED_SNAPSHOT = null;')){
    console.error('[错] 仓库模板缺少占位符 const EMBEDDED_SNAPSHOT = null;（模板被生成结果覆盖了，需还原为干净模板）');
    process.exit(1);
  }
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
      const body = { message:'初始化起点清单', content: b64enc(JSON.stringify({origins}, null, 2)), branch: BRANCH };
      // 文件已存在时必须带 sha（GitHub Contents API 规则），否则 422 "sha wasn't supplied"
      try{ const cur = await getFile('origins.json'); if(cur && cur.sha) body.sha = cur.sha; }catch(e){}
      await gh('PUT','/repos/'+OWNER+'/'+REPO+'/contents/'+encodeURIComponent('origins.json'), body);
      console.log('[起点] 已写入种子 origins.json（默认：农林大学）');
    }catch(e){
      // 已存在同内容文件时 GitHub 会报 422 "sha ... is at ... but expected ..."，属幂等写入，不算失败
      if(/sha/i.test(e.message) && /exist|same|expected/i.test(e.message)) console.log('[起点] origins.json 已存在且内容一致，跳过写入');
      else console.warn('[起点] 种子写入失败（每日仍按默认检索，不影响出清单）：', e.message);
    }
  }
  console.log('[起点] 共 '+origins.length+' 个：'+origins.map(o=>o.name).join('、'));

  // 2b) 起点守卫：外部「起点同步（后端自动）」是覆盖式写入，每次只写本次那一个起点，
  //     会把其余起点整条删掉（历史事故：福建农林大学金山校区被删，只剩 1 个起点）。
  //     此处按基线起点做自愈补回，保证每日检索范围不缩水。可用 ORIGIN_GUARD=0 关闭。
  if(process.env.ORIGIN_GUARD !== '0'){
    const BASELINE = [
      { name:'福建农林大学金山校区', lng:119.2329,   lat:26.0872   },
      { name:'融侨旗山别墅',         lng:119.212191, lat:25.981606 }
    ];
    const have = new Set((origins||[]).map(o=>String(o.name||'').trim()));
    const missing = BASELINE.filter(b=>!have.has(b.name));
    if(missing.length){
      console.warn('[起点守卫] 检测到基线起点缺失：'+missing.map(m=>m.name).join('、')+'（疑似被覆盖式同步删除），已自动补回');
      const mergedOrigins = (origins||[]).filter(o=>String(o.name||'').trim()).concat(missing);
      try{
        const body = { message:'起点守卫：自动补回缺失基线起点（'+missing.map(m=>m.name).join('、')+'）',
                       content: b64enc(JSON.stringify({origins:mergedOrigins}, null, 2)), branch: BRANCH };
        try{ const cur = await getFile('origins.json'); if(cur && cur.sha) body.sha = cur.sha; }catch(e){}
        await gh('PUT','/repos/'+OWNER+'/'+REPO+'/contents/'+encodeURIComponent('origins.json'), body);
        origins = mergedOrigins;
        console.log('[起点守卫] origins.json 已补回，当前 '+origins.length+' 个：'+origins.map(o=>o.name).join('、'));
      }catch(e){ console.warn('[起点守卫] 补回失败（本次按现有起点检索）：', e.message); }
    }
  }

  // 3) 每日确认：围绕每个起点 80km 检索，合并去重（REBUILD=1 时跳过高德，复用已发布快照）
  const REBUILD = process.env.REBUILD === '1';
  let merged = [];
  try{
    if(REBUILD){
      // 轻量重建：从已发布的 index.html 读回 EMBEDDED_SNAPSHOT（所有起点 80km 合并结果），
      // 用「已 AI 精修的模板」重新生成并发布，使当天新抓的 _auto 地点当天即精修，消除 1 天滞后。
      const idxF = await getFile('index.html');
      const idxHtml = b64dec(idxF.content);
      const mm = idxHtml.match(/const EMBEDDED_SNAPSHOT = (\[[\s\S]*?\]);/);
      const slim = mm ? JSON.parse(mm[1]) : [];
      if(!Array.isArray(slim) || slim.length < 5) throw new Error('读回已发布快照失败或为空');
      merged = slim.map(s=>({ name:s.name, location:s.location, type:s.type, address:s.address, biz_ext:{rating:s.rating||'', cost:s.cost||''} }));
      console.log('[REBUILD] 从已发布 index 读回快照 POI '+merged.length+' 个（跳过高德检索）');
    } else {
      merged = await snapMod.aroundSearchAll(origins, 80);
      // 兼容：默认起点再补一次关键词文本检索（0-30km），覆盖周边检索可能漏掉的类别
      const def = await snapMod.refreshPOIs(30);
      const seen = new Set(merged.map(p=>(p.name||'')+'|'+(p.location||'')));
      for(const p of def){ const k=(p.name||'')+'|'+(p.location||''); if(!seen.has(k)){ seen.add(k); merged.push(p); } }
      console.log('[检索] 围绕 '+origins.length+' 个起点 80km 合并去重后 POI '+merged.length+' 个');
      // 同场所细分点合并：同一片沙滩/公园的多个点位只留主条目（父名-子点、近距同名）
      const before = merged.length;
      const dd = dedupeSamePlace(merged);
      merged = dd.list;
      if(dd.folded.length){
        console.log('[合并] 同场所细分点 '+dd.folded.length+' 条已并入主条目（'+before+' → '+merged.length+'）：'+
          dd.folded.slice(0,12).map(f=>f.name+'→'+f.into).join('、')+(dd.folded.length>12?' …':''));
      }
    }
  }catch(e){ console.error('[检索/REBUILD] 异常：', e.message); }

  // 4) 与知识库比对，自动补全缺口（安全合并）
  let patched = tplHtml0, added = [], autoCount = 0, skipSub = 0;
  if(!REBUILD){
  try{
    const m = tplHtml0.match(/(const SPOT_NOTES=\{[\s\S]*?\n\};)/);
    const have = new Set((m[1].match(/(['"])([^'"]+)\1:\s*\{\s*['"]?u['"]?\s*:/g)||[]).map(s=>{const mm=s.match(/^(['"])([^'"]+)\1:\s*\{\s*['"]?u['"]?\s*:/);return mm?mm[2]:'';}));
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
      const na = aliasOf(p.name);                 // 别名归一后的主名
      // 主名已在知识库 → 视为已存在，跳过（避免「农大沙滩」等副名被当成新地点补进库）
      if(!n || have.has(n) || (na!==n && have.has(na))) continue;
      const key = (na!==n) ? na : n;             // 入库时统一用主名
      if(haveArr.some(h=>h.indexOf(key)>=0 || key.indexOf(h)>=0)) continue;   // 模糊去重（按归一主名）
      const addr = (p.address||'') + (p.name||'');
      if(haveArr.some(h=>addr.indexOf(h)>=0)){ skipSub++; continue; }      // 子设施（地址含父景区名）跳过
      const note = autoFill(p);
      added.push({ n: key, u: note.u, warn: note.warn, food: note.food, _type: p.type||'', _addr: p.address||'', _rating: (p.biz_ext&&p.biz_ext.rating)||'' });
    }
    patched = patchSpotNotes(tplHtml0, added);
    patched = dedupeNotesHtml(patched);   // 清理知识库内部重复（ALIAS 副名）
    patched = normalizeNotes(patched).html;   // 格式守卫：统一为严格 JSON（常规检查）
    patched = freshenNotes(patched, merged);   // 每日信息保鲜：刷新评分 + 保守标「可能失效」
    patched = await llmUpgradeNotes(patched);   // 大模型深度提质 _auto 条目（可选；无 key 自动降级）
    // 自检：补全后 SPOT_NOTES 必须真的变长，否则说明写入失效（不能再静默当作成功）
    const cntNotes=(h)=>(h.match(/['"][^'"]+['"]:\s*\{\s*['"]?u['"]?\s*:/g)||[]).length;
    const beforeCnt=cntNotes(tplHtml0);
    const afterCnt=cntNotes(patched);
    if(added.length && afterCnt < beforeCnt){
      throw new Error('SPOT_NOTES 写入未生效（'+beforeCnt+' → '+afterCnt+'），已放弃本次自动补全');
    }
    autoCount = added.length;
    console.log('[确认] 知识库已有 '+have.size+' 个；本次自动补全 '+added.length+' 个新地点（_auto 待精修）'+(added.length?('：'+added.map(a=>a.n).join('、')):''));
    console.log('[确认] 跳过子设施 '+skipSub+' 个（地址已含父景区，如动物园内虎馆、植物园子区）');
  }catch(e){
    patched = tplHtml0;
    console.error('[确认] 跳过自动补全：', e.message);
  }
  } else {
    console.log('[REBUILD] 跳过自动补全/保鲜/LLM（模板已含最新精修，仅重建发布）');
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

  // 7) 写回仓库：index.html（发布） + 模板（累积自动补全）
  // 安全校验：生成结果若丢失了模板已有的关键结构（如手机抽屉目录、热门卡片按钮），说明读取到旧副本，宁可失败也不发布旧版
  const MUST_HAVE = ['id="tocDrawer"', 'data-act="guide"', 'id="mList"', 'id="mMore"', 'markNewBadges', 'renderMList'];
  const lost = MUST_HAVE.filter(k => tplHtml0.includes(k) && !outHtml.includes(k));
  if(lost.length){ console.error('[错] 生成结果丢失关键结构：'+lost.join(', ')+'（疑似读取到旧模板副本），已中止发布'); process.exit(1); }
  // 语法体检（发布前最后一道闸）：内联脚本必须能被 JS 引擎编译，否则绝不覆盖线上 index.html
  assertPageJsOk(outHtml, 'index.html');
  console.log('[体检] index.html 内联脚本语法校验通过，允许发布');
  const existing = await getFile('index.html');
  const payload = { message:(REBUILD?'轻量重建':'每日快照')+' '+new Date().toISOString().slice(0,10)+' · 扩库+'+autoCount, content, branch: BRANCH };
  if(existing && existing.sha) payload.sha = existing.sha;
  await gh('PUT','/repos/'+OWNER+'/'+REPO+'/contents/'+encodeURIComponent('index.html'), payload);
  // 发布后回读复核：仓库内容必须与本地生成内容一致且再次通过语法体检
  const back = await getFile('index.html');
  const backTxt = back ? b64dec(back.content) : '';
  if(!backTxt || backTxt !== outHtml){ console.error('[复核] 仓库 index.html 与本地生成内容不一致，请人工检查'); process.exit(1); }
  assertPageJsOk(backTxt, 'index.html(回读)');
  console.log('[复核] 仓库回读一致，语法校验通过（'+backTxt.length+' 字节）');
  if(!REBUILD){
    // 模板同样要体检：模板被写坏会污染次日所有生成结果（历史事故来源）
    assertPageJsOk(patched, '福州带娃周末出行.html');
    console.log('[体检] 模板内联脚本语法校验通过，允许写回');
    const tplSha = (await getFile('福州带娃周末出行.html')).sha;
    await gh('PUT','/repos/'+OWNER+'/'+REPO+'/contents/'+encodeURIComponent('福州带娃周末出行.html'),
      { message:'每日自动补全累计（'+autoCount+' 个）', content: b64enc(patched), branch: BRANCH, sha: tplSha });
  }
  const raw = 'https://raw.githubusercontent.com/'+OWNER+'/'+REPO+'/'+BRANCH+'/index.html';
  const view = 'https://'+OWNER.toLowerCase()+'.github.io/'+REPO+'/';
  console.log('[完成] 已发布：'+raw);
  console.log('[查看] 渲染链接：'+view);
  console.log('[完善度] 当日围绕 '+origins.length+' 个起点 80km 共 '+merged.length+' 个地点；其中 '+autoCount+' 个为自动生成，待人工精修（页面该地点攻略顶部标注「⚠️ 自动生成」）。');
})().catch(e=>{ console.error('[失败]', e.message); process.exit(1); });
