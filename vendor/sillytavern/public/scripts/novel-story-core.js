
export const FIELD_LABELS = { time:'时间', place:'地点', condition:'玩家状态', supplies:'当前物资', people:'在场人物', goal:'当前目标', danger:'潜在危险', changes:'本回合变化' };
export const DEFAULTS = { panel:true, auto:true, expanded:true, choices:4, direct:false, collapseAfterAction:true, dialogue:false, lineHeight:1.9, paragraphGap:1.1, width:880, indent:true, font:'default',
  settleModel:'', settleTokens:8192, settleTimeout:180, settleAttempts:2, checkModel:'', checkTokens:2048, checkTimeout:90, checkAttempts:2 };
export function parseJson(text) {
  if (typeof text !== 'string' || text.length > 2000000) throw new Error('辅助结果为空或过大');
  const raw = text.trim().replace(/^\uFEFF/, '').replace(/^\x60\x60\x60(?:json)?\s*/i,'').replace(/\s*\x60\x60\x60$/,'');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('辅助结果必须是 JSON 对象');
  return value;
}
const bounded = (value, max=500) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export function evidenceValid(evidence, sources) {
  return Array.isArray(evidence) && evidence.length > 0 && evidence.length <= 6 && evidence.every(e =>
    e && bounded(e.source,100) && bounded(e.quote,1500) && Object.hasOwn(sources,e.source) && sources[e.source].includes(e.quote));
}
export function validateSettlement(value, { previous={}, sources={}, text='', limit=4 }) {
  if (!Array.isArray(value.updates) || !Array.isArray(value.actions) || !Array.isArray(value.dialogues)) throw new Error('结算缺少 updates、actions 或 dialogues');
  const state = { ...previous, changes:'尚未明确' };
  const updates = [];
  for (const row of value.updates.slice(0,30)) {
    if (!row || !Object.hasOwn(FIELD_LABELS,row.field) || !bounded(row.value) || !evidenceValid(row.evidence,sources)) continue;
    state[row.field] = row.value; updates.push(row);
  }
  const tendencies = new Set(['kind','self','neutral','personal']);
  const used = new Set();
  const actions = value.actions.filter(row => {
    if (!row || !tendencies.has(row.tendency) || used.has(row.tendency) || !bounded(row.text,220) || !bounded(row.label,12) || !evidenceValid(row.evidence,sources)) return false;
    used.add(row.tendency); return true;
  }).slice(0,limit).map(row=>({ text:row.text, label:row.label, tendency:row.tendency }));
  const dialogues = [];
  for (const row of value.dialogues.slice(0,150)) {
    if (!row || !bounded(row.speaker,60) || !bounded(row.quote,5000) || !bounded(row.attribution,1500) || !text.includes(row.attribution) || !row.attribution.includes(row.speaker) || row.confident !== true) continue;
    const exactHint=Number.isInteger(row.start)&&text.slice(row.start,row.start+row.quote.length)===row.quote; const start=exactHint?row.start:text.indexOf(row.quote);
    if (start < 0 || (!exactHint && text.indexOf(row.quote,start+1)>=0)) continue;
    if (!/^[“「『"]/.test(row.quote) || !/[”」』"]$/.test(row.quote)) continue;
    if (dialogues.some(d=>start<d.end && start+row.quote.length>d.start)) continue;
    dialogues.push({ speaker:row.speaker, start, end:start+row.quote.length });
  }
  return { state, updates, actions, dialogues:dialogues.sort((a,b)=>a.start-b.start) };
}
export function validateCheck(value, sources) {
  if (!['allow','attempt','block','unknown'].includes(value.verdict)) throw new Error('检查未返回有效判断');
  const evidence = evidenceValid(value.evidence,sources) ? value.evidence : [];
  // Unsupported judgement cannot become a hard prohibition.
  const verdict = value.verdict==='block' && !evidence.length ? 'unknown' : value.verdict;
  return { verdict, evidence, suggestion:bounded(value.suggestion,2000)?value.suggestion:'',
    reason: verdict==='unknown' ? '现有公开设定不足，无法可靠判断。可以补充说明、继续编辑，或按一次尝试发送。'
      : verdict==='attempt' ? '这个行动可以尝试，但成功与否由剧情发展决定。'
      : verdict==='block' ? '行动与下方已有设定存在冲突，请修改后再发送。' : '行动符合目前已知条件。' };
}
export function localDialogues(text) {
  const result=[];
  const regex=/([\p{Script=Han}A-Za-z·]{1,12})(?:低声|轻声|大声|冷冷|笑着|缓缓)?(?:说道|问道|答道|说|问|答)?[：:]\s*([“「『"][^“”「」『"\n]{1,2000}[”」』"])/gu;
  for (const match of text.matchAll(regex)) {
    const quote=match[2], start=match.index+match[0].lastIndexOf(quote);
    const speaker=match[1].replace(/(?:低声|轻声|大声|冷冷|笑着|缓缓)?(?:说道|问道|答道|说|问|答)$/u,'');
    if (!speaker||['他','她','它','有人','众人','心中','旁白'].includes(speaker)||speaker.length>4) continue;
    result.push({ speaker, start, end:start+quote.length });
  }
  return result;
}
export function splitDialogue(text, dialogues) {
  const parts=[]; let cursor=0;
  for (const row of [...dialogues].sort((a,b)=>a.start-b.start)) {
    if (!Number.isInteger(row.start)||!Number.isInteger(row.end)||row.start<cursor||row.end>text.length||row.end<=row.start) continue;
    if(row.start>cursor) parts.push({text:text.slice(cursor,row.start)});
    parts.push({text:text.slice(row.start,row.end),speaker:row.speaker}); cursor=row.end;
  }
  if(cursor<text.length) parts.push({text:text.slice(cursor)});
  return parts;
}
export function historyText(chat, end=chat.length-1) {
  return JSON.stringify(chat.slice(0,end+1).map(m=>[m.is_user===true,m.is_system===true,m.name||'',m.mes||'']));
}
export async function fingerprint(chat,end=chat.length-1) {
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(historyText(chat,end)));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export function lastStoryIndex(chat) {
  for(let i=chat.length-1;i>=0;i--) if(!chat[i].is_user&&!chat[i].is_system&&typeof chat[i].mes==='string'&&chat[i].mes.trim()) return i;
  return -1;
}
export function safeSettings(raw={}) {
  const s={...DEFAULTS};
  for(const key of Object.keys(s)) {
    if(typeof s[key]==='boolean') { if(typeof raw[key]==='boolean')s[key]=raw[key]; }
    else if(typeof s[key]==='string') { if(typeof raw[key]==='string')s[key]=raw[key].slice(0,200); }
  }
  for(const [key,min,max] of [['choices',1,4],['lineHeight',1.4,2.6],['paragraphGap',0.5,2],['width',600,1200],['settleTokens',256,393216],['checkTokens',256,393216],['settleTimeout',10,3600],['checkTimeout',10,3600],['settleAttempts',1,5],['checkAttempts',1,5]]) {
    const n=Number(raw[key]??s[key]); s[key]=Number.isFinite(n)?Math.min(max,Math.max(min,n)):s[key];
    if(!['lineHeight','paragraphGap'].includes(key))s[key]=Math.round(s[key]);
  }
  return s;
}

export function completedRoundText(chat,end,grouped=false) {
  if(!grouped)return chat[end]?.mes||'';
  let start=end;
  while(start>0&&!chat[start-1].is_user)start--;
  return chat.slice(start,end+1).filter(m=>!m.is_user&&!m.is_system).map(m=>m.mes||'').join('\n\n');
}
