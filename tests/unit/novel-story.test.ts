import { describe, expect, it } from 'vitest';
// @ts-ignore Browser-independent JavaScript also shipped with embedded Tavern.
import { parseJson, validateSettlement, validateCheck, localDialogues, splitDialogue, fingerprint, safeSettings, completedRoundText } from '../../vendor/sillytavern/public/scripts/novel-story-core.js';
describe('interactive story evidence and branch isolation',()=>{
 it('settles all completed group replies after the latest player action',()=>{
   const chat=[{mes:'earlier'},{is_user:true,mes:'action'},{name:'甲',mes:'first'},{name:'乙',mes:'second'}];
   expect(completedRoundText(chat,3,true)).toBe('first\n\nsecond');
   expect(completedRoundText(chat,3,false)).toBe('second');
 });
  it('rejects incomplete JSON rather than inventing a completed settlement',()=>{
    expect(()=>parseJson('{"updates":[')).toThrow();
    expect(()=>parseJson('null')).toThrow();
    expect(parseJson('{"updates":[]}')).toEqual({updates:[]});
  });
  it('accepts sourced changes and actions, drops invented state and duplicate tendencies',()=>{
    const text='林月：“别出声。”城卫正在搜查客栈。';
    const result=validateSettlement({updates:[{field:'place',value:'客栈',evidence:[{source:'body',quote:'搜查客栈'}]},{field:'supplies',value:'无限金币',evidence:[{source:'body',quote:'获得无限金币'}]}],
      actions:[{tendency:'kind',label:'保护',text:'帮林月躲开搜查',evidence:[{source:'body',quote:'林月'}]},{tendency:'kind',label:'重复',text:'重复选项',evidence:[{source:'body',quote:'林月'}]},{tendency:'self',label:'越界',text:'揭露隐藏幕后主使',evidence:[{source:'secret',quote:'秘密'}]}],dialogues:[]},{text,sources:{body:text},previous:{condition:'轻伤'},limit:4});
    expect(result.state).toMatchObject({place:'客栈',condition:'轻伤'});
    expect(result.state.supplies).toBeUndefined();
    expect(result.actions).toHaveLength(1);
  });
  it('never hard-blocks an action without public source evidence',()=>{
    const result=validateCheck({verdict:'block',reason:'剧透秘密',evidence:[{source:'hidden',quote:'主角是皇帝'}]}, {rules:'玩家是普通人'});
    expect(result.verdict).toBe('unknown');expect(result.reason).not.toContain('皇帝');
    expect(validateCheck({verdict:'block',evidence:[{source:'rules',quote:'没有瞬移能力'}]}, {rules:'玩家没有瞬移能力'}).verdict).toBe('block');
  });
  it('keeps every original character when displaying dialogue and rejects ambiguous duplicate quotes',()=>{
    const text='雨停了。\n林月低声说道：“别出声。”\n掌柜：“城卫来了。”';
    const spans=localDialogues(text);
    expect(spans.map((r:any)=>r.speaker)).toEqual(['林月','掌柜']);
    expect(splitDialogue(text,spans).map((p:any)=>p.text).join('')).toBe(text);
    const repeated='林月：“好。”\n掌柜：“好。”';
    expect(validateSettlement({updates:[],actions:[],dialogues:[{speaker:'林月',quote:'“好。”',attribution:'林月',start:999,confident:true}]},{text:repeated,sources:{body:repeated}}).dialogues).toEqual([]);
  });
  it('invalidates downstream state after edits and deletions but restores exact branches',async()=>{
    const chat=[{is_user:true,mes:'进客栈'},{name:'林月',mes:'城卫来了。'}];
    const hash=await fingerprint(chat);
    expect(await fingerprint(structuredClone(chat))).toBe(hash);
    expect(await fingerprint([{...chat[0],mes:'留在街上'},chat[1]])).not.toBe(hash);
    expect(await fingerprint([...chat,{is_user:true,mes:'离开'}])).not.toBe(hash);
    expect(await fingerprint(chat.slice(0,1))).not.toBe(hash);
  });
  it('validates restored preferences and limits metadata settings',()=>{
    const result=safeSettings({choices:500,settleTimeout:Infinity,settleAttempts:0,panel:'false'});
    expect(result.choices).toBe(4);expect(result.settleTimeout).toBe(180);expect(result.settleAttempts).toBe(1);expect(result.panel).toBe(true);
  });
});
